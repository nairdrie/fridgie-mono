import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { adminAuth, fs } from './firebase';
import { invalidateSearchIndex } from './searchIndex';
import type { ExploreAccent, ExploreEdition, Recipe } from './types';
import type { CuratedCreatorDefinition, CuratedRecipeDraft } from './curatedGenerator';
import { CURATED_GENERATION_REASONS } from './curatedGenerator';

const DAY_MS = 86_400_000;
const LEASE_MS = 15 * 60_000;
const POOL_LIMIT = 96;
export const DISCOVERY_DAILY_LIMIT = 6;
export const DISCOVERY_BOOTSTRAP_COUNT = 12;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const numberFrom = (value: string) => parseInt(hash(value).slice(0, 8), 16);
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const collectionTitles: Record<string, string> = {
  'curated-maya-green': 'Plant-forward', 'curated-theo-skillet': 'Weeknight wins',
  'curated-nora-sunday': 'Comfort food', 'curated-olive-crumb': 'Bakes & breakfasts',
};

export interface DiscoveryWindow { id: string; at: number }
/** Stable irregular windows survive container restarts and duplicate deliveries. */
export function discoveryWindows(day: string): DiscoveryWindow[] {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error('Invalid discovery day');
  const count = 3 + numberFrom(`count:${day}`) % 3;
  const width = Math.floor(96 / count);
  return Array.from({ length: count }, (_, index) => ({
    id: `${day}-${index}`,
    at: start + (index * width + 1 + numberFrom(`${day}:${index}`) % Math.max(1, width - 2)) * 15 * 60_000,
  }));
}
export function discoveryTiming(now: number) {
  const today = discoveryWindows(dayOf(now));
  const due = today.filter(window => window.at <= now).at(-1) ?? null;
  const next = today.find(window => window.at > now) ?? discoveryWindows(dayOf(now + DAY_MS))[0]!;
  return { due, next };
}
export const curatedTitleKey = (title: string) => hash(title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());

export interface DiscoveryLease {
  runId: string;
  token: string;
  day: string;
  bootstrap: boolean;
  recipeIds: string[];
  coveredWindowId: string | null;
  nextRefreshAt: string;
}
export interface StoredDiscoveryEdition extends ExploreEdition {
  heroRecipeId: string;
  creatorUids: string[];
  collections: { id: string; title: string; subtitle: string; accent: ExploreAccent; recipeIds: string[] }[];
}
type DiscoveryPhase = 'profiles' | 'library' | 'draft' | 'budget' | 'generation' | 'staging' | 'publication';
const FAILURE_CODES = ['INVALID_RECIPE', 'DUPLICATE_RECIPE', 'INVALID_REQUEST', 'LEASE_EXPIRED', 'GENERATION_BUDGET_EXHAUSTED', 'IDENTITY_COLLISION', 'NO_PUBLISHABLE_RECIPES', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_REQUEST_REJECTED', 'PROVIDER_UNAVAILABLE', 'MODEL_OUTPUT_INVALID', 'BACKEND_PERMISSION_DENIED', 'BACKEND_UNAVAILABLE', 'GENERATION_FAILED'] as const;
export interface DiscoveryFailure {
  code: typeof FAILURE_CODES[number];
  phase: DiscoveryPhase;
  status?: number;
  recipeId?: string;
  reason?: string;
}
class DiscoveryRefreshError extends Error {
  constructor(readonly failure: DiscoveryFailure) {
    super(`Discovery refresh failed (${failure.code}); the previous edition remains live.`);
  }
}
/** Diagnostic projection only; never retain an SDK error, response, message or cause. */
export function safeDiscoveryFailure(error: unknown, phase: DiscoveryPhase = 'generation', recipeId?: string): DiscoveryFailure {
  if (error instanceof DiscoveryRefreshError) return { ...error.failure };
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : undefined;
  const internal: Record<string, DiscoveryFailure['code']> = {
    'Invalid curated recipe': 'INVALID_RECIPE', 'Duplicate curated recipe': 'DUPLICATE_RECIPE',
    'Discovery lease expired': 'LEASE_EXPIRED', 'Discovery generation budget exhausted': 'GENERATION_BUDGET_EXHAUSTED',
    'Curated identity collision': 'IDENTITY_COLLISION', 'Curated recipe identity collision': 'IDENTITY_COLLISION',
    'No publishable discovery recipes': 'NO_PUBLISHABLE_RECIPES',
    'Claude hit the output limit before finishing the JSON.': 'MODEL_OUTPUT_INVALID',
    'Claude returned no text content.': 'MODEL_OUTPUT_INVALID',
    'Claude returned text that was not valid JSON.': 'MODEL_OUTPUT_INVALID',
  };
  let code: DiscoveryFailure['code'] = 'GENERATION_FAILED';
  if (typeof value.code === 'string' && (FAILURE_CODES as readonly string[]).includes(value.code)) code = value.code as DiscoveryFailure['code'];
  else if (typeof value.message === 'string' && Object.hasOwn(internal, value.message)) code = internal[value.message]!;
  else if (['APIConnectionTimeoutError', 'AbortError', 'TimeoutError'].includes(String(value.name))) code = 'PROVIDER_TIMEOUT';
  else if (value.name === 'ClaudeError') code = 'MODEL_OUTPUT_INVALID';
  else if (status === 429) code = 'PROVIDER_RATE_LIMITED';
  else if (status === 408 || status === 504) code = 'PROVIDER_TIMEOUT';
  else if (status === 401 || status === 403) code = 'PROVIDER_ACCESS_DENIED';
  else if (status && status < 500) code = 'PROVIDER_REQUEST_REJECTED';
  else if (status && status >= 500) code = 'PROVIDER_UNAVAILABLE';
  else if (value.code === 7 || value.code === 'permission-denied' || value.code === 'auth/insufficient-permission') code = 'BACKEND_PERMISSION_DENIED';
  else if (value.code === 14 || value.code === 'unavailable') code = 'BACKEND_UNAVAILABLE';
  return {
    code, phase,
    ...(status ? { status } : {}),
    ...(recipeId && /^curated-[a-z0-9-]{1,160}$/.test(recipeId) ? { recipeId } : {}),
    ...(typeof value.reason === 'string' && (CURATED_GENERATION_REASONS as readonly string[]).includes(value.reason) ? { reason: value.reason } : {}),
  };
}
export interface DiscoveryRepository {
  acquire(now: number): Promise<DiscoveryLease | 'not-due' | 'busy'>;
  ensureCreators(creators: CuratedCreatorDefinition[]): Promise<void>;
  library(): Promise<Recipe[]>;
  draft(recipeId: string): Promise<Recipe | null>;
  reserveAttempt(lease: DiscoveryLease, recipeId: string, now: number): Promise<void>;
  stage(lease: DiscoveryLease, recipe: Recipe, now: number): Promise<void>;
  publish(lease: DiscoveryLease, edition: StoredDiscoveryEdition, drafts: Recipe[], now: number): Promise<void>;
  fail(lease: DiscoveryLease, now: number, failure?: DiscoveryFailure): Promise<void>;
}

export function composeDiscoveryEdition(lease: DiscoveryLease, recipes: Recipe[], creators: CuratedCreatorDefinition[], now: number): StoredDiscoveryEdition {
  const available = recipes.filter(recipe => recipe.visibility !== 'private' && recipe.contentOrigin === 'ai-curated');
  const fresh = new Set(lease.recipeIds);
  const ordered = [...available].sort((a, b) => Number(fresh.has(b.id)) - Number(fresh.has(a.id)) || numberFrom(`${lease.runId}:${a.id}`) - numberFrom(`${lease.runId}:${b.id}`));
  const hero = ordered[0];
  if (!hero) throw new Error('No publishable discovery recipes');
  const headlines = ['Something lovely to cook', 'Fresh ideas for your table', 'Your next kitchen favourite', 'A good day for good food'];
  return {
    id: lease.runId,
    title: headlines[numberFrom(lease.runId) % headlines.length]!,
    subtitle: 'Original recipes from Fridgie’s curated kitchens.',
    publishedAt: new Date(now).toISOString(),
    nextRefreshAt: lease.nextRefreshAt,
    heroRecipeId: hero.id,
    creatorUids: creators.map(creator => creator.uid),
    collections: creators.map(creator => ({
      id: creator.uid,
      title: collectionTitles[creator.uid] ?? creator.specialty.split(/[;,]/)[0]!.slice(0, 60),
      subtitle: `From ${creator.displayName} · Fridgie-curated`,
      accent: creator.accent,
      recipeIds: ordered.filter(recipe => recipe.createdBy === creator.uid && recipe.id !== hero.id).slice(0, 4).map(recipe => recipe.id),
    })).filter(collection => collection.recipeIds.length > 0),
  };
}

function storedDraft(draft: CuratedRecipeDraft, id: string, creator: CuratedCreatorDefinition): Recipe {
  if (!draft.name?.trim() || !draft.description?.trim() || !Array.isArray(draft.ingredients) || draft.ingredients.length < 2 ||
      draft.ingredients.some(item => !item.name?.trim() || typeof item.quantity !== 'string') ||
      !Array.isArray(draft.instructions) || draft.instructions.length < 2 || draft.instructions.some(step => !step?.trim())) {
    throw new Error('Invalid curated recipe');
  }
  // Explicit projection excludes any invented source URLs or engagement fields.
  return {
    id, name: draft.name, description: draft.description,
    ingredients: draft.ingredients, instructions: draft.instructions,
    ...(draft.tags ? { tags: draft.tags } : {}),
    ...(draft.category ? { category: draft.category } : {}),
    ...(draft.servings ? { servings: draft.servings } : {}),
    ...(draft.photoURL ? { photoURL: draft.photoURL } : {}),
    ...(draft.totalMinutes ? { totalMinutes: draft.totalMinutes } : {}),
    ...(draft.imageKind ? { imageKind: draft.imageKind } : {}),
    ...(draft.imageAttribution ? { imageAttribution: draft.imageAttribution } : {}),
    createdBy: creator.uid, visibility: 'public', contentOrigin: 'ai-curated', curatedCreatorUid: creator.uid,
  };
}

/** Called only by an IAM-protected Cloud Run job, never on a feed read. */
export async function runDiscoveryTick({ creators, generateRecipe, repository = firestoreDiscoveryRepository(), now = Date.now }: {
  creators: CuratedCreatorDefinition[];
  generateRecipe: (input: { creator: CuratedCreatorDefinition; recipeId: string; seed: string; recentTitles: string[] }) => Promise<CuratedRecipeDraft>;
  repository?: DiscoveryRepository;
  now?: () => number;
}): Promise<{ status: 'published' | 'not-due' | 'busy'; editionId?: string; generatedCount?: number }> {
  if (creators.length !== 4 || new Set(creators.map(creator => creator.uid)).size !== 4 || creators.some(creator => !/^curated-[a-z0-9-]+$/.test(creator.uid))) {
    throw new Error('Discovery requires four distinct curated identities');
  }
  const lease = await repository.acquire(now());
  if (typeof lease === 'string') return { status: lease };
  let phase: DiscoveryPhase = 'profiles';
  try {
    await repository.ensureCreators(creators);
    phase = 'library';
    const library = await repository.library();
    const drafts: Recipe[] = [];
    // Two bounded generations at a time. Await the whole pair on failure so
    // staged successes survive and no work continues after releasing the lease.
    for (let offset = 0; offset < lease.recipeIds.length; offset += 2) {
      const completed = await Promise.allSettled(lease.recipeIds.slice(offset, offset + 2).map(async (id, withinPair) => {
        let recipePhase: DiscoveryPhase = 'draft';
        try {
          const existing = await repository.draft(id);
          if (existing) return existing;
          recipePhase = 'budget';
          await repository.reserveAttempt(lease, id, now());
          const index = offset + withinPair;
          const creator = creators[(lease.bootstrap ? index : numberFrom(lease.runId) + index) % creators.length]!;
          recipePhase = 'generation';
          const draft = await generateRecipe({ creator, recipeId: id, seed: `${lease.runId}:${index}`, recentTitles: [...library, ...drafts].map(recipe => recipe.name).slice(0, 120) });
          const recipe = storedDraft(draft, id, creator);
          recipePhase = 'staging';
          await repository.stage(lease, recipe, now());
          return recipe;
        } catch (error) {
          throw new DiscoveryRefreshError(safeDiscoveryFailure(error, recipePhase, id));
        }
      }));
      for (const result of completed) if (result.status === 'fulfilled') drafts.push(result.value);
      const failed = completed.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    phase = 'publication';
    const seen = new Set(drafts.map(recipe => recipe.id));
    const edition = composeDiscoveryEdition(lease, [...drafts, ...library.filter(recipe => !seen.has(recipe.id))], creators, now());
    await repository.publish(lease, edition, drafts, now());
    invalidateSearchIndex();
    return { status: 'published', editionId: edition.id, generatedCount: drafts.length };
  } catch (error) {
    const failure = safeDiscoveryFailure(error, phase);
    await repository.fail(lease, now(), failure).catch(() => {});
    // No model response, prompt, credential, or image-provider body in job logs.
    console.warn('Discover refresh failed', { runId: lease.runId, ...failure });
    throw new DiscoveryRefreshError(failure);
  }
}

export function firestoreDiscoveryRepository(db: Firestore = fs, identities = adminAuth): DiscoveryRepository {
  const stateRef = db.collection('discovery').doc('state');
  const runRef = (id: string) => db.collection('discoveryRuns').doc(id);
  const dayRef = (day: string) => db.collection('discoveryDays').doc(day);
  const draftRef = (id: string) => db.collection('discoveryDrafts').doc(id);
  const verify = (lease: DiscoveryLease, state: any, run: any, now: number) => {
    if (state?.leaseToken !== lease.token || run?.leaseToken !== lease.token || run?.status !== 'running' || Number(state.leaseUntil) <= now) {
      throw new Error('Discovery lease expired');
    }
  };
  return {
    acquire: now => db.runTransaction(async transaction => {
      const state = (await transaction.get(stateRef)).data() ?? {};
      if (Number(state.leaseUntil) > now) return 'busy' as const;
      const timing = discoveryTiming(now);
      const bootstrap = !state.activeEditionId;
      const day = dayOf(now);
      // After a missed day, bring today's first window forward on the next
      // tick. It retains its scheduled ID, so it cannot publish twice later.
      const stale = Number.isFinite(Date.parse(state.updatedAt)) && now - Date.parse(state.updatedAt) >= DAY_MS;
      const recovery = !timing.due && !bootstrap && stale ? discoveryWindows(day)[0]! : null;
      const due = timing.due ?? recovery;
      const next = recovery ? discoveryWindows(day)[1]! : timing.next;
      if (!bootstrap && (!due || state.lastWindowId === due.id)) return 'not-due' as const;
      const runId = bootstrap ? 'bootstrap-v1' : due!.id;
      const [runDoc, dayDoc] = await transaction.getAll(runRef(runId), dayRef(day));
      const run = runDoc!.data() ?? {};
      const daily = dayDoc!.data() ?? {};
      if (run.status === 'published') return 'not-due' as const;
      const count = bootstrap ? DISCOVERY_BOOTSTRAP_COUNT : Math.min(2, Math.max(0, DISCOVERY_DAILY_LIMIT - (Number(daily.reservedRecipes) || 0)));
      const recipeIds: string[] = Array.isArray(run.recipeIds) ? run.recipeIds : Array.from({ length: count }, (_, i) => `curated-${runId}-${i}`);
      const lease: DiscoveryLease = { runId, token: randomUUID(), day, bootstrap, recipeIds, coveredWindowId: due?.id ?? null, nextRefreshAt: new Date(next.at).toISOString() };
      transaction.set(dayRef(day), { windows: discoveryWindows(day), ...(!runDoc!.exists && !bootstrap ? { reservedRecipes: (Number(daily.reservedRecipes) || 0) + count } : {}) }, { merge: true });
      transaction.set(runRef(runId), { recipeIds, leaseToken: lease.token, leaseUntil: now + LEASE_MS, status: 'running', startedAt: new Date(now).toISOString() }, { merge: true });
      transaction.set(stateRef, { leaseToken: lease.token, leaseUntil: now + LEASE_MS, leaseRunId: runId }, { merge: true });
      return lease;
    }),
    async ensureCreators(creators) {
      for (const creator of creators) {
        const userRef = db.collection('users').doc(creator.uid);
        const existing = await userRef.get();
        let record = await identities.getUser(creator.uid).catch((error: any) => { if (error.code !== 'auth/user-not-found') throw error; return null; });
        if (!record) record = await identities.createUser({ uid: creator.uid, displayName: creator.displayName, disabled: true, ...(creator.photoURL ? { photoURL: creator.photoURL } : {}) });
        else if (existing.data()?.profileKind !== 'curated' && (!record.disabled || record.email || record.providerData.length)) throw new Error('Curated identity collision');
        await identities.updateUser(creator.uid, { disabled: true, displayName: creator.displayName, ...(creator.photoURL ? { photoURL: creator.photoURL } : {}) });
        await userRef.set({
          profileKind: 'curated', displayName: creator.displayName, handle: creator.handle, bio: creator.bio,
          specialty: creator.specialty, accent: creator.accent,
          ...(!existing.exists ? { followerCount: 0, followingCount: 0, recipeCount: 0 } : {}),
        }, { merge: true });
      }
    },
    async library() {
      const ids = ((await stateRef.get()).data()?.poolRecipeIds ?? []) as string[];
      if (!ids.length) return [];
      const docs = await db.getAll(...ids.slice(0, POOL_LIMIT).map(id => db.collection('recipes').doc(id)));
      return docs.filter(doc => doc.exists).map(doc => ({ id: doc.id, ...doc.data() } as Recipe));
    },
    async draft(id) {
      const doc = await draftRef(id).get();
      return doc.exists ? doc.data() as Recipe : null;
    },
    async reserveAttempt(lease, recipeId, now) {
      await db.runTransaction(async transaction => {
        const [state, runDoc, dailyDoc] = await transaction.getAll(stateRef, runRef(lease.runId), dayRef(lease.day));
        const run = runDoc!.data() ?? {};
        verify(lease, state!.data(), run, now);
        const attempts = run.attemptDay === lease.day ? run.attempts ?? {} : {};
        const used = Number(dailyDoc!.data()?.generationAttempts) || 0;
        const bootstrapUsed = Number(dailyDoc!.data()?.bootstrapGenerationAttempts) || 0;
        if (!lease.recipeIds.includes(recipeId) || (Number(attempts[recipeId]) || 0) >= 2 ||
            (lease.bootstrap ? bootstrapUsed >= DISCOVERY_BOOTSTRAP_COUNT * 2 : used >= DISCOVERY_DAILY_LIMIT * 2)) throw new Error('Discovery generation budget exhausted');
        // Replace the whole map so counters from a previous UTC day cannot
        // survive Firestore's default recursive merge for another recipe slot.
        transaction.set(runRef(lease.runId), { attemptDay: lease.day, attempts: { ...attempts, [recipeId]: (Number(attempts[recipeId]) || 0) + 1 } }, { mergeFields: ['attemptDay', 'attempts'] });
        transaction.set(dayRef(lease.day), lease.bootstrap ? { bootstrapGenerationAttempts: bootstrapUsed + 1 } : { generationAttempts: used + 1 }, { merge: true });
      });
    },
    async stage(lease, recipe, now) {
      await db.runTransaction(async transaction => {
        const signatureRef = db.collection('discoveryTitles').doc(curatedTitleKey(recipe.name));
        const [state, run, signature] = await transaction.getAll(stateRef, runRef(lease.runId), signatureRef);
        verify(lease, state!.data(), run!.data(), now);
        if (signature!.exists && signature!.data()?.recipeId !== recipe.id) throw new Error('Duplicate curated recipe');
        transaction.set(signatureRef, { recipeId: recipe.id });
        transaction.set(draftRef(recipe.id), recipe);
        transaction.set(stateRef, { leaseUntil: now + LEASE_MS }, { merge: true });
        transaction.set(runRef(lease.runId), { leaseUntil: now + LEASE_MS }, { merge: true });
      });
    },
    async publish(lease, edition, drafts, now) {
      await db.runTransaction(async transaction => {
        const [stateDoc, runDoc] = await transaction.getAll(stateRef, runRef(lease.runId));
        const state = stateDoc!.data() ?? {};
        verify(lease, state, runDoc!.data(), now);
        const existing = drafts.length ? await transaction.getAll(...drafts.map(recipe => db.collection('recipes').doc(recipe.id))) : [];
        const published = new Set(existing.filter(doc => doc.exists).map(doc => doc.id));
        if (existing.some(doc => doc.exists && (doc.data()?.contentOrigin !== 'ai-curated' || doc.data()?.createdBy !== drafts.find(recipe => recipe.id === doc.id)?.createdBy))) {
          throw new Error('Curated recipe identity collision');
        }
        const counts = new Map<string, number>();
        for (const recipe of drafts) {
          if (published.has(recipe.id)) continue;
          const { id, ...data } = recipe;
          transaction.create(db.collection('recipes').doc(id), { ...data, createdAt: new Date(now), publishedAt: edition.publishedAt, popularity: { likes: 0, cookbooks: 0 } });
          transaction.set(db.collection('users').doc(recipe.createdBy!).collection('cookbook').doc(id), { name: recipe.name, photoURL: recipe.photoURL ?? null, addedAt: new Date(now), public: true });
          counts.set(recipe.createdBy!, (counts.get(recipe.createdBy!) ?? 0) + 1);
        }
        for (const [uid, count] of counts) transaction.set(db.collection('users').doc(uid), { recipeCount: FieldValue.increment(count), featured: true, featuredRecipe: drafts.find(recipe => recipe.createdBy === uid)!.id }, { merge: true });
        const poolRecipeIds = [...new Set([...drafts.map(recipe => recipe.id), ...(state.poolRecipeIds ?? [])])].slice(0, POOL_LIMIT);
        transaction.set(db.collection('discoveryEditions').doc(edition.id), edition);
        transaction.set(stateRef, { activeEditionId: edition.id, poolRecipeIds, lastWindowId: lease.coveredWindowId, nextRefreshAt: edition.nextRefreshAt, updatedAt: edition.publishedAt, leaseToken: null, leaseUntil: 0 }, { merge: true });
        transaction.set(runRef(lease.runId), { status: 'published', publishedAt: edition.publishedAt, leaseUntil: 0 }, { merge: true });
      });
    },
    async fail(lease, now, failure = { code: 'GENERATION_FAILED', phase: 'generation' }) {
      await db.runTransaction(async transaction => {
        const state = (await transaction.get(stateRef)).data();
        if (state?.leaseToken !== lease.token) return;
        transaction.set(stateRef, { leaseToken: null, leaseUntil: 0 }, { merge: true });
        transaction.set(runRef(lease.runId), { status: 'failed', failedAt: new Date(now).toISOString(), error: failure.code, failure, leaseUntil: 0 }, { merge: true });
      });
    },
  };
}
