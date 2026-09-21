# Discover publishing

Discover reads a stored edition. A private Cloud Run Job writes original AI recipes, stages complete drafts, and atomically publishes a new edition. Feed requests never generate content. This job runs separately from the API service and uses the same container image.

## Runtime configuration

Project: `grocerease-5abbb`. Region: `us-central1`. Firestore database: `fridgie-db`.

Deployed on 2026-09-21 (UTC):

- API revision `fridgie-api-discover-e91227f` serves 100% traffic and passed live RTDB/Firestore readiness plus HTTP-import/WebSocket authentication guards.
- Cloud Run Job: `fridgie-discover-publish`; runtime: `fridgie-discover-run@grocerease-5abbb.iam.gserviceaccount.com`.
- Worker image: `us-central1-docker.pkg.dev/grocerease-5abbb/fridgie/api@sha256:58331dfdf223c08f5af5bfee309de8eb8f5f1fc427ce54469cf8836c14a0d122`.
- Bootstrap execution `fridgie-discover-publish-6wmts` succeeded. Edition `bootstrap-v1` published at `2026-09-21T00:57:06.573Z`, with 12 complete recipes and three cookbook entries per curator. A read-only production audit passed all 12 image checks, ownership/provenance checks, and exact profile/cookbook/follower counts.
- Scheduler `fridgie-discover-refresh` is enabled. It checks every 15 minutes using `fridgie-discover-scheduler@grocerease-5abbb.iam.gserviceaccount.com`, granted invoker on this job only. Its first authenticated delivery returned HTTP 200 at `2026-09-21T01:03:37Z`. Execution `fridgie-discover-publish-97vk8` succeeded and published edition `2026-09-21-0` at `01:05:00Z`, adding two recipes. The rotated edition passed a second production audit: all 14 recipes/images, ownership, cookbook counts and curator relationship counts are valid. The next content window is `2026-09-21T08:30:00Z`; intervening ticks are no-ops.
- Deployed named-database client rules were verified as `allow read, write: if false`; Admin/job access uses IAM.
- Verification: 373 API tests pass, two local ffmpeg tests skip, TypeScript passes. The worker exits deterministically after success/failure and replaces per-slot attempt maps across UTC rollover; retained drafts survive retries.

The workflow in `.github/workflows/ci.yml` deploys on **push to `main`**. It builds and verifies the API candidate, promotes it, then updates this job to the same image. The image-only update preserves the worker command, identity, secrets, environment and timeouts. It does not execute the worker; Cloud Scheduler owns execution. The GitHub deployer has project-level `roles/run.developer` and `roles/iam.serviceAccountUser` on the publisher runtime identity. Existing failure recovery rolls back API traffic only; inspect the worker image after an ambiguous deployment failure. The workflow changes are local until committed and pushed.

| Setting | Value |
| --- | --- |
| Container command | `bun` |
| Container arguments | `run,jobs/discovery.ts` |
| Working directory | `/usr/src/app/apps/api` (already in the image) |
| Tasks / parallelism | `1` / `1` |
| Task timeout | `1800s` |
| Automatic task retries | `0` |
| Scheduler | Every 15 minutes, `*/15 * * * *`, time zone `Etc/UTC` |
| `GOOGLE_CLOUD_PROJECT` | `grocerease-5abbb` |
| `FIREBASE_STORAGE_BUCKET` | `grocerease-5abbb.firebasestorage.app` |
| `DISCOVERY_IMAGE_MODEL` | `gpt-image-2` (default); optional pinned snapshot `gpt-image-2-2026-04-21` |
| `ANTHROPIC_API_KEY` | Bind Secret Manager `fridgie-anthropic-api-key:latest` |
| `OPENAI_API_KEY` | Bind existing Secret Manager `OPENAI_API_KEY:latest` |

Use secret references only; never put key values in source, image layers, commands, mobile configuration or logs. This job does not need the Supadata secret. If OpenAI is unavailable or its key is omitted, attributed illustrative food images keep publication usable. Anthropic is required for new recipe text.

The image model uses low quality, 1024×1024 PNG. `gpt-image-1` retires October 23, 2026; `gpt-image-2` is its documented replacement. Change the server environment override after testing a replacement model. See [OpenAI model deprecations](https://developers.openai.com/api/docs/deprecations) and [image generation settings and costs](https://developers.openai.com/api/docs/guides/image-generation).

## IAM and scheduling

Use a dedicated job runtime service account with Application Default Credentials. Grant:

- `roles/datastore.user` for the recipe, creator and discovery documents in this project.
- `roles/firebaseauth.admin` to create and maintain the four disabled creator identities.
- `roles/secretmanager.secretAccessor` on the two named secrets only.
- `roles/storage.objectCreator` on the image bucket. The deployed grant is bucket-wide and create-only; the generator restricts its object names to `discover/`.

The existing bucket does not enable uniform bucket-level access, so it rejected a prefix-conditioned IAM grant. Bucket settings remain unchanged. The granted role allows no reading, deleting or overwriting existing objects; the `discover/` prefix is enforced by code, not IAM. New image objects use collision-resistant `discover/{recipeId}/{uuid}.png` names, a create-only precondition, and `firebaseStorageDownloadTokens` metadata. Stored HTTPS download-token URLs serve the public image without `makePublic()` or bucket ACL changes. These URLs are intentionally public recipe media, not credentials for other bucket objects. See [Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles).

Use a separate scheduler service account with `roles/run.invoker` on this job only. Its authenticated HTTP target is the Cloud Run Jobs v2 `:run` API, using an **OAuth token** because the target is `run.googleapis.com`. Set scheduler retries to zero; the next regular tick handles eligible work. Do not expose an HTTP cron route on the public API. Follow [Google's scheduled Cloud Run Jobs procedure](https://cloud.google.com/run/docs/execute/jobs-on-schedule).

Deployment uses the API image containing `apps/api/jobs`, with command/arguments overridden as above. The deploying identity must be allowed to update the job and act as its runtime service account; it does not need to read secret values. Keep the regular API service's secret bindings separate.

## Publication and spend limits

- Bootstrap publishes **12 recipes, three per creator**, once, using stable IDs under `bootstrap-v1`.
- Subsequent UTC days have **3–5 deterministic, irregular publishing windows**. Fifteen-minute scheduler ticks publish only when a window is due. Missed windows do not cause a catch-up burst.
- Each due window reserves at most two new recipes, with **six new recipes per UTC day** after bootstrap. Later windows can rearrange the existing collection after that limit is reached. Bootstrap is a separate initial allowance.
- Generation runs two recipes concurrently. Each attempt permits one text call (90 seconds, 4,000 output tokens), one image call (120 seconds), and one upload (30 seconds). Neither provider call retries internally.
- Generated recipes allow 2–24 whole-number servings and 10–180 total minutes. The prompt, supported numeric schema enums, and strict validator share these limits. Servings count people or portions; baking instructions state piece yield separately so ingredient scaling remains correct. Invalid numbers are rejected, never rounded or coerced.
- Transactional reservations allow at most two attempts per recipe per UTC day: at most 12 normal generation attempts, or 24 bootstrap attempts, per day. These attempt caps are separate from the six published-recipe limit. Avoid manual budget resets.
- A 15-minute renewable lease prevents overlapping publishers; staging renews it. Completed drafts and image URLs survive retries. The collection pool retains up to 96 recipe IDs.

The four fictional editorial identities are `curated-maya-green`, `curated-theo-skillet`, `curated-nora-sunday`, and `curated-olive-crumb`. Their Firebase Auth records are disabled, have no email/password, and exist so current profile and cookbook links work. Palette initials replace human portraits. Profiles disclose fictional curation and untested AI recipes; recipe records retain `contentOrigin: ai-curated` and image provenance. Generated visuals are illustrative, not evidence that anyone cooked the recipe.

New recipes belong to their curator. Saving keeps that ownership; editing another creator's recipe uses the existing fork behavior. Never reassign existing user recipes or use the legacy creator/cookbook seeding scripts. Likes, saves and follower counts start at zero; only real interactions change engagement. Recipe counts reflect actual published recipes.

## Run, verify and recover

After the job is configured, execute it once for bootstrap with `gcloud run jobs execute JOB_NAME --project=grocerease-5abbb --region=us-central1 --wait`. Replace `JOB_NAME` with the deployed job name; do not run the entrypoint locally against production as a preview. The entrypoint writes production data and uses paid model calls.

A successful execution logs `published`, `not-due`, or `busy`. Check `discovery/state.activeEditionId`, the matching `discoveryEditions` document, `discoveryRuns`, and `discoveryDays`. Confirm twelve initial recipes, three working cookbook entries per creator, image loading/disclosures, profile links, and save/fork ownership. Verify the next scheduled execution and the stored `nextRefreshAt`.

If generation or publication fails, the job exits nonzero, records `GENERATION_FAILED`, releases its lease, and **keeps the previous edition live**. Image-only failures fall back to credited stock art. Inspect configuration, IAM and the safe run status; then execute the same job again or allow the next tick. Completed drafts are reused, and attempt limits still apply. For an interrupted process, let the lease expire before retrying. Do not clear reservation, title or edition documents to force a retry.

To stop new publishing, pause the scheduler; the last published edition remains readable. Recovery and image-model changes do not require resetting app data, deleting recipes, or recreating curator identities.
