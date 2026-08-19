#!/usr/bin/env bash
#
# One-time Google Cloud setup for the Fridgie API.
#
# Run in Cloud Shell (gcloud preinstalled and already authenticated) or in a
# local terminal after `brew install --cask google-cloud-sdk && gcloud auth login`.
#
#   bash scripts/gcp-bootstrap.sh
#
# SAFE TO RE-RUN. Every create checks first, so a failure halfway through can be
# fixed and the script run again — it will skip what already exists rather than
# aborting on "already exists", which is what a bare `set -e` script does.
set -euo pipefail

PROJECT_ID=grocerease-5abbb
REGION=us-central1
GH_REPO=nairdrie/fridgie-mono          # exact, case-sensitive
SERVICE=fridgie-api
RUNTIME_SA="fridgie-api-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
skip() { printf '  already exists — skipping\n'; }

gcloud config set project "$PROJECT_ID" >/dev/null

step "Enabling APIs (~1 min)"
# cloudresourcemanager must come first: `projects describe` below needs it, and a
# disabled API there yields an EMPTY project number, which silently produces a
# broken Workload Identity binding at the end.
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  firebasedatabase.googleapis.com identitytoolkit.googleapis.com firestore.googleapis.com

sleep 20  # enablement is eventually consistent

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
[ -n "$PROJECT_NUMBER" ] || { echo "FATAL: could not read project number"; exit 1; }
echo "  project number: $PROJECT_NUMBER"

step "Artifact Registry"
if gcloud artifacts repositories describe fridgie --location="$REGION" >/dev/null 2>&1; then skip; else
  gcloud artifacts repositories create fridgie \
    --repository-format=docker --location="$REGION" --description="Fridgie API images"
fi

step "Runtime service account (what the API runs AS)"
if gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then skip; else
  gcloud iam service-accounts create fridgie-api-run --display-name="Fridgie API — Cloud Run runtime"
  sleep 10   # SA creation is eventually consistent; binding immediately often 404s
fi
# Bindings are idempotent, so these are safe to repeat.
for R in roles/firebasedatabase.admin roles/datastore.user roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role="$R" --condition=None >/dev/null
done
echo "  granted: rtdb admin, firestore user, auth admin"

step "Anthropic API key secret"
if gcloud secrets describe fridgie-anthropic-api-key >/dev/null 2>&1; then skip; else
  gcloud secrets create fridgie-anthropic-api-key --replication-policy=automatic
fi
gcloud secrets add-iam-policy-binding fridgie-anthropic-api-key \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null

if gcloud secrets versions list fridgie-anthropic-api-key --filter="state:ENABLED" --format='value(name)' | grep -q .; then
  echo "  a value is already stored — leaving it alone"
else
  # printf, not echo: a trailing newline in an API key produces a baffling 401.
  # read -rs so the value never reaches shell history.
  read -rsp "  paste ANTHROPIC_API_KEY: " KEY; echo
  [ -n "$KEY" ] || { echo "FATAL: empty"; exit 1; }
  printf '%s' "$KEY" | gcloud secrets versions add fridgie-anthropic-api-key --data-file=-
  unset KEY
fi

step "Deployer service account (what GitHub Actions acts as)"
if gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1; then skip; else
  gcloud iam service-accounts create github-deployer --display-name="GitHub Actions deployer"
  sleep 10
fi
# run.developer, NOT run.admin — it omits run.services.setIamPolicy, the one
# permission that would let a stolen CI token make any service publicly
# invokable or grant itself standing access.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.developer --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding fridgie --location="$REGION" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/artifactregistry.writer >/dev/null
# Deploying a service that RUNS AS the runtime SA requires actAs on it. Scoped to
# that one account — at project level CI could impersonate anything.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser >/dev/null
echo "  granted: run.developer, artifactregistry.writer, actAs runtime SA"

step "Workload Identity Federation (no JSON key is ever created)"
if gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1; then skip; else
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
fi
if gcloud iam workload-identity-pools providers describe github-oidc \
     --location=global --workload-identity-pool=github >/dev/null 2>&1; then skip; else
  # The attribute-condition is MANDATORY, not hardening. GitHub's OIDC issuer is
  # shared by every repository on GitHub, so without it ANY repo could mint
  # tokens for this service account. Pinning ref to main also means pull-request
  # runs get zero access to GCP.
  gcloud iam workload-identity-pools providers create-oidc github-oidc \
    --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GH_REPO}' && assertion.ref=='refs/heads/main'"
fi
# principalSet must use the attribute.repository/<owner>/<repo> form.
#   .../workloadIdentityPools/github/*        = every repo on Earth
#   .../attribute.repository_owner/nairdrie   = every repo you own, forks included
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GH_REPO}" >/dev/null

step "Bootstrapping the Cloud Run service"
# CI refuses to create the service from scratch, deliberately — a misconfigured
# first run must not invent a service with the wrong settings. Google's public
# hello image brings it into existence; the first real deploy replaces it.
if gcloud run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1; then skip; else
  # --no-allow-unauthenticated explicitly: without it gcloud prompts, and with
  # --quiet it would silently pick a default. Public access is granted as its
  # own binding immediately below, so it is deliberate rather than incidental.
  gcloud run deploy "$SERVICE" --region="$REGION" \
    --image=us-docker.pkg.dev/cloudrun/container/hello \
    --no-allow-unauthenticated \
    --min-instances=0 --max-instances=1 --quiet
fi
# Public invocation, granted ONCE, by you, never by CI. The app authenticates
# with Firebase ID tokens, not Google IAM, so allUsers is correct here.
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" --member=allUsers --role=roles/run.invoker >/dev/null
if gcloud run services get-iam-policy "$SERVICE" --region="$REGION" --format='value(bindings.members)' | grep -q allUsers; then
  echo "  publicly invokable: OK"
else
  echo "  WARNING: allUsers binding did not stick — an org policy may be blocking it"
fi

step "Artifact Registry cleanup policy"
cat > /tmp/fridgie-cleanup.json <<'JSON'
[
  { "name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 10} },
  { "name": "delete-untagged", "action": {"type": "Delete"}, "condition": {"tagState": "UNTAGGED", "olderThan": "7d"} },
  { "name": "delete-ancient", "action": {"type": "Delete"}, "condition": {"tagState": "ANY", "olderThan": "90d"} }
]
JSON
gcloud artifacts repositories set-cleanup-policies fridgie \
  --location="$REGION" --policy=/tmp/fridgie-cleanup.json --quiet >/dev/null
echo "  without this, storage grows by one image per push forever"

SERVICE_URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')

cat <<EOF

==========================================================================
DONE. Now add these in GitHub:
  Settings → Secrets and variables → Actions

VARIABLES tab:
  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-oidc
  GCP_DEPLOYER_SA  = ${DEPLOY_SA}

SECRETS tab:
  EXPO_TOKEN       = expo.dev → Account Settings → Access Tokens

Service URL (hello container until the first real deploy):
  ${SERVICE_URL}
==========================================================================
EOF
