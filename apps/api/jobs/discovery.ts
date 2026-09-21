/**
 * Private Cloud Run Job: bun run jobs/discovery.ts (never an HTTP route).
 * Cloud Run overrides the image's API ENTRYPOINT with command=bun,
 * args=run,jobs/discovery.ts; one task, no automatic task retries.
 *
 * Runtime: shared ADC with Firestore/Auth permissions and storage.objectCreator
 * on FIREBASE_STORAGE_BUCKET (default grocerease-5abbb.firebasestorage.app).
 * Secrets: ANTHROPIC_API_KEY; optional OPENAI_API_KEY enables generated images.
 * DISCOVERY_IMAGE_MODEL defaults to gpt-image-2, low quality, 1024 square.
 * Keep this server-only override available for the provider's model lifecycle.
 * Initial 12 with concurrency 2 can take 24 minutes at the configured deadlines;
 * allow a 30-minute task timeout. The orchestrator enforces publishing budgets.
 */
import { CURATED_CREATORS, generateCuratedRecipe } from '../utils/curatedGenerator';
import { runDiscoveryTick } from '../utils/discovery';

try {
  const result = await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: generateCuratedRecipe });
  console.info('Discover generation finished', result);
  // Firestore's gRPC channels can keep Bun alive after the job completes.
  // runDiscoveryTick awaits every in-flight generation and the final writes.
  process.exit(0);
} catch {
  // The orchestrator records a safe failure status. Never log raw model requests,
  // SDK errors or environment data, which may contain provider credentials.
  console.error('Discover generation failed; inspect the edition status before retrying.');
  process.exit(1);
}
