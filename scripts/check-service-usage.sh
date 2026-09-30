#!/usr/bin/env bash
# Verify the Firebase APIs needed for Rules deployment without broadening the
# deployer's Service Usage role. There is no `gcloud services describe`
# command; use the documented Service Usage v1 services.get REST method.
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

[ -n "${PROJECT_ID:-}" ] || fail "PROJECT_ID is required for the Service Usage preflight"
[ -n "${DEPLOYER_SA:-}" ] || fail "DEPLOYER_SA is required for the Service Usage preflight"
[ "$#" -gt 0 ] || fail "at least one service API is required for the Service Usage preflight"

for required_tool in gcloud curl jq; do
  command -v "$required_tool" >/dev/null 2>&1 \
    || fail "$required_tool is required for the Service Usage preflight"
done

if ! access_token=$(gcloud auth print-access-token); then
  fail "could not obtain a Google access token for the Service Usage preflight; check Workload Identity and gcloud authentication"
fi
[ -n "$access_token" ] \
  || fail "gcloud auth print-access-token returned an empty token for the Service Usage preflight"
[[ "$access_token" != *$'\n'* && "$access_token" != *$'\r'* ]] \
  || fail "gcloud auth print-access-token returned an invalid token for the Service Usage preflight"

temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
response_file=$(mktemp "${temp_root%/}/fridgie-service-usage.XXXXXX") \
  || fail "could not create a temporary response file for the Service Usage preflight"
trap 'rm -f -- "$response_file"' EXIT

for service_api in "$@"; do
  [[ "$service_api" =~ ^[a-z0-9][a-z0-9.-]*\.googleapis\.com$ ]] \
    || fail "invalid service API name in deployment configuration: $service_api"

  service_url="https://serviceusage.googleapis.com/v1/projects/${PROJECT_ID}/services/${service_api}"
  if ! http_code=$(curl \
    --silent \
    --show-error \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --connect-timeout 10 \
    --max-time 30 \
    --request GET \
    --header "Authorization: Bearer ${access_token}" \
    --header "x-goog-user-project: ${PROJECT_ID}" \
    "$service_url"); then
    fail "could not reach the Service Usage API while checking $service_api; check runner networking and retry"
  fi

  [[ "$http_code" =~ ^[0-9]{3}$ ]] \
    || fail "Service Usage returned an invalid HTTP status while checking $service_api"

  if [ "$http_code" = 200 ]; then
    if ! state=$(jq -er '
      if type == "object" and (.state | type == "string")
      then .state
      else empty
      end
    ' "$response_file" 2>/dev/null); then
      fail "Service Usage returned a malformed or incomplete success response while checking $service_api"
    fi

    case "$state" in
      ENABLED)
        ;;
      DISABLED)
        fail "$service_api must be enabled by a project owner before CI deploys Firestore rules"
        ;;
      *)
        fail "Service Usage returned an unexpected service state while checking $service_api; retry before deploying Firestore rules"
        ;;
    esac
    continue
  fi

  if ! jq -e 'type == "object" and (.error | type == "object")' \
      "$response_file" >/dev/null 2>&1; then
    fail "Service Usage check for $service_api failed with HTTP $http_code and a malformed error response"
  fi

  api_status=$(jq -r '.error.status // "UNKNOWN"' "$response_file")
  [[ "$api_status" =~ ^[A-Z][A-Z0-9_]*$ ]] || api_status=UNKNOWN
  error_reason=$(jq -r '
    first(
      .error.details[]?
      | select(."@type" == "type.googleapis.com/google.rpc.ErrorInfo")
      | .reason
    ) // "UNKNOWN"
  ' "$response_file")
  [[ "$error_reason" =~ ^[A-Z][A-Z0-9_]*$ ]] || error_reason=UNKNOWN

  if [ "$api_status" = PERMISSION_DENIED ] && [ "$error_reason" = SERVICE_DISABLED ]; then
    fail "serviceusage.googleapis.com must be enabled by a project owner before CI can inspect Firebase API state"
  fi

  if [ "$http_code" = 401 ] \
      || [ "$api_status" = UNAUTHENTICATED ] \
      || [ "$error_reason" = ACCESS_TOKEN_SCOPE_INSUFFICIENT ]; then
    fail "Service Usage authentication failed while checking $service_api; check Workload Identity and the gcloud access token"
  fi

  if [ "$http_code" = 403 ] && [ "$api_status" = PERMISSION_DENIED ]; then
    fail "$DEPLOYER_SA needs the documented Firebase Rules deploy-support role (serviceusage.services.get and serviceusage.services.use)"
  fi

  fail "Service Usage check for $service_api failed with HTTP $http_code ($api_status); this is not classified as a Firebase Rules IAM-role failure"
done
