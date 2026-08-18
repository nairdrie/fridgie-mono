I verified every claim against `/Users/nick/Dev/fridgie-mono` before writing this. Corrections to the brief first, then the runbook.

---

# Fridgie — CI/CD Runbook & Spec

## Corrections (one line each)

- **Ground truth #1 is wrong.** `git remote -v` → `origin https://github.com/nairdrie/fridgie-mono.git`, branch is `main`, and the repo is **public** (`"private": false` from the GitHub API). Both reviewers caught this; step 1 is triage, not creation.
- **Ground truth #1 is wrong again:** local `main` is **1 commit ahead** of `origin/main` — `ac5f8d7 security(rtdb): stop /status being world-readable` is unpushed. Reviewer 1's count is right; the merged design's "9 behind, 0 ahead" is not.
- **The merged design's Risk #1 is fabricated.** `firebase.json` and `database.rules.json` both exist at the repo root and the RTDB rules deny-by-default. The *narrower* version is real and survives: no Firestore rules, no Storage rules, and nothing in CI deploys any of them.
- **Reviewer 2 is wrong that `createSessionCookie` is dead weight.** `AuthContext.tsx:105` calls `loginWithToken` on every sign-in. The *Firestore user-provisioning block* inside that route is commented out; the session-cookie call is live.
- **Reviewer 1's W1 (Bun `idleTimeout` doesn't reap WebSockets) is accepted** — that makes Risk #9 (billed-while-connected) worse, not better, which is why `--max-instances` is a real control.
- **Reviewer 2's S1 is the most important finding in either review and both the design and reviewer 1 missed it:** `apps/mobile/utils/api.ts:489` puts a live Firebase ID token in the WebSocket **URL query string**, which Cloud Run writes to Cloud Logging on every connect.
- **Everything else both reviewers found checks out** and is folded in below: `uuid` is a phantom dependency (present only via `firebase-admin`'s hoisted `uuid@11.1.0`), `$('body').html()` is uncapped into Sonnet 5, `MAX_IMAGE_BYTES = 12MB` × `concurrency` is an OOM, `run.developer` works fine at project scope, gcloud/docker/gh are all absent, the DNS facts are exact, and `api.fridgie.ca` is already dead (HTTP 000).

---

## 1. What the pipeline does once it is running

On every pull request, GitHub Actions typechecks and tests the Bun/Hono API, typechecks the Expo app and proves Metro can still bundle `packages/shared`, and builds the Docker image from the repo root — no cloud credentials are issued to PR runs at all. On a push to `main`, those same checks run, and if the API job is green a deploy job mints a short-lived GCP token via Workload Identity Federation (no service-account key exists anywhere), builds and pushes `us-central1-docker.pkg.dev/grocerease-5abbb/fridgie/api:<sha>`, asserts no service-account JSON leaked into the image, and deploys a **no-traffic** candidate revision to Cloud Run. It smoke-tests that candidate on its private tag URL — a deep health check that performs real RTDB and Firestore reads (proving Application Default Credentials work), an assertion that the reported `K_REVISION` is the one just built, and a check that `/api/ws/list/*` returns 401 rather than 404 (proving the WebSocket upgrade branch still fires ahead of Hono) — and only then shifts 100% of traffic to it, rolling back to the previously-serving revision if anything fails. In parallel and deliberately not gated on the API deploy, a second job queues an EAS `preview` build for both platforms and writes the install links into the run summary. Idle cost of the whole thing is **$0.00/month**.

---

## 2. The runbook

Every step is marked **BLOCKING** (must happen before the next phase works) or **LATER**. Money is marked inline. Assume gcloud, Docker, and `gh` are all absent — I checked.

### Phase 0 — Triage what already exists

**1. BLOCKING — There *is* a git remote, and the repo is public. Fix that first.**

Ground truth said no remote existed. It does:

```bash
cd /Users/nick/Dev/fridgie-mono
git remote -v          # origin https://github.com/nairdrie/fridgie-mono.git
git branch --show-current   # main
```

The repo is **public**. `apps/mobile/google-services.json` is tracked and `app.json` carries your Google OAuth `reservedClientId`. These are public-by-design Firebase/OAuth identifiers, not secrets — but public means an attacker reads them in a browser instead of unpacking your APK, and that is the delivery vector for the free-signup abuse in step 4.

Go to **github.com/nairdrie/fridgie-mono → Settings → General → Danger Zone → Change visibility → Make private**.

Consequence to note: private restores the 2,000-free-GitHub-Actions-minutes/month cap (public repos get unlimited). At your cadence you will use a few dozen minutes a month. **$0.**

**2. BLOCKING — Push the unpushed security commit.**

```bash
cd /Users/nick/Dev/fridgie-mono
git log --oneline origin/main..main
#   ac5f8d7 security(rtdb): stop /status being world-readable and world-writable
git push origin main
```

Do **not** run `git remote add origin ...` — it exists and the command errors out. Do **not** run `git merge --ff-only feat/claude-meal-suggestions` — `main` is ahead, not behind.

**3. BLOCKING — Fix the phantom `uuid` dependency (1 command).**

Four runtime route files import `uuid` (`api/group/index.ts:4`, `api/list/index.ts:4`, `api/meal/index.ts:3`, `api/list/categorize/[id].ts:4`) and it is **not** in `apps/api/package.json`. It resolves today only because `firebase-admin@13.5.0` hoists `uuid@11.1.0`. The day that changes, production breaks on a dependency bump with no code change.

```bash
cd /Users/nick/Dev/fridgie-mono/apps/api
bun add uuid
bun remove firebase        # the client SDK is dead after the firebase.ts rewrite in §3
```

`bun remove firebase` is safe **only after** you land the §3 code changes (they are the only three imports of `firebase/*` in the whole API — I grepped). It also meaningfully cuts cold-start time, which matters because you're scaling to zero. Commit both together.

**4. BLOCKING — $ — Set an Anthropic spend limit. Today. Before anything else cloud-related.**

This is the single largest uncapped cost in the system and it is not on GCP.

`middleware/requireAccount.ts` blocks exactly one thing: `c.get('isAnonymous')`. A non-anonymous Firebase account is self-service — anyone with your project's web API key (public, in `google-services.json`, extractable from any APK you ship) can call Identity Toolkit `accounts:signUp` and get one instantly. And there is **no rate limiting anywhere in the API**:

```
grep -rniE "rate.?limit|throttle|quota" apps/api --include="*.ts" → no matches
```

`api/recipe/import/index.ts:106-113` falls back to `$('body').html()` — the entire document, uncapped — into `claude-sonnet-5` at $3/$15 per MTok. A 400 KB ad-heavy recipe blog is ~114K input tokens ≈ **$0.34 per call**. One `curl` loop at ~30s round trips is **$30/hour**; twenty parallel connections is roughly **$14,000/day**. `--max-instances` does not cap this — the money is Anthropic's, not Google's.

Go to **console.anthropic.com → Settings → Limits → Workspace spend limit**. Set something you'd be annoyed but not ruined by — **$25/month** is a sane starting point for a family app. This is the only hard stop in the entire system; GCP budget alerts *email you*, they do not stop spending.

**5. BLOCKING — Check whether `ALGOLIA_READ_KEY` is actually a search-only key.**

`api/explore/search/index.ts:10` reads `ALGOLIA_READ_KEY` into a local named `algoliaAdminKey` with the comment `// Use ADMIN key on the backend`. The repo cannot decide what it is. Open the Algolia dashboard → API Keys. If the value in your `apps/api/.env` is the **Admin** key, rotate it now and replace it with a **search-only** key — it can delete your entire index and it has been sitting in an EC2-era `.env`.

---

### Phase 1 — GCP foundation

**6. BLOCKING — $ — Enable billing on `grocerease-5abbb`, then immediately set a budget.**

Cloud Run requires billing. The side effect matters more than the requirement: this flips Firebase from Spark to **Blaze**, so RTDB, Firestore and Storage stop being hard-capped and start billing on overage.

- Console → **Billing** → link a billing account to `grocerease-5abbb`.
- Console → **Billing → Budgets & alerts → Create budget** → scope: project `grocerease-5abbb`, amount **$10**, alert thresholds 50 / 90 / 100%, email → nick.airdrie@gmail.com.
- Firebase Console → **Usage and billing → Details & settings → Modify plan → Set budget alert** — this is a *separate* alert surface from the GCP one, and RTDB/Storage overage bills through it.

Both are smoke detectors, not circuit breakers.

**7. BLOCKING — Install and authenticate gcloud** (confirmed not installed):

```bash
brew install --cask google-cloud-sdk
exec -l $SHELL                       # reload PATH
gcloud auth login
gcloud config set project grocerease-5abbb
gcloud --version
```

**8. BLOCKING — Run the setup script.** One paste. It prompts for the two secret values rather than reading undefined shell variables (reviewer 1's B5 — the merged design piped `$ANTHROPIC_KEY` and `$ALGOLIA_READ`, which are defined nowhere and would have created empty secret versions that fail at deploy with a message about `latest` not being found).

```bash
set -euo pipefail

export PROJECT_ID=grocerease-5abbb
export REGION=us-central1
export GH_REPO=nairdrie/fridgie-mono          # exact, case-sensitive, verified
export RUNTIME_SA=fridgie-api-run@${PROJECT_ID}.iam.gserviceaccount.com
export DEPLOY_SA=github-deployer@${PROJECT_ID}.iam.gserviceaccount.com

gcloud config set project $PROJECT_ID

# ── APIs. cloudresourcemanager FIRST and BEFORE the describe below, because
#    `projects describe` needs it and a SERVICE_DISABLED there silently yields an
#    empty PROJECT_NUMBER that poisons the WIF binding at the bottom.
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  firebasedatabase.googleapis.com identitytoolkit.googleapis.com firestore.googleapis.com

echo "waiting 30s for API enablement to propagate…"; sleep 30

export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
[ -n "$PROJECT_NUMBER" ] || { echo "FATAL: could not read project number"; exit 1; }
echo "PROJECT_NUMBER=$PROJECT_NUMBER"

# ── Artifact Registry ────────────────────────────────────────────────────────
gcloud artifacts repositories create fridgie \
  --repository-format=docker --location=$REGION --description="Fridgie API images"

# ── Runtime service account: what the API runs AS ────────────────────────────
gcloud iam service-accounts create fridgie-api-run \
  --display-name="Fridgie API — Cloud Run runtime"
sleep 10   # SA creation is eventually consistent; binding immediately often 404s

for R in roles/firebasedatabase.admin roles/datastore.user roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${RUNTIME_SA}" --role="$R" --condition=None
done

# ── Secrets. printf, not echo — a trailing newline in an API key produces a
#    baffling 401. read -rs so the value never lands in shell history.
for S in anthropic-api-key algolia-read-key; do
  gcloud secrets create fridgie-$S --replication-policy=automatic
  gcloud secrets add-iam-policy-binding fridgie-$S \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
done

read -rsp "ANTHROPIC_API_KEY: " ANTHROPIC_KEY; echo
[ -n "$ANTHROPIC_KEY" ] || { echo "FATAL: empty"; exit 1; }
printf '%s' "$ANTHROPIC_KEY" | gcloud secrets versions add fridgie-anthropic-api-key --data-file=-

read -rsp "ALGOLIA_READ_KEY (search-only, see step 5): " ALGOLIA_READ; echo
[ -n "$ALGOLIA_READ" ] || { echo "FATAL: empty"; exit 1; }
printf '%s' "$ALGOLIA_READ" | gcloud secrets versions add fridgie-algolia-read-key --data-file=-
unset ANTHROPIC_KEY ALGOLIA_READ

# ── Deployer service account + Workload Identity Federation (no JSON key) ────
gcloud iam service-accounts create github-deployer --display-name="GitHub Actions deployer"
sleep 10

# run.developer, NOT run.admin. It omits run.services.setIamPolicy — the one
# permission that would let a compromised CI token make this (or any future)
# service publicly invokable, or grant itself standing access. It works fine at
# PROJECT scope, so there is no bootstrap problem.
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.developer --condition=None

gcloud artifacts repositories add-iam-policy-binding fridgie --location=$REGION \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/artifactregistry.writer

# Deploying a service that RUNS AS the runtime SA requires actAs on it.
# Scoped to that one SA — project-level would let CI impersonate anything.
gcloud iam service-accounts add-iam-policy-binding $RUNTIME_SA \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create github --location=global \
  --display-name="GitHub Actions"

# The attribute-condition is MANDATORY, not hardening: GitHub's OIDC issuer is
# shared by every repo on GitHub. Without it, any repo on the internet could
# mint tokens for this service account. gcloud now refuses to create the
# provider without one. Pinning ref to main means PR runs get zero GCP access.
gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='${GH_REPO}' && assertion.ref=='refs/heads/main'"

# principalSet MUST use the attribute.repository/<owner>/<repo> form.
# .../workloadIdentityPools/github/*            = every repo on Earth
# .../attribute.repository_owner/nairdrie       = every repo you own, incl. forks
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GH_REPO}"

echo
echo "=========================================================================="
echo "GitHub → Settings → Secrets and variables → Actions → VARIABLES tab:"
echo "  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-oidc"
echo "  GCP_DEPLOYER_SA  = ${DEPLOY_SA}"
echo "  ALGOLIA_APP_ID   = <your Algolia app id, from the Algolia dashboard>"
echo "=========================================================================="
```

**Why WIF and not a JSON key:** a service-account key is a private key valid for ~10 years that works from anywhere on Earth, must be rotated by hand forever, and is revoked only by deleting it and redeploying everything that used it. WIF mints a ≤1h audience-bound token. Both cost **$0**. After the ADC change in §3, **no Google private key exists anywhere in this system.**

**9. BLOCKING — Add the three repository *variables*** printed above (Settings → Secrets and variables → Actions → **Variables** tab, not Secrets — none of the three is secret). See §5 for the full table.

**10. BLOCKING — Bootstrap the Cloud Run service by hand with a placeholder image.**

Docker is not installed on this machine, so you cannot build the real image locally. You don't need to — deploy Google's public hello container just to bring the service into existence, then grant public invocation. CI takes over from there and never needs `setIamPolicy`.

```bash
gcloud run deploy fridgie-api \
  --project=grocerease-5abbb --region=us-central1 \
  --image=us-docker.pkg.dev/cloudrun/container/hello \
  --min-instances=0 --max-instances=1 --quiet

# Public invocation, granted ONCE, by you, not by CI. The app authenticates with
# Firebase ID tokens (middleware/auth.ts + the verifyIdToken + group-membership
# check at index.ts:54-67), not Google IAM — so allUsers is correct here.
gcloud run services add-iam-policy-binding fridgie-api \
  --region=us-central1 --member=allUsers --role=roles/run.invoker

# Assert it actually stuck. If an org policy (constraints/iam.allowedPolicyMemberDomains)
# blocks allUsers, `deploy --allow-unauthenticated` would have printed a WARNING
# and exited 0, leaving a created-but-unreachable service.
gcloud run services get-iam-policy fridgie-api --region=us-central1 --format=json \
  | jq -e '.bindings[]? | select(.role=="roles/run.invoker") | .members[] | select(.=="allUsers")' \
  && echo "OK: publicly invokable"
```

Also check the default compute SA isn't carrying `roles/editor` from an older project:

```bash
gcloud projects get-iam-policy grocerease-5abbb --flatten="bindings[].members" \
  --filter="bindings.members:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --format="value(bindings.role)"
```

**11. LATER (do it now, it's 30 seconds) — Artifact Registry cleanup policy.** Without it, storage grows one image per push forever.

```bash
cat > /tmp/cleanup.json <<'EOF'
[
  { "name": "keep-recent", "action": {"type": "Keep"},
    "mostRecentVersions": {"keepCount": 10} },
  { "name": "delete-untagged", "action": {"type": "Delete"},
    "condition": {"tagState": "UNTAGGED", "olderThan": "7d"} },
  { "name": "delete-ancient", "action": {"type": "Delete"},
    "condition": {"tagState": "ANY", "olderThan": "90d"} }
]
EOF
gcloud artifacts repositories set-cleanup-policies fridgie \
  --location=us-central1 --policy=/tmp/cleanup.json --dry-run
gcloud artifacts repositories set-cleanup-policies fridgie \
  --location=us-central1 --policy=/tmp/cleanup.json --no-dry-run
```

`Keep` beats `Delete`, so the 10 most recent survive the 90-day rule.

---

### Phase 2 — Land the code and the workflow

**12. BLOCKING — Apply every file in §3 on a branch, open a PR, confirm the PR checks go green, merge.**

The merge is the first real deploy. It builds the image, pushes it, deploys a no-traffic candidate, smoke-tests it, and promotes — replacing the hello container.

**13. BLOCKING — Verify on the `run.app` URL**, then do the one thing CI cannot (see §7 checklist items 5–7).

---

### Phase 3 — Domain

**14. BLOCKING — Verify `fridgie.ca` in Google Search Console** as a **Domain** property, signed in with the **same Google account that owns the GCP project**. It gives you a TXT record. `gcloud run domain-mappings create` refuses without it.

**15. BLOCKING — GoDaddy DNS.** I verified your live records:

```
nameservers      ns53.domaincontrol.com, ns54.domaincontrol.com   ← GoDaddy confirmed
api.fridgie.ca.  600  IN  A   35.182.135.90                       ← the dead EC2
fridgie.ca.            IN  A   76.223.105.230, 13.248.243.5
fridgie.ca.            IN  MX  10 inbound-smtp.ca-central-1.amazonaws.com
```

And `curl https://api.fridgie.ca/api/test` → **HTTP 000, unreachable**. The EC2 is already gone, so `api.fridgie.ca` is already broken — **there is no downtime to plan around.** Cut over whenever.

**Subdomain, not apex, and you already chose correctly.** All four `eas.json` profiles hardcode `https://api.fridgie.ca/api`, and `apps/mobile/utils/api.ts:22` falls back to the same. This is right for a hard reason: **a root/apex domain cannot take a CNAME** — DNS forbids it alongside the zone's SOA/NS records, and GoDaddy's UI rejects it. An apex mapping would need four A + four AAAA records, and your apex already points at AWS.

GoDaddy → **My Products → fridgie.ca → DNS → Manage DNS**:

| Action | Type | Name | Value | TTL |
|---|---|---|---|---|
| **Delete first** | A | `api` | `35.182.135.90` | — |
| Add | TXT | `@` | `google-site-verification=…` (from Search Console) | 600 |
| Add | CNAME | `api` | `ghs.googlehosted.com` | 600 |

GoDaddy specifics that trip people up:

- **Delete the A record before adding the CNAME.** GoDaddy rejects a CNAME colliding with an existing A record and the error doesn't say why.
- **Name is `api`, not `api.fridgie.ca`.** GoDaddy appends the zone; the FQDN produces `api.fridgie.ca.fridgie.ca`.
- **No trailing dot** on the CNAME value. GoDaddy adds it.
- **`@` for the apex TXT.** GoDaddy accepts `@` but rejects an empty Name field.
- **Minimum custom TTL is 600 seconds.** The default is 1 hour; set it down.
- **Check Domain Forwarding is off for `api`** — it silently injects its own records and fights the CNAME.
- **Do not touch the MX or apex A records.** Your mail is on AWS SES.

**16. BLOCKING — Create the mapping. Note: no `beta`.** Domain mappings are GA; `gcloud beta` on a fresh Homebrew install triggers an interactive component-install prompt for no reason.

```bash
gcloud run domain-mappings create \
  --service=fridgie-api --domain=api.fridgie.ca --region=us-central1

# Poll until the managed cert is issued — usually ~15 min, occasionally hours.
gcloud run domain-mappings describe --domain=api.fridgie.ca --region=us-central1
```

While you wait, the `*.a.run.app` URL works and serves valid TLS. **Cost: $0** — a domain mapping is free. A Global External Application Load Balancer would be ~**$18.25/month** standing, which is roughly your old EC2 bill, to serve an app that is otherwise free.

**17. BLOCKING — Test a real WebSocket through the custom domain.** Do not skip this. See §7 checklist item 9.

---

### Phase 4 — Mobile

**18. BLOCKING — Log in to EAS** (confirmed: currently "Not logged in"):

```bash
cd /Users/nick/Dev/fridgie-mono/apps/mobile
npx eas-cli login
npx eas-cli whoami      # record this username — it goes into app.json "owner"
```

**19. BLOCKING — Land the `app.json` and `eas.json` edits** from §3 and commit.

**20. BLOCKING — Register every iPhone that will install a build, before you build.**

```bash
cd /Users/nick/Dev/fridgie-mono/apps/mobile
npx eas-cli device:create
```

This emits a QR/URL; each device opens it once. **A device registered *after* a build cannot install that build** — Safari just says "Unable to install", there is no re-signing, only rebuilding. Cap is 100 devices per membership year.

**21. BLOCKING — First interactive iOS build.**

```bash
cd /Users/nick/Dev/fridgie-mono
make build-preview PLATFORM=ios
```

**Pass `PLATFORM` explicitly.** `Makefile:58` sets `PLATFORM ?= all` and `Makefile:173` passes `--platform $(PLATFORM)`; running it bare builds both platforms, which on the free tier's single concurrency slot queues them serially.

Answer the credential prompts. This is where EAS generates and stores your distribution certificate and ad-hoc provisioning profile. **`--non-interactive` cannot create credentials that don't exist yet** — CI would fail with "Credentials are not set up". It also registers the bundle ID `com.nairdrie.fridgie` with Apple if needed. Re-run this after any future `device:create` so the ad-hoc profile is regenerated.

**22. BLOCKING — First interactive Android build.**

```bash
make build-preview PLATFORM=android
```

Generates the upload keystore.

**23. BLOCKING — Fix Google Sign-In before that APK reaches a phone.**

`apps/mobile/.gitignore` documents, correctly, that `expo prebuild` reproduces `android/app/debug.keystore` byte-identically so the **debug** SHA-1 registered in Firebase stays stable. But `preview` builds are signed with the **EAS-generated release keystore**, whose SHA-1 is registered nowhere. `app.json` enables `@react-native-google-signin/google-signin` with a pinned `reservedClientId`. **So Google Sign-In will work perfectly in development and fail on the first real APK.**

```bash
cd apps/mobile && npx eas-cli credentials --platform android
# → production → Keystore → read off "SHA1 Fingerprint"
```

Firebase Console → Project settings → Your apps → `com.nairdrie.fridgie` → **Add fingerprint** → paste → **download the regenerated `google-services.json` and commit it** → rebuild.

**24. BLOCKING — Create `EXPO_TOKEN`** at expo.dev and add it as a GitHub repository **secret** (see §5). Then push to `main`; `build-mobile` runs and writes install links into the job summary.

### Inside your Apple Developer account — what to create in it

You have the membership (**$99/yr**, already paid — not a to-buy).

**Needed for Phase 4:** an App ID for `com.nairdrie.fridgie` with **Push Notifications** enabled — `expo-notifications` is a dependency and `api/notification/save-push-token.ts` stores tokens. EAS creates this during step 21 if your role allows.

**Needed only later, for TestFlight/App Store (§6 Tier 2):**
- An **App Store Connect app record** → gives you the 10-digit `ascAppId`.
- An **App Store Connect API Key** (Users and Access → Integrations → Team Keys → +). Use the **Admin** role if you want EAS to regenerate provisioning profiles non-interactively, which you do — App Manager can't. The `.p8` is downloadable **exactly once**.
- An **APNs Key** (Certificates, IDs & Profiles → Keys) — also one-time download. Without it, iOS push silently does nothing in production.

Upload all of these **to EAS** via `npx eas-cli credentials`, never to GitHub, then delete the `.p8` files from `~/Downloads`. That keeps `EXPO_TOKEN` as the only credential GitHub holds.

---

### Phase 5 — LATER, but real

**25. LATER — Commit and deploy Firestore + Storage rules.** `firebase.json` declares only `database`. The mobile client writes **directly** to Storage (`app/complete-profile.tsx:46` and `utils/api.ts:372`, both `uploadBytes`) and reads/writes RTDB `/status/{uid}` directly. Authorization for Storage is entirely rules-based, those rules exist only in the console, and nothing in CI deploys any of them — so the committed RTDB rules and production RTDB rules can silently diverge. Add `firestore` and `storage` blocks to `firebase.json`, commit the rules files, and add a `firebase deploy --only database,firestore:rules,storage` step.

**26. LATER — Move the WebSocket token out of the URL.** See §9 risk 1 — this one is genuinely important, and there's an interim one-liner below.

**27. LATER — `release.yml` for TestFlight/Play.** See §6 Tier 2.

---

## 3. Every file to add or change

### 3a. `apps/api/utils/firebase.ts` — replace entirely

Application Default Credentials on day one. I verified in your installed tree that this works: `firebase-admin@13.5.0` → `lib/app/credential-internal.js:27-33` declares `SCOPES = ['cloud-platform', 'firebase.database', 'firebase.messaging', 'identitytoolkit', 'userinfo.email']` and passes them to `google-auth-library`, whose Compute client forwards them to the metadata server. All three surfaces you use — RTDB, Firestore, `createSessionCookie` — are covered.

```ts
// firebase.ts
import admin from 'firebase-admin'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore } from 'firebase-admin/firestore'
import { existsSync, readFileSync } from 'fs'

const rtdbUrl = 'https://grocerease-5abbb-default-rtdb.firebaseio.com'
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'grocerease-5abbb'
const LOCAL_KEY = './utils/firebase-service-account.json'

// Credential resolution, most-explicit first:
//   1. FIREBASE_CREDENTIALS — inline service-account JSON. Escape hatch only;
//      the deployed pipeline never sets it.
//   2. utils/firebase-service-account.json — local file, if you keep one.
//   3. Application Default Credentials — what runs on Cloud Run. The attached
//      service account IS the credential: no private key exists in the image,
//      in Secret Manager, in GitHub, or on disk. Authorisation comes from the
//      three IAM roles on that account.
//
// The existsSync guard is not cosmetic: the old code called readFileSync
// unconditionally, which throws AT MODULE LOAD on a missing file — so without
// this guard the ADC branch below would be unreachable in the container.
function resolveCredential() {
  if (process.env.FIREBASE_CREDENTIALS) {
    return admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS))
  }
  if (existsSync(LOCAL_KEY)) {
    return admin.credential.cert(JSON.parse(readFileSync(LOCAL_KEY, 'utf8')))
  }
  return admin.credential.applicationDefault()
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveCredential(),
    databaseURL: rtdbUrl,
    // Explicit on purpose. Cloud Run does NOT inject GOOGLE_CLOUD_PROJECT the
    // way App Engine and Cloud Functions do, and verifyIdToken checks the
    // token's `aud` against this. Do not rely on discovery.
    projectId,
  })
}

export const adminRtdb = getDatabase(admin.app())
export const adminAuth = admin.auth()
export const fs = getFirestore('fridgie-db')
```

This deletes the dead client SDK. The old file built a Firebase *client* app with `apiKey: 'dummy'` and exported `clientRtdb`. I grepped: `clientRtdb`, `ref`, and `onValue` are imported by `index.ts:6-7` and **never used** — the WS handler calls `adminRtdb.ref(...)`, a method, not the import. It ran on every cold start and existed only to imply the server reads RTDB unauthenticated.

### 3b. `apps/api/index.ts` — three edits

```diff
-import { ref, onValue } from 'firebase/database'
-import { adminAuth, adminRtdb, clientRtdb } from './utils/firebase'
+import { adminAuth, adminRtdb } from './utils/firebase'
```

```diff
 serve({
+  // Cloud Run injects PORT=8080. Bun.serve already resolves process.env.PORT
+  // (verified: no PORT → 3000, PORT=8080 → 8080), so this is explicit rather
+  // than load-bearing. EXPOSE 3000 in the Dockerfile is decorative — Cloud Run
+  // ignores it. Bun binds all interfaces despite reporting hostname
+  // "localhost"; do NOT "fix" that by adding hostname: '0.0.0.0'.
+  port: Number(process.env.PORT ?? 3000),
   idleTimeout: 30,
```

```diff
   // Step 2: Bun-native WebSocket handlers
   websocket: {
+    // The top-level idleTimeout above governs HTTP requests, not upgraded
+    // sockets — a socket idle for 45s stays open. Set the WS timeout
+    // explicitly so a quiet list doesn't churn reconnects: every reconnect
+    // re-registers dbRef.on('value'), which fires a FULL snapshot immediately,
+    // so churn costs RTDB egress ($1/GB past 10GB/mo on Blaze) proportional to
+    // time-the-app-is-open — exactly the idle-shaped charge you left EC2 over.
+    idleTimeout: 960,   // Bun's maximum
     // onOpen: subscribe to Firebase
     open(ws: ServerWebSocket<...
```

### 3c. `apps/api/api/health/index.ts` — new file

The file router turns this into `/api/health`. I verified auth is per-route (`route.use('*', auth)` inside each file) and `index.ts:13` applies only `cors()` globally — so a route with no auth middleware is genuinely public. `/api/test` already exists unauthenticated and would work as a liveness check, but it cannot prove the *credential* works, which is the whole point on day one of ADC.

```ts
import { Hono } from 'hono'
import { adminRtdb, fs } from '@/utils/firebase'

const route = new Hono()

const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ])

route.get('/', async (c) => {
  const body: Record<string, unknown> = {
    ok: true,
    // Cloud Run injects K_REVISION. The deploy workflow asserts on it to prove
    // it is talking to the revision it just built, not a cached one.
    revision: process.env.K_REVISION ?? 'local',
    uptime: Math.round(process.uptime()),
  }

  // ?deep=1 exercises the two IAM surfaces that switching to ADC could break.
  // Deliberately OFF the default path so a transient Firebase blip cannot fail
  // a liveness probe — but the post-deploy smoke test always uses it.
  // Both read non-existent paths: cheap, no data, still requires valid creds.
  if (c.req.query('deep')) {
    try {
      await withTimeout(adminRtdb.ref('__health').once('value'), 5000, 'rtdb')
      body.rtdb = 'ok'
    } catch (err) {
      body.ok = false
      body.rtdb = String(err)
    }
    try {
      await withTimeout(fs.collection('__health').doc('probe').get(), 5000, 'firestore')
      body.firestore = 'ok'
    } catch (err) {
      body.ok = false
      body.firestore = String(err)
    }
  }

  return c.json(body, body.ok ? 200 : 503)
})

export default route
```

`createSessionCookie` (Identity Toolkit, `roles/firebaseauth.admin`) cannot be probed without a real ID token — that's manual checklist item 7 in §7.

### 3d. `apps/api/api/recipe/import/index.ts` — SSRF guard + input cap

Both reviewers flagged this; it is the single largest cost and security defect in the API. Replace the `else` branch's scraping block (currently lines ~97-121):

```ts
    } else {
      // --- WEBSITE SCRAPING ---
      // The URL comes straight from the request body. Without these guards it
      // is an SSRF primitive: arbitrary private/link-local addresses, and the
      // fetched content is summarised by Claude and returned to the caller,
      // which makes it a READ primitive for internal endpoints. (The GCE
      // metadata server needs a Metadata-Flavor header we never send, so the
      // runtime SA's ADC token is NOT reachable this way — but everything else
      // in the egress path is.)
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) {
        return c.json({ error: 'Only http(s) URLs are supported.' }, 400);
      }
      const PRIVATE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd)/i;
      const { address } = await dns.promises.lookup(u.hostname);
      if (PRIVATE.test(address) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(address)) {
        return c.json({ error: 'That host is not reachable.' }, 400);
      }

      console.log(`Scraping website URL: ${url}`);
      const { data: html } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
        // No caps at all previously. maxContentLength stops a 50MB page ever
        // entering the process; maxRedirects stops a redirect chain from
        // bypassing the private-IP check above (axios follows before we see it,
        // so 0 hops is the only fully safe value — 3 is the pragmatic middle).
        maxRedirects: 3,
        maxContentLength: 2_000_000,
        timeout: 10_000,
      });

      const $ = cheerio.load(html);
      const mainContentHtml =
        $('main').html() ||
        $('[role="main"]').html() ||
        $('article').html() ||
        $('#main-content').html() ||
        $('.recipe').html() ||
        $('body').html();

      if (!mainContentHtml || mainContentHtml.length < 100) {
        throw new Error('Could not extract sufficient HTML from the page.');
      }

      systemPrompt = htmlParsingSystemPrompt;
      // THE COST FIX. utils/claude.ts:30 documents that "20-80K tokens of page
      // markup dominate the bill here" and nothing acted on it. The $('body')
      // fallback above is the entire document, uncapped, into claude-sonnet-5
      // at $3/MTok input. 150KB ≈ 43K tokens ≈ $0.13 — far more than any recipe
      // needs, and it caps the worst case instead of leaving it unbounded.
      userInput = `Here is the HTML from the recipe page:\n\n${mainContentHtml.slice(0, 150_000)}`;
    }
```

Add at the top of the file, alongside the existing imports:

```ts
import dns from 'dns';
```

### 3e. `apps/api/api/recipe/import/photo.ts` — one line

```diff
-/** Generous enough for a high-quality page photo, small enough to reject abuse. */
-const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
+/** Generous for a page photo; small enough that concurrency × peak RSS fits in
+ *  the container. A 12MB image becomes a ~16MB base64 body, parsed into a
+ *  UTF-16 JS string (~32MB) plus a match[2] slice — ≥50MB peak per in-flight
+ *  request. A phone photo is 2-4MB; 12MB was a HEIC burst. See --concurrency
+ *  and --memory in the deploy command. */
+const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
```

### 3f. `apps/mobile/utils/api.ts` — the reconnect hole

Reviewer 1 found this and it is real. Every other early-exit path in `connect()` calls `scheduleReconnect()`; this one returns bare. If `currentUser` is null at connect time — app cold start, before Firebase auth rehydrates from storage — **the listener dies permanently** and live list sync is dead for that screen until remount. Scale-to-zero widens the window.

```diff
     const user = getAuth().currentUser;
     if (!user) {
       const authError = new Error("User is not authenticated.");
       console.error(authError);
       onError?.(authError);
-      return;
+      // Firebase auth rehydrates from storage asynchronously on cold start, so
+      // currentUser is legitimately null for a moment. Every other early exit
+      // in this function reschedules; without this, the listener dies for good.
+      scheduleReconnect();
+      return;
     }
```

### 3g. `.github/workflows/ci.yml` — complete replacement

Actions are pinned to full commit SHAs, resolved live. `deploy-api` carries `id-token: write`, which means any action in that job can mint a GCP token for `github-deployer`; tags are mutable, SHAs are not. Do this on the first commit, not "once it's working".

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  # Cancel redundant PR runs, but NEVER cancel a run on main — that could kill a
  # deploy between "promote traffic" and "verify".
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

# Nothing by default; each job opts in to exactly what it needs.
permissions: {}

jobs:
  api:
    name: api — typecheck & test
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: 1.3.14

      # packages/shared is source-only but declares its own dependency
      # (lexorank), and the API imports from it — so it has to be installed for
      # resolution to work.
      - name: Install shared
        working-directory: packages/shared
        run: npm ci --no-audit --no-fund

      - name: Install api
        working-directory: apps/api
        run: bun install --frozen-lockfile

      - name: Typecheck
        working-directory: apps/api
        run: bunx tsc --noEmit

      - name: Test
        working-directory: apps/api
        run: bun test

  mobile:
    name: mobile — typecheck & bundle
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: apps/mobile/package-lock.json

      - name: Install shared
        working-directory: packages/shared
        run: npm ci --no-audit --no-fund

      - name: Install mobile
        working-directory: apps/mobile
        run: npm ci --no-audit --no-fund

      - name: Typecheck
        working-directory: apps/mobile
        run: npx tsc --noEmit

      # Typechecking alone would not catch a broken Metro resolution of
      # packages/shared — apps/mobile/package.json does NOT depend on
      # @fridgie/shared; resolution is via tsconfig paths + metro watchFolders,
      # so the runtime shared modules only fail at bundle time.
      - name: Bundle
        working-directory: apps/mobile
        run: npx expo export --platform ios --output-dir .ci-bundle-check

  docker:
    name: api — docker build
    # PR-only: on main, deploy-api builds and pushes the same image, so building
    # it here too would just double the work.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      # Build context is the repo root, not apps/api — the image needs
      # packages/shared. Building from apps/api would fail.
      - name: Build image
        run: docker build -f apps/api/Dockerfile -t fridgie-api .

  deploy-api:
    name: api — deploy to Cloud Run
    needs: [api]
    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # ONLY this job may mint a GCP token
    env:
      PROJECT_ID: grocerease-5abbb
      REGION: us-central1
      SERVICE: fridgie-api
      RUNTIME_SA: fridgie-api-run@grocerease-5abbb.iam.gserviceaccount.com
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      # api/explore/search/index.ts:12-14 THROWS AT MODULE LOAD if either
      # Algolia var is missing, and index.ts:25 eagerly import()s every file
      # under api/**. So one empty var kills the whole service at boot — and an
      # unset `vars.*` interpolates to an empty string that gcloud accepts
      # silently. Cloud Run then reports "the container failed to start and
      # listen on the port defined by PORT", which points every troubleshooting
      # guide on the internet at PORT. PORT is not the problem. Assert first.
      - name: Assert required repository variables
        run: |
          [ -n "${{ vars.ALGOLIA_APP_ID }}" ] || { echo "::error::repository variable ALGOLIA_APP_ID is not set"; exit 1; }
          [ -n "${{ vars.GCP_WIF_PROVIDER }}" ] || { echo "::error::repository variable GCP_WIF_PROVIDER is not set"; exit 1; }
          [ -n "${{ vars.GCP_DEPLOYER_SA }}" ] || { echo "::error::repository variable GCP_DEPLOYER_SA is not set"; exit 1; }

      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3
        with:
          project_id: ${{ env.PROJECT_ID }}
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_DEPLOYER_SA }}

      - uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3

      - run: gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev --quiet

      - name: Build and push
        id: image
        run: |
          set -euo pipefail
          IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/fridgie/api:${GITHUB_SHA}"
          echo "ref=$IMAGE" >> "$GITHUB_OUTPUT"

          # Context is the REPO ROOT — apps/api imports from packages/shared.
          docker build -f apps/api/Dockerfile -t "$IMAGE" .

          # The Dockerfile copies apps/api/utils WHOLESALE. The only thing
          # keeping a service-account key out of the image is one line in the
          # ROOT .dockerignore (apps/api/.dockerignore is inert — the context is
          # the root). Assert rather than trust.
          if docker run --rm --entrypoint sh "$IMAGE" -c \
             'test -f /usr/src/app/apps/api/utils/firebase-service-account.json'; then
            echo "::error::service-account key leaked into the image"; exit 1
          fi

          docker push "$IMAGE"

      - name: Deploy no-traffic candidate
        id: deploy
        run: |
          set -euo pipefail
          IMAGE='${{ steps.image.outputs.ref }}'

          if ! gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
            echo "::error::service $SERVICE does not exist. Run the bootstrap deploy in runbook step 10 first."
            exit 1
          fi

          PREV=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format=json \
                  | jq -r '[.status.traffic[] | select(.percent==100)][0].revisionName // empty')
          echo "prev=$PREV" >> "$GITHUB_OUTPUT"
          echo "Currently serving: $PREV"

          # Full flag set on EVERY deploy: the workflow is the single source of
          # truth for service config, because `gcloud run deploy` patches and
          # inherits — a checked-in YAML would silently drift from reality.
          # Justification for each flag is in §4 of the runbook.
          # Do NOT add --use-http2 (breaks WebSocket upgrade) or
          # --no-cpu-throttling (forfeits the free tier).
          gcloud run deploy "$SERVICE" \
            --project="$PROJECT_ID" --region="$REGION" --image="$IMAGE" \
            --service-account="$RUNTIME_SA" \
            --min-instances=0 --max-instances=4 --concurrency=20 \
            --cpu=1 --memory=1Gi --timeout=3600 \
            --execution-environment=gen2 --cpu-boost --cpu-throttling \
            --set-env-vars="NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},ALGOLIA_APP_ID=${{ vars.ALGOLIA_APP_ID }}" \
            --set-secrets="ANTHROPIC_API_KEY=fridgie-anthropic-api-key:latest,ALGOLIA_READ_KEY=fridgie-algolia-read-key:latest" \
            --revision-suffix="${GITHUB_SHA::7}-${GITHUB_RUN_NUMBER}-${GITHUB_RUN_ATTEMPT}" \
            --no-traffic --tag=candidate --quiet

          NEW=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
                 --format='value(status.latestCreatedRevisionName)')
          URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format=json \
                 | jq -r '[.status.traffic[] | select(.tag=="candidate")][0].url')
          echo "revision=$NEW" >> "$GITHUB_OUTPUT"
          echo "url=$URL"      >> "$GITHUB_OUTPUT"
          echo "Candidate $NEW at $URL"

      - name: Smoke-test the candidate
        env:
          URL: ${{ steps.deploy.outputs.url }}
          REV: ${{ steps.deploy.outputs.revision }}
        run: |
          set -euo pipefail
          code=000
          for i in $(seq 1 10); do
            code=$(curl -sS -o /tmp/h -w '%{http_code}' --max-time 30 "$URL/api/health?deep=1" || echo 000)
            [ "$code" = 200 ] && break
            echo "attempt $i: HTTP $code"; sleep 5
          done
          [ "$code" = 200 ] || { echo "health failed:"; cat /tmp/h; exit 1; }

          # ?deep=1 did real RTDB and Firestore reads, so this proves the runtime
          # service account's Application Default Credentials actually work —
          # the one thing that cannot fail locally.
          jq -e '.rtdb == "ok" and .firestore == "ok"' /tmp/h

          # Prove we are talking to the revision we just built, not a cached one.
          jq -e --arg r "$REV" '.revision == $r' /tmp/h

          # The WS upgrade branch lives in Bun.serve's fetch(), AHEAD of Hono
          # (index.ts:46). With no token it must answer 401. A 404 means the
          # branch broke and everything is falling through to Hono — i.e. live
          # list sync is dead while every HTTP route looks perfectly healthy.
          ws=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$URL/api/ws/list/smoketest")
          [ "$ws" = 401 ] || { echo "WS upgrade path returned $ws, expected 401"; exit 1; }

      - name: Promote candidate to 100% traffic
        run: |
          gcloud run services update-traffic "$SERVICE" \
            --project="$PROJECT_ID" --region="$REGION" \
            --to-revisions="${{ steps.deploy.outputs.revision }}=100" --quiet

      - name: Roll back
        if: failure() && steps.deploy.outputs.prev != ''
        run: |
          echo "Deploy failed — restoring ${{ steps.deploy.outputs.prev }}"
          gcloud run services update-traffic "$SERVICE" \
            --project="$PROJECT_ID" --region="$REGION" \
            --to-revisions="${{ steps.deploy.outputs.prev }}=100" --quiet

  build-mobile:
    name: mobile — EAS preview build (installable)
    needs: [mobile]
    # Deliberately NOT `needs: deploy-api`. A slow EAS free-tier queue or an
    # exhausted build allowance must never block the API from going live, and a
    # failed API deploy must not block shipping a client that talks to the
    # already-deployed API over https://api.fridgie.ca/api.
    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read      # NEVER give this job id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: apps/mobile/package-lock.json

      - uses: expo/expo-github-action@eab7a230208c952974db8c3245cfd78402c7b385 # v9
        with:
          eas-version: 22.0.0
          token: ${{ secrets.EXPO_TOKEN }}
          packager: npm

      - name: Install shared
        working-directory: packages/shared
        run: npm ci --no-audit --no-fund

      # eas-cli evaluates app.json locally through @expo/config, which loads the
      # config plugins (expo-router, expo-build-properties, google-signin) from
      # node_modules. Without this, `eas build` fails resolving the config
      # before it ever contacts the EAS API.
      - name: Install mobile
        working-directory: apps/mobile
        run: npm ci --no-audit --no-fund

      # --profile preview: Android APK + iOS ad-hoc IPA, both installable
      # directly on hardware. `production` would emit an AAB, which cannot be
      # installed on any device at all. See §6.
      #
      # --no-wait returns as soon as the build is QUEUED. Free-tier queues run
      # 10-60+ minutes; waiting here would bill all of it to GitHub Actions.
      - name: Queue EAS build
        working-directory: apps/mobile
        run: |
          eas build --profile preview --platform all \
            --non-interactive --no-wait --json \
            --message "main@${GITHUB_SHA::7}" > builds.json
          cat builds.json

      - name: Install links → job summary
        working-directory: apps/mobile
        run: |
          {
            echo "## Install links"
            echo
            echo "Open on the device. **iOS must use Safari** (itms-services:// link)."
            echo "Android: allow \"install unknown apps\" for your browser."
            echo
            jq -r '.[] | "- **\(.platform)** — \(.buildDetailsPageUrl // ("https://expo.dev/builds/" + .id))"' builds.json
            echo
            echo "_Queued, not finished. A green check here means SUBMITTED, not BUILT._"
          } >> "$GITHUB_STEP_SUMMARY"
```

### 3h. `apps/mobile/eas.json` — complete replacement

Two additions: `autoIncrement` on `preview` and `production`.

```jsonc
{
  "cli": {
    "version": ">= 16.18.0",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.fridgie.ca/api"
      }
    },
    "development-simulator": {
      "extends": "development",
      "ios": {
        "simulator": true
      }
    },
    "preview": {
      "developmentClient": false,
      "distribution": "internal",
      "autoIncrement": true,
      "android": {
        "buildType": "apk"
      },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.fridgie.ca/api"
      }
    },
    "production": {
      "developmentClient": false,
      "autoIncrement": true,
      "android": {
        "buildType": "app-bundle"
      },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.fridgie.ca/api"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
```

**Why `autoIncrement` matters, and it's the most likely silent failure here.** Your `cli.appVersionSource` is `"remote"`, which moves `ios.buildNumber` / `android.versionCode` onto EAS's servers. It does **not** turn on auto-increment. Without it every build reuses the same build number, the first submit succeeds, and the second is rejected — App Store Connect: *"an attribute with a value that has already been used"*; Play: *"Version code 1 has already been used"*. The failure appears at submit time, long after the build looked fine. The counter is per app+platform and shared across profiles, so the sequence is globally monotonic and a preview can never collide with a TestFlight build. (`autoIncrement: "version"` is not available to you — it requires `appVersionSource: "local"`.) The marketing `"version": "1.0.0"` in `app.json` stays yours to bump by hand; an accidental auto-bump is worse than a forgotten one.

### 3i. `apps/mobile/app.json` — add `owner`

```diff
     "name": "fridgie",
     "slug": "fridgie",
+    "owner": "<your expo.dev username, verbatim from `npx eas-cli whoami`>",
     "version": "1.0.0",
```

Honestly: builds will *probably* work without it, because modern EAS CLI resolves from `extra.eas.projectId`, which you have. It matters if you use a robot token (no personal account context → `Could not determine account`), if the project ever moves into an org, or if a second person builds locally. One line, removes a class of confusing CI failure.

### 3j. `apps/api/Dockerfile` — no changes needed

I traced every `COPY` path against the real layout and they all exist. One subtlety worth writing down so nobody "fixes" it: the `release` stage copies `/temp/shared/node_modules` **before** `COPY --from=prerelease …/packages/shared`, and COPY merges into an existing directory, so `lexorank` survives. Fragile-looking, correct.

### 3k. `Makefile` — one line

Docker is not installed on this Mac. If you install Docker Desktop on an M-series Mac and run `make docker-build`, you get an **arm64** image and Cloud Run rejects it with `Container manifest type must support amd64/linux`.

```diff
 docker-build: ## Build the API image (context is the repo root, by design)
-	docker build -f $(API_DIR)/Dockerfile -t fridgie-api .
+	docker build --platform linux/amd64 -f $(API_DIR)/Dockerfile -t fridgie-api .
```

---

## 4. The Cloud Run service configuration, as one command

This is exactly what the workflow runs. Every flag justified inline.

```bash
gcloud run deploy fridgie-api \
  --project=grocerease-5abbb \
  --region=us-central1 \                    # Tier 1 pricing AND the only tier where the always-free allowance applies. Also where the RTDB lives: utils/firebase.ts:9 pins the bare firebaseio.com host, which is the LEGACY DEFAULT INSTANCE — it is in us-central1. Every WS upgrade does an adminRtdb.ref().once() (index.ts:64) and every socket holds a live listener; northamerica-northeast1 would add a cross-continent hop to all of it, cost 20-25% more per vCPU-second, and forfeit the free tier.
  --image=us-central1-docker.pkg.dev/grocerease-5abbb/fridgie/api:<sha> \
  --service-account=fridgie-api-run@grocerease-5abbb.iam.gserviceaccount.com \
  --min-instances=0 \                       # THE WHOLE POINT. You shut down an EC2 box over a standing charge; min-instances=1 recreates exactly that shape for ~$2.60-7.25/mo forever. It is not needed: I read apps/mobile/utils/api.ts:454-523 and the client already reconnects with exponential backoff and a FRESH getIdToken() per attempt, and index.ts:100 re-registers dbRef.on('value') which fires a full snapshot immediately — so a scale-to-zero shutdown or a revision rollout costs ~1 second of staleness with nothing to reconcile.
  --max-instances=4 \                       # A cost guardrail, not a capacity plan. 4 x 20 = 80 simultaneous connected apps, far past your scale. Its real job is capping blast radius if something loops or gets scraped — and it is the ONLY thing bounding cost from long-lived sockets, because Bun does not reap idle WebSockets and an open socket is an in-flight request for its whole life.
  --concurrency=20 \                        # Each WebSocket holds a slot for its entire life. The binding constraint is memory, not CPU: recipe/import/photo.ts buffers a base64 image via c.req.json() -> raw body + UTF-16 JS string + match[2] slice, ~5x the image size in peak RSS. At the 4MB cap from §3e that is ~21MB per in-flight photo import; 20 x 21MB + ~160MB baseline fits 1Gi with headroom. 80 (let alone 250) would OOM and take every socket on that instance down with it.
  --cpu=1 \                                 # Cold start matters BECAUSE you scale to zero, and index.ts:25 does a fast-glob plus a dynamic import() of all 28 route files at boot.
  --memory=1Gi \                            # See --concurrency. Costs ~$0.0954/instance-hour vs $0.0909 at 512Mi — under a nickel a month at your usage — and the memory free tier still allows 100 instance-hours vs CPU's 50, so CPU remains the binding free-tier constraint either way.
  --timeout=3600 \                          # The maximum, and the hard cap on one socket's life: no Cloud Run connection outlives it, so every WebSocket is severed at most 60 minutes in regardless of activity. Shortening it saves nothing (the client reconnects instantly; same wall-clock, more requests).
  --execution-environment=gen2 \            # Full syscall compatibility. Bun has had gVisor edge cases under gen1; "works locally, dies on Cloud Run" is not how you want to spend an evening.
  --cpu-boost \                             # Doubles CPU during startup only. ~1 extra vCPU-second per cold start — rounding error — and it directly attacks the only downside of scaling to zero.
  --cpu-throttling \                        # THE DEFAULT, stated explicitly so nobody "helpfully" flips it. An open WebSocket IS an in-flight request, so CPU stays allocated exactly while a client is connected and costs nothing when none is. --no-cpu-throttling would buy nothing and forfeit the free tier.
  --set-env-vars="NODE_ENV=production,GOOGLE_CLOUD_PROJECT=grocerease-5abbb,ALGOLIA_APP_ID=<id>" \
                                            # NODE_ENV is a SECURITY CONTROL, not config: api/authentication/index.ts:62 does `const isProd = process.env.NODE_ENV === 'production'` and passes it straight to the __session cookie's `secure` flag (lines 66, 82, 86). Forget it and you ship a session cookie without Secure. ALGOLIA_APP_ID is a public identifier, not a secret. GOOGLE_CLOUD_PROJECT is read by the new firebase.ts.
  --set-secrets="ANTHROPIC_API_KEY=fridgie-anthropic-api-key:latest,ALGOLIA_READ_KEY=fridgie-algolia-read-key:latest" \
                                            # Pinned to :latest deliberately. Cloud Run resolves secret references at INSTANCE START, so with scale-to-zero every cold start picks up the newest version — rotation is effectively instant with no redeploy. That is a genuine and unusual benefit of scaling to zero. Rotate with `versions add`, then `disable` (reversible) before `destroy` (not).
  --revision-suffix="<sha7>-<run>-<attempt>" \
  --no-traffic --tag=candidate \            # A broken build never serves a single user request. Traffic moves only after the smoke test passes.
  --quiet
```

**Flags deliberately NOT passed:**

- **`--use-http2`** — never. WebSocket upgrade needs HTTP/1.1 to the container. This one flag can silently kill live list sync while every HTTP route works perfectly.
- **`--session-affinity`** — looks relevant, isn't. A WebSocket is one request pinned to its instance by definition; all state (`ws.data`, the RTDB listener) is per-connection. Enabling it interferes with scale-down — it would cost money to solve a problem you don't have.
- **`--no-cpu-throttling`** — see above.
- **`--allow-unauthenticated`** — granted once by hand in runbook step 10, so CI never needs `run.services.setIamPolicy`.
- **A startup probe** — `firebase.ts` throws at import if credentials fail, so the process dies and never binds, and Cloud Run's default startup check fails the revision on its own.

### Runtime IAM — three roles, three distinct surfaces

| Role | Exactly why |
|---|---|
| `roles/firebasedatabase.admin` | `adminRtdb.ref('groups/…').once()` at `index.ts:64` and `.on('value')` at `index.ts:100`, plus `groupAuth`/`groupOwnerAuth`. There is no narrower RTDB data-plane role — this is the floor, not a choice. It bypasses your security rules entirely; the compensating control is that it's scoped to a service account only Cloud Run can assume, and that account **has no key**. |
| `roles/datastore.user` | `getFirestore('fridgie-db')`. Note this is broader than "the named database" — it also covers `(default)` and any database created later. An IAM condition on `resource.name.endsWith("/databases/fridgie-db")` can tighten it, but condition support on Firestore data-plane calls is uneven and a silently-denied read is worse than a broad grant. **LATER**, and only with testing. |
| `roles/firebaseauth.admin` | `adminAuth.createSessionCookie` at `api/authentication/index.ts:57`, which is live (`AuthContext.tsx:105`). Note `verifyIdToken` needs **no** credential at all — it validates offline against Google's public certs. **LATER tightening:** this role also permits deleting every user in the project. A custom role with just `identitytoolkit.sessionCookies.create` is the correct long-term answer: `gcloud iam roles create fridgieSessionCookies --project=grocerease-5abbb --permissions=identitytoolkit.sessionCookies.create --stage=GA`. |

Deliberately **not** granted: `roles/editor`, `roles/firebase.admin` (can rewrite your security rules), any Storage role (`getStorage()` appears only in `scripts/`, which the Dockerfile never copies), `roles/iam.serviceAccountTokenCreator` (needed only for `createCustomToken` / signed URLs — you call neither).

### The bill

| Line item | Monthly |
|---|---|
| **Cloud Run, idle (nobody using the app)** | **$0.00** |
| Cloud Run, light real use (~1h/day of app-open time) | **$0.00** — inside free tier |
| Cloud Run, ~2h/day | **~$0.95** |
| Artifact Registry (10 images sharing the `oven/bun:1` base layer, cleanup on) | $0.00–0.10 |
| Secret Manager (2 versions; 6 free) | $0.00 |
| Custom domain mapping | $0.00 |
| Cloud Logging (50 GiB free) | $0.00 |
| GitHub Actions (private repo, 2,000 free min/mo; you'll use ~30) | $0.00 |
| EAS builds (free tier; ~4–8/month against the allowance) | $0.00 |
| RTDB egress (Blaze, $1/GB past 10 GB free) | $0.00–2.00 |
| **Anthropic API — normal family use (~30 imports + 60 suggestions/mo)** | **$8–15** |
| **Total** | **~$9–18/month, of which GCP is under $1** |

Model: `us-central1` Tier 1, 1 vCPU + 1 GiB, request-billed. An instance-hour is `3600 × (0.000024 + 1 × 0.0000025)` = **$0.0954**. The free tier's 180,000 vCPU-seconds binds first, at **50 free instance-hours/month** (~1.6 h/day).

**`min-instances=1` would cost ~$2.60–7.25/month, forever, to buy about one second.** (Sources disagree on whether Cloud Run bills idle CPU at the reduced rate or not at all; the honest figure is the range, not the top of it.) Either way it is the same *shape* of charge you escaped, and the WebSocket analysis says it buys nothing.

**Cost traps that would recreate your problem:** a Global External ALB (~$18.25/mo standing — use the free domain mapping); a Serverless VPC connector (~$9/mo — you need none, Firebase/Anthropic/Algolia are all public internet); `northamerica-northeast1` (Tier 2 pricing, and the always-free tier does not apply there); no Artifact Registry cleanup policy; and **the Anthropic bill**, which is larger than every GCP line combined and is capped only by the spend limit you set in runbook step 4.

---

## 5. GitHub repository secrets and variables

**Settings → Secrets and variables → Actions.**

### Variables tab (not secret — do not put these in Secrets)

| Name | Value | Where it comes from |
|---|---|---|
| `GCP_WIF_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github-oidc` | Printed by the setup script in runbook step 8. `<PROJECT_NUMBER>` is the numeric ID from `gcloud projects describe grocerease-5abbb --format='value(projectNumber)'` — **not** the string `grocerease-5abbb`. |
| `GCP_DEPLOYER_SA` | `github-deployer@grocerease-5abbb.iam.gserviceaccount.com` | Printed by the same script. |
| `ALGOLIA_APP_ID` | e.g. `A1B2C3D4E5` | Algolia dashboard → Settings → API Keys → **Application ID**. Public identifier. **The deploy job asserts this is non-empty** — an unset variable interpolates to `ALGOLIA_APP_ID=` which gcloud accepts, and the container then dies at module load with a Cloud Run error that blames PORT. |

### Secrets tab

| Name | Value | Where it comes from |
|---|---|---|
| `EXPO_TOKEN` | `<token>` | expo.dev → account settings → **Access tokens** → Create. Prefer a **Robot user** with the Developer role if your tier exposes it (Account → Robots); revoking a robot token doesn't disturb your own session or touch billing. Otherwise a personal access token. |

**Say the `EXPO_TOKEN` downside plainly:** EAS has no OIDC federation, so this is the one credential GitHub must hold. A *personal* access token is account-wide and cannot be scoped to a project or role — anything holding it can build, submit, and **overwrite stored signing credentials** for every project on your account. It is contained by being a repo-level secret: GitHub never passes repo secrets to PRs from forks, and `build-mobile` only runs on `main`, so the exposure surface is your own main branch.

### Not GitHub secrets — deliberately

| Value | Lives where | Why not GitHub |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret Manager → `fridgie-anthropic-api-key` | Injected by Cloud Run at instance start; CI never sees it. |
| `ALGOLIA_READ_KEY` | Secret Manager → `fridgie-algolia-read-key` | Same. |
| Any GCP service-account key | **Nowhere. None exists.** | WIF for CI, ADC in the container. |
| `FIREBASE_CREDENTIALS` | **Nowhere.** | Eliminated by the ADC change in §3a. |
| `OPENAI_API_KEY`, `FIREBASE_STORAGE_BUCKET`, `ALGOLIA_WRITE_KEY`, `DRY_RUN` | Your local `apps/api/.env` only | I traced these: they are read **only** by files under `apps/api/scripts/`, and the Dockerfile never copies `scripts/` into the image. The deployed service cannot read them by construction — including the Algolia **write** key, the dangerous one. |
| App Store Connect API key (`.p8`), APNs key (`.p8`), Android keystore | EAS servers, via `npx eas-cli credentials` | Never in git, never in GitHub. Delete the `.p8` from `~/Downloads` after upload — Apple lets you download each exactly once. |

---

## 6. Mobile release strategy

### The tension in your request, head on

You asked for "an expo production build so we can get the real app installed on real android and ios devices". **The `production` profile in your `eas.json` cannot do that on either platform.**

| Profile | Android artifact | Installable on a device? | iOS artifact | Installable on a device? |
|---|---|---|---|---|
| `production` (`buildType: "app-bundle"`, no `distribution` → defaults to `store`) | `.aab` | **No.** An App Bundle is a Play *publishing* format. `adb install` rejects it with `INSTALL_FAILED_INVALID_APK`. Play consumes it to generate per-device APKs. | App Store-signed `.ipa` | **No.** Distribution-signed, no device allowlist, no `get-task-allow`. Reaches a phone only via TestFlight. |
| **`preview`** (`buildType: "apk"`, `distribution: "internal"`) | **`.apk`** | **Yes.** Scan the QR on the EAS build page, install. | **ad-hoc `.ipa`** | **Yes** — on devices whose UDID was registered *before* the build. |
| `development` | APK (dev client) | Boots to a "no bundler" screen without Metro on your LAN — a shell, not the real app. | ad-hoc (dev client) | Same. |
| `development-simulator` | — | — | simulator `.app` | **No.** Simulator slice; won't run on hardware. |

**`preview` is what you actually want, and your `eas.json` already configures it correctly** — `developmentClient: false`, `distribution: "internal"`, `android.buildType: "apk"`, and the same `https://api.fridgie.ca/api` as production. It is a production-configured build that installs directly.

### Tier 1 — what runs on push to `main` (this is the answer to your request)

`build-mobile` in `ci.yml` queues `eas build --profile preview --platform all --no-wait`.

- **Android → APK.** Open the build page link from the job summary on the phone, tap Install. You must allow "install unknown apps" for your browser once. Works on any Android device, no registration, no store.
- **iOS → ad-hoc IPA.** Open the build page link **in Safari** on the iPhone (the install is an `itms-services://` link Chrome won't handle). Only devices registered via `eas device:create` *before the build* can install it. **Register first** — a device registered after cannot install that build, Safari just says "Unable to install", and the only fix is rebuilding.

**Push cadence.** You said pushes to `main` are rare — "occasionally, for major updates". At that cadence a build on every push is 2–8/month, comfortably inside the free tier, and I deliberately did **not** add `paths:` filters: a mobile build that *silently doesn't run* is the worse 1am failure, and the waste you'd be avoiding is a couple of builds a month. `workflow_dispatch` is in the workflow instead, which is the real ergonomic win. **If that cadence ever changes** — say 4 pushes a week, ~32 builds/month — you will exhaust the free allowance mid-month; at that point add a `paths: ['apps/mobile/**', 'packages/shared/**']` filter, or switch the mobile job to tag-triggered, before you consider paying.

### Tier 2 — what runs on a tag (LATER, defer until you actually want a store)

`production` + `eas submit` → TestFlight/Play is the **only** route for an App Store-signed build on hardware. It's genuinely worth having, but as a tag trigger you run when shipping, not on every push. Prerequisites: the App Store Connect app record and API key from the Apple section of the runbook; for Android, the **$25 one-time Google Play developer fee** plus **one manual AAB upload** (Play refuses API uploads to a track that has never had a manual release).

Fill `submit.production` in `eas.json` with **identifiers only** — `ios.ascAppId`, `ios.appleTeamId`, `android.track: "internal"`. **Never** `serviceAccountKeyPath` (it points at a repo file — that's how these keys get committed) and never `appleId` (it pushes EAS toward the app-specific-password flow, which triggers 2FA and hangs CI).

`.github/workflows/release.yml`:

```yaml
name: Store release

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions: {}

concurrency:
  group: store-release
  cancel-in-progress: false

jobs:
  release:
    name: EAS production build + submit
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: apps/mobile/package-lock.json
      - uses: expo/expo-github-action@eab7a230208c952974db8c3245cfd78402c7b385 # v9
        with:
          eas-version: 22.0.0
          token: ${{ secrets.EXPO_TOKEN }}
          packager: npm
      - run: npm ci --no-audit --no-fund
        working-directory: packages/shared
      - run: npm ci --no-audit --no-fund
        working-directory: apps/mobile
      # --auto-submit hands the artifact to eas submit SERVER-SIDE, so this job
      # waits for neither the build nor the store upload.
      # Output is an AAB + an App Store IPA. NEITHER can be sideloaded — iOS
      # reaches a device only via TestFlight, Android only via Play.
      - run: |
          eas build --profile production --platform all \
            --auto-submit --non-interactive --no-wait \
            --message "${GITHUB_REF_NAME}"
        working-directory: apps/mobile
```

### Tier 3 — what you run by hand

| Command | When |
|---|---|
| `make build-preview PLATFORM=ios` | First time (creates credentials — `--non-interactive` **cannot** create credentials that don't exist, CI fails with "Credentials are not set up"). Re-run after any `eas device:create` so the ad-hoc profile is regenerated. |
| `make build-preview PLATFORM=android` | First time (creates the upload keystore). |
| `npx eas-cli device:create` | Every new iPhone, **before** the build it needs to install. |
| `npx eas-cli credentials --platform android` | To read the release-keystore SHA-1 for the Google Sign-In fix. |
| `make build-dev PLATFORM=ios` | Day-to-day dev-client builds. |
| `make build-list` | Check whether a queued build actually finished. |

### EAS free tier — the numbers and what happens at the limit

- **15 Android + 15 iOS builds/month, 1 concurrency** (per expo.dev/pricing at time of writing — verify, pricing changes). At your stated cadence you'll use under a third; budget 2 extra for the interactive credential-bootstrap builds in runbook steps 21–22.
- **`--platform all` queues the second platform behind the first** on one concurrency slot. `--no-wait` means the GitHub job exits in ~2 minutes regardless, so this affects wall-clock-to-installable-artifact, not GitHub minutes.
- Shared free queue: waits commonly **10–60 minutes**, longer at peak.
- **When the allowance is exhausted:** `eas build` exits non-zero *immediately* with a plan-limit message. The job goes red fast. Nothing silently skips, and **nothing auto-charges** — the free tier has no card on file. The next tier is **Starter at $19/month**.

### Monorepo specifics

- **EAS must upload the whole repo, and it does.** `apps/mobile/package.json` does **not** depend on `@fridgie/shared` — resolution is via `tsconfig.json` paths (`"@fridgie/shared/*": ["../../packages/shared/*"]`) plus `metro.config.js` watchFolders, and `apps/mobile/utils/rank.ts` and `utils/quantity.ts` import from it. EAS detects the git root and archives from there. Verify on the first build.
- **Do not add an `.easignore`.** There isn't one today, so EAS archives via git and your gitignored `apps/api/.env` is already excluded (confirmed: `git check-ignore -v apps/api/.env` → `apps/api/.gitignore:19`). Adding one **replaces** `.gitignore` for the upload — one forgotten line ships a secret, or drops `packages/shared` and breaks the bundle. Zero action is the correct action.
- **`ios/` and `android/` are gitignored**, so EAS runs `expo prebuild` in the cloud. `ci.yml` never exercises prebuild, so **the first EAS build is the first real test of it**. Most likely failure point: the `expo-build-properties` `useFrameworks: "static"` setting that Google Sign-In needs.
- **`google-services.json` is tracked**, so no secret-file injection in CI. `EXPO_TOKEN` is the only mobile secret.
- **No OTA escape hatch.** `expo-updates` is **not** installed (I checked — only the transitive `expo-updates-interface` stub from `expo-dev-launcher`). Every JS-only fix needs a full native build through the free-tier queue. If cadence increases, `expo-updates` with `runtimeVersion: {"policy": "fingerprint"}` is the answer — but it's a native module, so it needs a rebuild on every device before it does anything, and **cannot be adopted reactively in an emergency.**

---

## 7. First-run verification checklist

In order. Do not skip 9.

1. **PR checks are green.** Open a PR with the §3 changes. `api`, `mobile`, and `docker` jobs pass. Locally I confirmed the gate itself is green: `bun test` → 41 pass / 0 fail; `bunx tsc --noEmit` → exit 0.

2. **Merge to `main`; the deploy job goes green.** Watch for the `Assert required repository variables` step first — if `ALGOLIA_APP_ID` is unset it fails there in 2 seconds with a clear message instead of 6 minutes later with a message about PORT.

3. **The promoted revision is the one you built.**
   ```bash
   gcloud run services describe fridgie-api --region us-central1 \
     --format='value(status.traffic[0].revisionName,status.url)'
   ```

4. **Health is deep-green on the public URL.**
   ```bash
   URL=$(gcloud run services describe fridgie-api --region us-central1 --format='value(status.url)')
   curl -s "$URL/api/health?deep=1" | jq
   # {"ok":true,"revision":"fridgie-api-…","uptime":3,"rtdb":"ok","firestore":"ok"}
   ```
   `rtdb: ok` and `firestore: ok` are the proof that **Application Default Credentials work** — the one thing that cannot be verified locally.

5. **The WS upgrade branch is alive.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/ws/list/x"   # must be 401
   ```
   A **404** means the branch broke and everything falls through to Hono — live list sync would be dead while every HTTP route looked perfect.

6. **`allUsers` binding survived.**
   ```bash
   gcloud run services get-iam-policy fridgie-api --region us-central1 --format=json \
     | jq -e '.bindings[]? | select(.role=="roles/run.invoker") | .members[] | select(.=="allUsers")'
   ```

7. **Log in from the app pointed at the `run.app` URL.** This exercises `createSessionCookie` → Identity Toolkit → `roles/firebaseauth.admin`. It is the **third ADC surface and the only one the smoke test cannot cover**, because it needs a real ID token. Temporarily set `EXPO_PUBLIC_API_URL` in a dev-client build, or just hit `POST $URL/api/authentication/login` with a token from the app.

8. **No token in the request logs — and if there is, mitigate.**
   ```bash
   gcloud logging read \
     'resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/api/ws/list/"' \
     --limit=3 --format='value(httpRequest.requestUrl)'
   ```
   If you see `?groupId=…&token=eyJ…`, that is a **live Firebase ID token persisted to Cloud Logging for 30 days**, readable by any principal with `roles/logging.viewer` or `roles/viewer`. Interim mitigation, one command, while you fix the client (§9 risk 1):
   ```bash
   gcloud logging sinks update _Default \
     --log-filter='NOT (resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/api/ws/list/")'
   ```

9. **After the domain mapping: test a real WebSocket through `https://api.fridgie.ca`.** Do not skip; do not assume. The mapping routes through a different Google Frontend path than the `run.app` URL. If WS fails there, every HTTP route still works and *only* live list sync is silently dead — the worst possible thing to discover after shipping builds. Edit a list on one device, watch it update on another.
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.fridgie.ca/api/ws/list/x   # 401
   curl -s https://api.fridgie.ca/api/health | jq
   ```

10. **First EAS build finishes.** `make build-list`, or open the build page. A green GitHub check means **submitted**, not **built**.

11. **Install and sign in with Google on a real Android device.** This is the specific thing that will fail if you skipped the release-keystore SHA-1 fix (runbook step 23) — and it fails *only* on the release build, never in development.

12. **Watch a cold start.** Open the app after ~20 minutes of no traffic. The first request should take a couple of seconds. That is the cost of $0.00 idle, and you said you'd take it.

13. **Check the WS reconnect churn number.** After a day, compare Cloud Run request count against how long you actually had the app open. If it looks like ~2 requests/min per connected client, the `websocket.idleTimeout` fix in §3b didn't take — that would multiply RTDB egress (each reconnect re-downloads the full list) on a per-minute-connected basis.

---

## 8. Rollback

### Bad API deploy

**In most cases the pipeline has already handled it.** The candidate deploys with `--no-traffic`, so a bad build never serves a single user request; if the smoke test fails, the `Roll back` step just re-asserts what was already serving. It only does real work in the narrow window where promote succeeded and something later failed. Side benefit: by promotion time the candidate instance is already warm from the smoke test, so cutover has no cold start.

**Manual, for 11pm:**

```bash
gcloud run revisions list --service fridgie-api --region us-central1
gcloud run services update-traffic fridgie-api --region us-central1 \
  --to-revisions fridgie-api-<suffix>=100
```

Seconds, no rebuild, no Docker, no CI run. This is the capability a VM doesn't give you. Revision suffixes are `<sha7>-<runNumber>-<attempt>`, so you can map a revision straight back to a commit.

**If the *code* was fine but a secret rotation broke it:** re-enable the old secret version rather than redeploying. Because secrets are pinned to `:latest` and resolved at instance start, the next cold start picks it up with no deploy at all.

```bash
gcloud secrets versions enable <N> --secret=fridgie-anthropic-api-key
```

Always `disable` (reversible) before `destroy` (not).

### Bad mobile release

There is **no OTA rollback** — `expo-updates` is not installed. Options, in order of speed:

1. **Internal (`preview`) builds:** just send people the previous build's link. EAS keeps every build page, and an installed APK/IPA can be replaced by installing the older one over it. Nothing to revoke.
2. **TestFlight:** App Store Connect → TestFlight → the bad build → **Expire**. Testers can reinstall the previous build immediately.
3. **Play internal track:** Play Console → Testing → Internal testing → **Create new release** promoting the *previous* AAB. Play has no "un-publish this release" for a track; you roll forward to the old artifact. This is why `autoIncrement` matters — you need a fresh version code even to re-ship old code.
4. **Ultimate fallback:** revert the commit on `main` and let the pipeline build a new `preview`. That is a 10–60 minute free-tier queue, which is why steps 1–3 exist.

**One thing that cannot be rolled back:** `EXPO_PUBLIC_API_URL` is string-inlined into the JS bundle at build time. If you ship a build pointing at the wrong API host, the only fix is a rebuild. This is exactly why the domain must resolve *before* Phase 4 in the runbook.

---

## 9. What will probably go wrong the first time

Ordered by likelihood × pain.

1. **The WebSocket token is in the URL and lands in Cloud Logging.** `apps/mobile/utils/api.ts:489` builds `${wsUrl}/ws/list/${id}?groupId=${groupId}&token=${idToken}` and `index.ts:47` reads it back from `searchParams`. Cloud Run writes a request log entry with the full URL by default — no configuration, no opt-in. That persists a **live, one-hour, full-impersonation Firebase ID token** for 30 days per connect. With socket churn, one phone on the list screen can log thousands per day. **This is strictly worse on Cloud Run than on the EC2 box you left**, where request logging was whatever nginx was told to do. Mitigate today with the log-exclusion sink in §7 item 8; fix properly by moving the token to an `Authorization` header (React Native's `WebSocket` takes a third options argument with headers on iOS and Android; `req.headers` is available in Bun's `fetch` handler before `server.upgrade`), or by minting a single-use 30-second ticket from an authenticated HTTP call. Test on both platforms before deleting the query-param fallback — RN's header support is native-only, and if it silently fails, live sync dies.

2. **The Anthropic bill, not the GCP bill.** Everything in this document gets GCP to a genuine $0.00 idle. Then one free signup plus a `curl` loop against `POST /api/recipe/import` is ~$30/hour. `requireAccount` is not a cost boundary — a non-anonymous Firebase account is self-service and there is no rate limiting anywhere in the API. The truncation and `maxContentLength` fixes in §3d cap the *per-call* cost; only the workspace spend limit caps the *total*. Set it before the first deploy. A per-`uid` hourly rate limiter on the four AI routes is ~15 lines against RTDB, which you already have — do it in the first week.

3. **The Cloud Run "container failed to start and listen on the port defined by PORT" error, where PORT is not the problem.** `api/explore/search/index.ts:12-14` throws at module load if either Algolia var is missing, and `index.ts:25` eagerly `import()`s all 28 route files. One empty variable and the process dies before `serve()` ever runs. Reviewer 1 reproduced this exactly. The workflow now asserts the variable before deploying, but if you ever set a secret with `echo` instead of `printf` (trailing newline) or rotate a secret badly, this is the failure you'll see and the error message will send you hunting the wrong thing.

4. **The first EAS build is the first ever test of `expo prebuild`.** `ios/` and `android/` are gitignored and `ci.yml` never runs prebuild, so a plugin problem — most likely the `expo-build-properties` `useFrameworks: "static"` that Google Sign-In needs — surfaces 20 minutes into a queued cloud build. Runbook step 21 makes you do this interactively first, precisely so you find out on your own machine.

5. **Google Sign-In works perfectly in dev and fails on the first real APK.** The debug keystore SHA-1 is registered in Firebase and reproducible; the EAS release keystore's is registered nowhere. Runbook step 23. You *will* hit this if you skip it, and the symptom (sign-in silently returns an error code on release builds only) looks nothing like the cause.

6. **The domain mapping works for HTTP and silently breaks WebSockets.** Different Google Frontend path than `run.app`. Every HTTP route would look perfect while live list sync is dead. If it happens, the fallback is a ~$18.25/month load balancer — a 60× increase on your idle bill — which is a decision you want to make before promising the feature, not after. Checklist item 9.

7. **A green `build-mobile` means SUBMITTED, not BUILT.** `--no-wait` is correct for cost (it keeps a 50-minute EAS queue off GitHub's clock), but a failed EAS build never turns the GitHub run red. Check the build page or wire EAS webhooks.

8. **Long-lived sockets are billed as in-flight requests for up to an hour.** Reviewer 1 disproved the theory that Bun's `idleTimeout: 30` reaps them — a socket idle for 45s stayed open. So a tablet left on the list screen overnight holds a billable instance until `--timeout=3600` severs it, at ~$0.095/hour against your 50 free instance-hours. `--max-instances=4` is the only thing bounding it. Mobile backgrounding usually kills the socket in practice; watch the request-count metric for a week.

9. **Firestore and Storage have no rules in this repo.** `firebase.json` declares only `database`, and the mobile client writes directly to Storage (`app/complete-profile.tsx:46`, `utils/api.ts:372`). Nothing in CI deploys any rules, so the committed RTDB rules and production RTDB rules can silently diverge too. This is upstream of everything in this document — no amount of Cloud Run IAM changes what a client can do straight to Firebase.

10. **`--allow-unauthenticated` assumes no org policy.** If `grocerease-5abbb` ever ends up under an organization with `constraints/iam.allowedPolicyMemberDomains`, the `allUsers` binding is refused — and `gcloud run deploy --allow-unauthenticated` reports that as a *warning* and exits 0. Runbook step 10 asserts the binding explicitly for exactly this reason.

11. **The ADC scope conclusion rests on two pinned internal implementation details** — `firebase-admin@13.5.0`'s `SCOPES` array in `lib/app/credential-internal.js` and `google-auth-library`'s Compute client forwarding them. Neither is a public API contract. Pin `firebase-admin` tighter than `^13.4.0`, and re-check the `?deep=1` smoke result after any major bump. If it ever breaks, the fallback chain is intact: set `FIREBASE_CREDENTIALS` and you're unblocked with no code change.

12. **Two remaining client-side defects I found but did not fix here.** `attempt` resets only inside `ws.onopen`, and nothing forces a reconnect when the app foregrounds — `ListContext.tsx:47-53`'s `AppState` handler covers only the HTTP `getLists` fetch and never touches the socket, so a phone that slept can sit **up to 30 seconds stale** after unlock. And `app/(tabs)/list.tsx:167-200` awaits `listenToList` inside an async `setupListener()` while cleanup does `if (unsubscribe) unsubscribe()` — unmount before the await resolves leaks the socket. Neither changes the scale-to-zero call; both are worth a follow-up.