# Curated Discover publishing

Discover reads real recipe documents, curated profile records and ordinary cookbook entries. A scheduled worker publishes editions; opening or refreshing the app never triggers paid generation.

## Public contract

`GET /api/explore` keeps `trending`, `newest`, and `featuredCreators` for existing clients. A published edition also supplies `edition: {id,title,subtitle,publishedAt,nextRefreshAt}`, `heroRecipe`, and `collections: [{id,title,subtitle,accent,recipes}]`. Accents are `sage`, `peach`, or `lemon`. The API resolves current recipe documents and applies visibility and personal-hide filters on every read. Until a first edition is published, the existing feed remains available.

Curated profiles have `profileKind: "curated"`, handle, bio, specialty and accent. Four stable `curated-*` Firebase Auth identities are disabled and have no email/password. Their Firestore profiles explicitly describe fictional Fridgie curators and AI-created recipes. Profile, cookbook, search and author links work through the normal endpoints. The first edition supplies three complete recipes per creator; later editions grow their cookbooks. No old identity or existing recipe is reassigned.

Generated recipes have explicit public visibility, `contentOrigin: "ai-curated"`, `curatedCreatorUid`, and the actual `publishedAt`. They have no fabricated source URL/author, ratings, followers, likes or imports. Their creators' own shelf entries do not count as community saves. Real follow and cookbook actions retain the existing transactional counters. Recipe writes strip client-supplied managed curation fields and reserve future `curated-*` IDs. A user fork becomes `contentOrigin: "ai-adapted"`, preserving `curatedCreatorUid` and `forkedFromId` ancestry while losing the official Fridgie-curated badge. Later owner edits cannot promote it back to curation. Replacing an image clears the previous image disclosure.

Images carry `imageKind: "ai-generated"` or `"illustrative-stock"`, with attribution for the latter. Generated images are illustrative, not photographs proving a recipe was kitchen-tested. The generator makes at most one image request per recipe; missing image configuration or image failure uses labelled, attributed fallback art. See `utils/curatedGenerator.ts` for the generator's validation and fixed creator catalog.

## Execution and spending bounds

`jobs/discovery.ts` invokes `runDiscoveryTick`. Deploy it as a Cloud Run Job triggered every 15 minutes by Cloud Scheduler using an IAM service account. There is no public HTTP cron endpoint. Cloud Run supports [scheduled job execution through Cloud Scheduler](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule); the scheduler calls the Google API with OAuth, while runtime database/storage access belongs to the job's own service account.

The worker calculates three to five irregular, deterministic publication windows per **UTC day**, aligned to 15-minute ticks. Container cold starts and duplicate deliveries calculate the same IDs. If a day was missed and the last publication is at least 24 hours old, the next tick brings today's first window forward rather than waiting. That window retains its scheduled ID, preventing another publication at its originally planned time. `nextRefreshAt` is a target, not a promise when a provider fails.

The first run stages 12 recipes across four creators. Thereafter each due window reserves at most two new recipe slots, capped at six new recipes per UTC day. Additional windows rotate the existing library with no AI generation. A recipe slot gets at most two generation attempts per UTC day: at most 12 regular attempts/day, plus a separate 24-attempt bootstrap ceiling while initialization is incomplete. A successful staged draft is reused without another paid call. The generator has no automatic provider retries. Normal successful operation creates at most six new text/image pairs per day. These are call-count caps, not a currency budget; provider pricing and configured image model determine actual cost.

Only two drafts generate concurrently. Per draft, text is bounded to 90 seconds, image generation to 120 seconds, and upload to 30 seconds; a 30-minute job timeout accommodates a worst-case bootstrap. The 15-minute global lease renews after each successfully staged draft. Lease tokens fence stale workers out of both staging and publication. Failures release the matching lease and leave the previous edition active. A crashed process is recoverable when its lease expires.

## CI image updates

After CI smoke-tests and promotes the API candidate, `.github/workflows/ci.yml` updates the existing `fridgie-discover-publish` Cloud Run Job to the same built image. The update changes only the image: the job retains its `bun run jobs/discovery.ts` command, publisher service account, environment, secrets, resource limits and timeout. Create/configure the job before the first such deployment. The CI deployer needs Cloud Run Developer on the project and Service Account User on the publisher service account; it does not need publisher secret values.

CI does not execute the worker. Cloud Scheduler starts its next normal run. A failed worker-image update fails the deployment job and triggers the existing API traffic rollback. That rollback restores only the API's previous revision; it does not change the worker image or undo a published edition. Inspect the worker configuration after an ambiguous update failure before retrying CI.

## Storage and publication

- `discovery/state`: active edition pointer, next refresh, recent 96-recipe pool and global lease.
- `discoveryRuns/{bootstrap-v1|UTC-date-window}`: durable recipe slot IDs, attempt counts and sanitized run state.
- `discoveryDays/{UTC-date}`: persisted window plan and reserved/attempt budgets.
- `discoveryDrafts/{recipeId}`: completed drafts outside the public recipes collection.
- `discoveryTitles/{normalized-title-hash}`: duplicate-title reservations across runs.
- `discoveryEditions/{editionId}`: published hero, collection recipe IDs and creator IDs.

External model/image calls happen outside Firestore transactions. A final transaction writes new recipes, cookbook entries, exact recipe-count increments and the edition, then replaces the active pointer. Failures before this commit publish no partial edition. Existing recipe ownership and social counters remain intact. Identity collisions stop publication instead of taking over another record. Global title normalization prevents repeated titles; the prompt also avoids recent dishes, but semantic equivalence under different titles cannot be guaranteed automatically.

The rotating read pool is bounded to 96 recipes; published recipes/cookbooks remain available permanently. Run, draft, title and edition audit documents currently have no automatic retention deletion. Their growth is bounded by publication frequency/recipe caps, but an archival policy is a future operational choice. Do not TTL-delete published recipe or cookbook documents: users may have saved them. Do not remove title reservations without accepting that an old title may be generated again.

## Validation

Offline tests use an injected transactional Firestore double and key-free generators. They cover atomic bootstrap, actual cookbook links/counts, duplicate delivery, lease expiry, paid-attempt bounds, retry reuse, day-rollover recovery, managed-ID/title collisions, keeping prior editions on failure, current visibility/personal-hide filters, and safe profile-field projection. They verify orchestration rather than asserting AI culinary correctness or live cloud deployment. The real job, profile/cookbook reads and image downloads must be checked after deployment.
