import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { requirePro } from '@/middleware/requirePro';
import {
  completeLeftoversScanUse,
  consumeLeftoversScanAttempt,
  ProQuotaAccessError,
  refundLeftoversScanUse,
  reserveLeftoversScanUse,
} from '@/utils/aiQuota';
import {
  retryAfterSeconds,
  type AttemptRateDecision,
  type QuotaReservation,
} from '@/utils/aiQuotaCore';
import { completeJson, models } from '@/utils/claude';
import {
  leftoversVisionSchema,
  leftoversVisionSystemPrompt,
  normalizeDetectedIngredients,
  parseLeftoversPhotos,
  type ModelIngredient,
} from '@/utils/leftoversVision';
import { MAX_LEFTOVERS_UPLOAD_BYTES } from '@fridgie/shared/leftovers';

type JsonCompletion = typeof completeJson;

interface IdentifyDependencies {
  completeJson: JsonCompletion;
  reserveScan: (uid: string) => Promise<QuotaReservation>;
  consumeAttempt: (uid: string) => Promise<AttemptRateDecision>;
  completeScan: (uid: string, reservationId: string) => Promise<boolean>;
  refundScan: (uid: string, reservationId: string) => Promise<boolean>;
}

// Base64 expands bytes by roughly 4/3. Leave room for data-URL prefixes and
// JSON framing while still rejecting abusive bodies before JSON parsing.
const MAX_REQUEST_BYTES = Math.ceil(MAX_LEFTOVERS_UPLOAD_BYTES * 4 / 3) + 128 * 1024;

/**
 * POST /api/meal/leftovers/identify
 *
 * Photos exist only in this request and the provider call. No Storage object,
 * URL or Firestore document is created, and errors deliberately never log the
 * request body. The editable inventory returned here is a draft, not a food- or
 * allergen-safety determination.
 */
export function createIdentifyLeftoversHandler(dependencies: IdentifyDependencies) {
  return async (c: Context) => {
    const uid = c.get('uid') as string;
    const declaredLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return c.json({ error: 'photos_too_large', message: 'The combined photo upload is too large.' }, 413);
    }

    let body: { images?: unknown };
    try {
      body = await c.req.json();
    } catch (error) {
      // Hono's streaming body limiter deliberately aborts chunked uploads that
      // cross the cap. Preserve the useful 413 instead of misreporting that
      // abort as malformed JSON.
      if (error instanceof Error && error.name === 'BodyLimitError') {
        return c.json({ error: 'photos_too_large', message: 'The combined photo upload is too large.' }, 413);
      }
      return c.json({ error: 'invalid_json', message: 'The photo upload could not be read.' }, 400);
    }

    const parsed = parseLeftoversPhotos(body?.images);
    if (parsed.images.length === 0) {
      return c.json({
        error: 'no_usable_photos',
        message: 'Add at least one clear fridge or pantry photo.',
        warnings: parsed.warnings,
      }, 400);
    }

    // Reserve after all validation and immediately before the paid provider
    // call. This bucket is separate from visible meal-suggestion uses: a scan +
    // its eventual suggestion feels like one workflow, while still bounding
    // the more expensive multimodal half and preventing concurrent fan-out.
    let scanReservation: QuotaReservation;
    try {
      scanReservation = await dependencies.reserveScan(uid);
    } catch (error) {
      if (error instanceof ProQuotaAccessError) {
        return error.code === 'pro_required'
          ? c.json({ error: 'pro_required', message: 'Leftovers Mode is included with Fridgie Pro.' }, 403)
          : c.json({ error: 'entitlement_unavailable', message: 'Could not verify Fridgie Pro right now.' }, 503);
      }
      console.error('Could not reserve a Leftovers Mode scan:', error instanceof Error ? error.name : 'unknown');
      return c.json({ error: 'leftovers_scan_unavailable', message: 'Could not start this scan right now. Please try again.' }, 503);
    }

    if (!scanReservation.accepted || !scanReservation.reservationId) {
      if (scanReservation.rejectionReason === 'too_many_pending') {
        return c.json({
          error: 'leftovers_scan_busy',
          message: 'Another Leftovers Mode scan is already in progress. Please wait for it to finish.',
        }, 429);
      }
      return c.json({
        error: 'leftovers_scan_limit',
        message: 'Your weekly Leftovers Mode scan allowance is used up. It will reset automatically.',
        scanUsage: scanReservation.usage,
      }, 429);
    }
    const reservationId = scanReservation.reservationId;

    // Weekly scan uses can be refunded after provider failure. This separate
    // consume-only guard means those retries still have a hard hourly ceiling.
    let attempt: AttemptRateDecision;
    try {
      attempt = await dependencies.consumeAttempt(uid);
    } catch (error) {
      await dependencies.refundScan(uid, reservationId).catch((refundError) => {
        console.error('Could not refund scan after attempt-ledger failure:', refundError instanceof Error ? refundError.name : 'unknown');
      });
      console.error('Could not reserve a Leftovers provider attempt:', error instanceof Error ? error.name : 'unknown');
      return c.json({
        error: 'leftovers_attempt_limit_unavailable',
        message: 'Could not start this scan right now. Please try again.',
      }, 503);
    }

    if (!attempt.accepted) {
      await dependencies.refundScan(uid, reservationId).catch((refundError) => {
        console.error('Could not refund a rate-limited scan:', refundError instanceof Error ? refundError.name : 'unknown');
      });
      c.header('Retry-After', String(retryAfterSeconds(attempt.usage)));
      return c.json({
        error: 'leftovers_attempt_rate_exceeded',
        message: 'Too many Leftovers Mode attempts right now. Please try again after this short cooldown.',
        attemptUsage: attempt.usage,
      }, 429);
    }

    try {
      const result = await dependencies.completeJson<{ ingredients: ModelIngredient[] }>({
        model: models.leftoversIdentify,
        system: leftoversVisionSystemPrompt,
        user: [
          ...parsed.images,
          {
            type: 'text',
            text: `Build one editable ingredient inventory from these ${parsed.images.length} photo${parsed.images.length === 1 ? '' : 's'}.`,
          },
        ],
        schema: leftoversVisionSchema,
        effort: 'medium',
        maxTokens: 2500,
        // Leave time inside the 120s HTTP envelope to finalize/refund the scan
        // and answer the mobile client. A visible retry is safer than a hidden
        // second multimodal charge.
        timeoutMs: 100_000,
        maxRetries: 0,
      });

      const ingredients = normalizeDetectedIngredients(result.ingredients);
      if (ingredients.length === 0) {
        await dependencies.refundScan(uid, reservationId).catch((refundError) => {
          console.error('Could not refund an empty Leftovers Mode scan:', refundError instanceof Error ? refundError.name : 'unknown');
        });
        return c.json({
          error: 'ingredients_not_found',
          message: 'No ingredients were clear enough to add. Try a closer or brighter photo.',
          warnings: parsed.warnings,
        }, 422);
      }

      await dependencies.completeScan(uid, reservationId).catch((completeError) => {
        // The accepted use was counted at reservation time. A completion write
        // only releases its pending marker, whose lease also expires safely.
        console.error('Could not finalize a Leftovers Mode scan:', completeError instanceof Error ? completeError.name : 'unknown');
      });
      return c.json({ ingredients, warnings: parsed.warnings, scanUsage: scanReservation.usage });
    } catch (error) {
      await dependencies.refundScan(uid, reservationId).catch((refundError) => {
        console.error('Could not refund a failed Leftovers Mode scan:', refundError instanceof Error ? refundError.name : 'unknown');
      });
      // Do not include the provider error or request body in the response: SDK
      // errors can carry request details, and fridge photos are private input.
      console.error('Leftovers ingredient identification failed:', error instanceof Error ? error.name : 'unknown error');
      return c.json({
        error: 'identification_failed',
        message: 'Could not check those photos. Your photos were not saved; you can try again.',
        warnings: parsed.warnings,
      }, 500);
    }
  };
}

const route = new Hono();
route.use('*', auth, requireAccount, requirePro);
route.post(
  '/',
  bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: (c) => c.json({
      error: 'photos_too_large',
      message: 'The combined photo upload is too large.',
    }, 413),
  }),
  createIdentifyLeftoversHandler({
    completeJson,
    reserveScan: reserveLeftoversScanUse,
    consumeAttempt: consumeLeftoversScanAttempt,
    completeScan: completeLeftoversScanUse,
    refundScan: refundLeftoversScanUse,
  }),
);

export default route;
