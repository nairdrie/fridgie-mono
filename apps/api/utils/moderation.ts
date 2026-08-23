// Getting a bad recipe off other people's screens.
//
// Explore shows strangers' recipes, and every surface that does needs two
// different escape hatches — they are not the same thing and must not share a
// control:
//
//   HIDE is personal and instant. "Not for me." It affects one viewer, needs no
//   justification, and nothing about the recipe changes for anybody else.
//
//   REPORT is a claim that nobody should see this. It hides the recipe for the
//   reporter too — someone who just told you a recipe is spam should not have
//   to look at it while they wait — and it accumulates against the recipe until
//   enough independent people agree to pull it from public view.
//
// The auto-hide is deliberately a `visibility` flip and not a delete. It takes
// the recipe out of Explore and search while leaving it in its owner's
// cookbook, so the failure mode of a bad report is an inconvenience rather than
// destroying someone's work.

import { fs } from '@/utils/firebase';
import { invalidateSearchIndex } from '@/utils/searchIndex';

/**
 * Distinct reporters needed before a recipe drops out of public view.
 *
 * Low, because the action is reversible and cheap, and because the alternative
 * — a queue nobody reads — means the first person to report something spends a
 * week watching it stay up. One disgruntled user cannot reach it alone.
 */
export const AUTO_HIDE_REPORTS = 3;

export const REPORT_REASONS = [
  'not-a-recipe',
  'spam',
  'offensive',
  'stolen-content',
  'dangerous',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const isReportReason = (value: unknown): value is ReportReason =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);

/** Written feedback is stored for a human to read, not parsed; bound it. */
export const MAX_REPORT_NOTE_CHARS = 1000;

const hiddenRef = (uid: string, recipeId: string) =>
  fs.collection('users').doc(uid).collection('hiddenRecipes').doc(recipeId);

/**
 * One report per person per recipe, enforced by the document id rather than by
 * a read-then-write. Reporting twice is an edit of your own report, which is
 * what makes the count below a count of PEOPLE — without it, a single user
 * tapping report four times could pull any recipe on the platform.
 */
const reportRef = (recipeId: string, uid: string) =>
  fs.collection('recipeReports').doc(`${recipeId}__${uid}`);

/**
 * The recipes this user never wants to see again.
 *
 * Read on every Explore request, so it is a single collection read of a set
 * that is empty for almost everybody. If it ever stops being small, it belongs
 * on the user document as an array instead.
 */
export async function hiddenRecipeIds(uid: string): Promise<Set<string>> {
  try {
    const snap = await fs.collection('users').doc(uid).collection('hiddenRecipes').select().get();
    return new Set(snap.docs.map((d) => d.id));
  } catch (error) {
    // A feed that fails to load is worse than a feed containing something the
    // viewer hid. Degrade rather than throw.
    console.warn('Hidden recipe lookup failed:', error instanceof Error ? error.message : error);
    return new Set();
  }
}

export async function hideRecipeForUser(uid: string, recipeId: string): Promise<void> {
  await hiddenRef(uid, recipeId).set({ hiddenAt: new Date() });
}

export async function unhideRecipeForUser(uid: string, recipeId: string): Promise<void> {
  await hiddenRef(uid, recipeId).delete();
}

export interface ReportOutcome {
  /** Distinct people who have now reported this recipe. */
  reportCount: number;
  /** Whether this report was the one that pulled it from public view. */
  autoHidden: boolean;
}

/**
 * Record a report, hide the recipe for its reporter, and pull it from public
 * view once enough different people have said the same thing.
 */
export async function reportRecipe(
  uid: string,
  recipeId: string,
  reason: ReportReason,
  note: string,
  sourceKey: string | null,
): Promise<ReportOutcome> {
  await reportRef(recipeId, uid).set({
    recipeId,
    reporterUid: uid,
    reason,
    note,
    // Copied onto the report so that a moderator looking at one bad TikTok can
    // find every recipe imported from it, not just the one that got reported.
    sourceKey: sourceKey ?? null,
    status: 'open',
    createdAt: new Date(),
  });

  // Nobody who reports a recipe should keep seeing it.
  await hideRecipeForUser(uid, recipeId);

  const counted = await fs.collection('recipeReports')
    .where('recipeId', '==', recipeId)
    .count()
    .get();
  const reportCount = counted.data().count;

  if (reportCount < AUTO_HIDE_REPORTS) {
    return { reportCount, autoHidden: false };
  }

  const recipeRef = fs.collection('recipes').doc(recipeId);
  const recipeDoc = await recipeRef.get();
  // Already pulled by an earlier report, or made private by its owner in the
  // meantime — either way this report is not the one that did it.
  if (!recipeDoc.exists || recipeDoc.data()?.visibility === 'private') {
    return { reportCount, autoHidden: false };
  }

  await recipeRef.update({
    visibility: 'private',
    hiddenByReportsAt: new Date(),
  });
  invalidateSearchIndex();
  console.warn(`Recipe ${recipeId} auto-hidden after ${reportCount} reports`);

  return { reportCount, autoHidden: true };
}
