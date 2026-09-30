#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HELPER="$REPO_ROOT/scripts/check-service-usage.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fridgie-service-usage-test.XXXXXX")
MOCK_BIN="$TEST_ROOT/bin"
mkdir -p "$MOCK_BIN"

cleanup() {
  if [ -n "${TEST_ROOT:-}" ] && [ -d "$TEST_ROOT" ]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

fail_test() {
  echo "FAIL: $1" >&2
  exit 1
}

cat > "$MOCK_BIN/gcloud" <<'MOCK_GCLOUD'
#!/usr/bin/env bash
set -euo pipefail
: "${MOCK_LOG:?}"
printf 'gcloud' >> "$MOCK_LOG"
printf ' %s' "$@" >> "$MOCK_LOG"
printf '\n' >> "$MOCK_LOG"

if [ "$#" -ne 2 ] || [ "$1" != auth ] || [ "$2" != print-access-token ]; then
  echo "unexpected gcloud invocation: $*" >&2
  exit 64
fi

case "${MOCK_GCLOUD_MODE:-token}" in
  token) printf '%s\n' 'test-access-token' ;;
  empty) exit 0 ;;
  fail) echo 'mock token acquisition failed' >&2; exit 1 ;;
  *) echo "unknown MOCK_GCLOUD_MODE: $MOCK_GCLOUD_MODE" >&2; exit 65 ;;
esac
MOCK_GCLOUD

cat > "$MOCK_BIN/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail
: "${MOCK_LOG:?}"

output=''
write_out=''
connect_timeout=''
max_time=''
method=''
auth_header=''
quota_header=''
url=''
saw_silent=0
saw_show_error=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --silent)
      [ "$saw_silent" -eq 0 ] || { echo 'duplicate --silent' >&2; exit 64; }
      saw_silent=1
      shift
      ;;
    --show-error)
      [ "$saw_show_error" -eq 0 ] || { echo 'duplicate --show-error' >&2; exit 64; }
      saw_show_error=1
      shift
      ;;
    --output)
      [ -z "$output" ] && [ "$#" -ge 2 ] || { echo 'invalid --output' >&2; exit 64; }
      output="$2"
      shift 2
      ;;
    --write-out)
      [ -z "$write_out" ] && [ "$#" -ge 2 ] || { echo 'invalid --write-out' >&2; exit 64; }
      write_out="$2"
      shift 2
      ;;
    --connect-timeout)
      [ -z "$connect_timeout" ] && [ "$#" -ge 2 ] || { echo 'invalid --connect-timeout' >&2; exit 64; }
      connect_timeout="$2"
      shift 2
      ;;
    --max-time)
      [ -z "$max_time" ] && [ "$#" -ge 2 ] || { echo 'invalid --max-time' >&2; exit 64; }
      max_time="$2"
      shift 2
      ;;
    --request)
      [ -z "$method" ] && [ "$#" -ge 2 ] || { echo 'invalid --request' >&2; exit 64; }
      method="$2"
      shift 2
      ;;
    --header)
      [ "$#" -ge 2 ] || { echo 'missing --header value' >&2; exit 64; }
      case "$2" in
        'Authorization: Bearer '*)
          [ -z "$auth_header" ] || { echo 'duplicate Authorization header' >&2; exit 64; }
          auth_header="$2"
          ;;
        'x-goog-user-project: '*)
          [ -z "$quota_header" ] || { echo 'duplicate quota-project header' >&2; exit 64; }
          quota_header="$2"
          ;;
        *) echo "unexpected header: $2" >&2; exit 64 ;;
      esac
      shift 2
      ;;
    http://*|https://*)
      [ -z "$url" ] || { echo 'multiple URLs' >&2; exit 64; }
      url="$1"
      shift
      ;;
    *)
      echo "unexpected curl argument: $1" >&2
      exit 64
      ;;
  esac
done

[ "$saw_silent" -eq 1 ] || { echo 'missing --silent' >&2; exit 64; }
[ "$saw_show_error" -eq 1 ] || { echo 'missing --show-error' >&2; exit 64; }
[ -n "$output" ] || { echo 'missing --output' >&2; exit 64; }
[ "$write_out" = '%{http_code}' ] || { echo 'unexpected --write-out' >&2; exit 64; }
[ "$connect_timeout" = 10 ] || { echo 'unexpected connect timeout' >&2; exit 64; }
[ "$max_time" = 30 ] || { echo 'unexpected max time' >&2; exit 64; }
[ "$method" = GET ] || { echo 'unexpected HTTP method' >&2; exit 64; }
[ "$auth_header" = 'Authorization: Bearer test-access-token' ] \
  || { echo 'unexpected Authorization header' >&2; exit 64; }
[ "$quota_header" = 'x-goog-user-project: test-project' ] \
  || { echo 'unexpected quota-project header' >&2; exit 64; }

case "$url" in
  https://serviceusage.googleapis.com/v1/projects/test-project/services/firestore.googleapis.com|\
  https://serviceusage.googleapis.com/v1/projects/test-project/services/firebaserules.googleapis.com)
    ;;
  *) echo "unexpected Service Usage URL: $url" >&2; exit 64 ;;
esac

printf 'curl %s\n' "$url" >> "$MOCK_LOG"

case "${MOCK_CURL_SCENARIO:-success}" in
  success)
    printf '%s\n' '{"name":"projects/test-project/services/example.googleapis.com","state":"ENABLED"}' > "$output"
    printf '200'
    ;;
  permission_denied)
    printf '%s\n' '{"error":{"code":403,"message":"denied","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"IAM_PERMISSION_DENIED","domain":"iam.googleapis.com"}]}}' > "$output"
    printf '403'
    ;;
  target_disabled)
    printf '%s\n' '{"name":"projects/test-project/services/example.googleapis.com","state":"DISABLED"}' > "$output"
    printf '200'
    ;;
  serviceusage_disabled)
    printf '%s\n' '{"error":{"code":403,"message":"Service Usage API disabled","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SERVICE_DISABLED","domain":"googleapis.com","metadata":{"service":"serviceusage.googleapis.com"}}]}}' > "$output"
    printf '403'
    ;;
  unauthenticated)
    printf '%s\n' '{"error":{"code":401,"message":"bad token","status":"UNAUTHENTICATED"}}' > "$output"
    printf '401'
    ;;
  insufficient_scope)
    printf '%s\n' '{"error":{"code":403,"message":"bad scope","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT","domain":"googleapis.com"}]}}' > "$output"
    printf '403'
    ;;
  malformed_success)
    printf '%s\n' '{not-json' > "$output"
    printf '200'
    ;;
  missing_state)
    printf '%s\n' '{"name":"projects/test-project/services/example.googleapis.com"}' > "$output"
    printf '200'
    ;;
  unexpected_state)
    printf '%s\n' '{"name":"projects/test-project/services/example.googleapis.com","state":"STATE_UNSPECIFIED"}' > "$output"
    printf '200'
    ;;
  malformed_error)
    printf '%s\n' '<html>proxy failure</html>' > "$output"
    printf '403'
    ;;
  transient)
    printf '%s\n' '{"error":{"code":503,"message":"try later","status":"UNAVAILABLE"}}' > "$output"
    printf '503'
    ;;
  forbidden_not_permission)
    printf '%s\n' '{"error":{"code":403,"message":"wrong precondition","status":"FAILED_PRECONDITION"}}' > "$output"
    printf '403'
    ;;
  network_failure)
    : > "$output"
    echo 'mock network failure' >&2
    printf '000'
    exit 7
    ;;
  *) echo "unknown MOCK_CURL_SCENARIO: $MOCK_CURL_SCENARIO" >&2; exit 65 ;;
esac
MOCK_CURL

chmod +x "$MOCK_BIN/gcloud" "$MOCK_BIN/curl"

run_helper() {
  local scenario="$1"
  local gcloud_mode="${2:-token}"
  local output_file="$TEST_ROOT/output"
  : > "$MOCK_LOG"

  set +e
  PATH="$MOCK_BIN:$PATH" \
    PROJECT_ID=test-project \
    DEPLOYER_SA=github-deployer@test-project.iam.gserviceaccount.com \
    RUNNER_TEMP="$TEST_ROOT" \
    MOCK_LOG="$MOCK_LOG" \
    MOCK_GCLOUD_MODE="$gcloud_mode" \
    MOCK_CURL_SCENARIO="$scenario" \
    bash "$HELPER" firestore.googleapis.com firebaserules.googleapis.com \
    > "$output_file" 2>&1
  RUN_STATUS=$?
  set -e
  RUN_OUTPUT=$(<"$output_file")
}

assert_success() {
  [ "$RUN_STATUS" -eq 0 ] || fail_test "expected success, got $RUN_STATUS: $RUN_OUTPUT"
}

assert_failure() {
  [ "$RUN_STATUS" -ne 0 ] || fail_test "expected failure, got success: $RUN_OUTPUT"
}

assert_contains() {
  [[ "$RUN_OUTPUT" == *"$1"* ]] || fail_test "expected output to contain '$1': $RUN_OUTPUT"
}

assert_not_contains() {
  [[ "$RUN_OUTPUT" != *"$1"* ]] || fail_test "did not expect output to contain '$1': $RUN_OUTPUT"
}

MOCK_LOG="$TEST_ROOT/mock.log"
export MOCK_LOG

# The fake is intentionally strict: it must fail the unsupported command that
# caused the real CI incident instead of making an arbitrary gcloud call pass.
if PATH="$MOCK_BIN:$PATH" MOCK_GCLOUD_MODE=token \
    gcloud services describe firestore.googleapis.com >/dev/null 2>&1; then
  fail_test 'strict gcloud fake accepted an unsupported command'
fi

run_helper success
assert_success
[ "$(grep -c '^gcloud auth print-access-token$' "$MOCK_LOG")" -eq 1 ] \
  || fail_test 'helper did not use exactly one supported gcloud token command'
[ "$(grep -c '^curl https://serviceusage.googleapis.com/' "$MOCK_LOG")" -eq 2 ] \
  || fail_test 'helper did not check both Firebase APIs through Service Usage v1'

run_helper permission_denied
assert_failure
assert_contains 'serviceusage.services.get and serviceusage.services.use'

run_helper target_disabled
assert_failure
assert_contains 'must be enabled by a project owner'
assert_not_contains 'deploy-support role'

run_helper serviceusage_disabled
assert_failure
assert_contains 'serviceusage.googleapis.com must be enabled by a project owner'
assert_not_contains 'deploy-support role'

run_helper unauthenticated
assert_failure
assert_contains 'authentication failed'
assert_not_contains 'deploy-support role'

run_helper insufficient_scope
assert_failure
assert_contains 'authentication failed'
assert_not_contains 'deploy-support role'

run_helper malformed_success
assert_failure
assert_contains 'malformed or incomplete success response'
assert_not_contains 'deploy-support role'

run_helper missing_state
assert_failure
assert_contains 'malformed or incomplete success response'
assert_not_contains 'deploy-support role'

run_helper unexpected_state
assert_failure
assert_contains 'unexpected service state'
assert_not_contains 'deploy-support role'

run_helper malformed_error
assert_failure
assert_contains 'HTTP 403 and a malformed error response'
assert_not_contains 'deploy-support role'

run_helper transient
assert_failure
assert_contains 'HTTP 503 (UNAVAILABLE)'
assert_not_contains 'deploy-support role'

run_helper forbidden_not_permission
assert_failure
assert_contains 'HTTP 403 (FAILED_PRECONDITION)'
assert_not_contains 'deploy-support role'

run_helper network_failure
assert_failure
assert_contains 'could not reach the Service Usage API'
assert_not_contains 'deploy-support role'

run_helper success fail
assert_failure
assert_contains 'could not obtain a Google access token'
assert_not_contains 'deploy-support role'

run_helper success empty
assert_failure
assert_contains 'returned an empty token'
assert_not_contains 'deploy-support role'

echo 'Service Usage preflight tests passed'
