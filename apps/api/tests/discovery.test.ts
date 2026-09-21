import { describe, expect, mock, test } from 'bun:test';
import { CURATED_CREATORS, CuratedGenerationError, type CuratedRecipeDraft } from '../utils/curatedGenerator';
import { composeDiscoveryEdition, curatedTitleKey, discoveryTiming, discoveryWindows, firestoreDiscoveryRepository, runDiscoveryTick, safeDiscoveryFailure, type DiscoveryLease } from '../utils/discovery';
import { materializeDiscovery } from '../utils/discoveryRead';
import { curatedProfileFields } from '../utils/publicProfiles';
import type { Recipe } from '../utils/types';

type Data = Record<string, any>;
type SetOptions = { merge?: boolean; mergeFields?: string[] };
function database() {
  const documents = new Map<string, Data>();
  const users = new Map<string, Data>();
  const clone = (value: any) => value === undefined ? undefined : structuredClone(value);
  const snap = (path: string) => ({ id: path.split('/').at(-1)!, exists: documents.has(path), data: () => clone(documents.get(path)) });
  const materialize = (previous: any, value: any, merge: boolean): any => {
    if (value && typeof value === 'object' && value.constructor?.name === 'NumericIncrementTransform') return (Number(previous) || 0) + value.operand;
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      // Firestore merges non-empty maps recursively, but an explicit empty map
      // replaces that field. Arrays, timestamps and scalars remain atomic.
      const result = merge && Object.keys(value).length && previous && Object.getPrototypeOf(previous) === Object.prototype ? clone(previous) : {};
      for (const [key, item] of Object.entries(value)) result[key] = materialize(previous?.[key], item, merge);
      return result;
    }
    return clone(value);
  };
  const write = (path: string, value: Data, options?: SetOptions) => {
    const previous = documents.get(path) ?? {};
    if (options?.mergeFields) {
      const fields = clone(previous);
      for (const key of options.mergeFields) {
        if (key.includes('.') || !Object.hasOwn(value, key)) throw new Error('Unsupported or missing fixture field mask');
        fields[key] = materialize(previous[key], value[key], false);
      }
      documents.set(path, fields);
    } else documents.set(path, materialize(previous, value, options?.merge ?? false));
  };
  const ref = (path: string): any => ({ path, id: path.split('/').at(-1), get: async () => snap(path), collection: (name: string) => collection(`${path}/${name}`), set: async (value: Data, options?: SetOptions) => write(path, value, options) });
  const collection = (path: string): any => ({ doc: (id: string) => ref(`${path}/${id}`) });
  let queue = Promise.resolve();
  const db = {
    collection,
    getAll: async (...refs: { path: string }[]) => refs.map(item => snap(item.path)),
    runTransaction: <T>(operation: (transaction: any) => Promise<T>): Promise<T> => {
      const task = queue.then(async () => {
        const writes: (() => void)[] = [];
        const check = () => { if (writes.length) throw new Error('Firestore transaction read after write'); };
        const result = await operation({
          get: async (item: { path: string }) => { check(); return snap(item.path); },
          getAll: async (...refs: { path: string }[]) => { check(); return refs.map(item => snap(item.path)); },
          set: (item: { path: string }, value: Data, options?: SetOptions) => writes.push(() => write(item.path, value, options)),
          create: (item: { path: string }, value: Data) => { if (documents.has(item.path)) throw new Error('Document exists'); writes.push(() => write(item.path, value)); },
        });
        writes.forEach(commit => commit());
        return result;
      });
      queue = task.then(() => {}, () => {});
      return task;
    },
  };
  const identities = {
    getUser: async (uid: string) => { const user = users.get(uid); if (!user) throw { code: 'auth/user-not-found' }; return user; },
    createUser: mock(async (data: Data) => { users.set(data.uid, { ...data, providerData: [] }); return users.get(data.uid); }),
    updateUser: async (uid: string, data: Data) => { users.set(uid, { ...users.get(uid), ...data }); return users.get(uid); },
  };
  const repository = firestoreDiscoveryRepository(db as any, identities as any);
  return { documents, users, identities, repository };
}

const start = Date.parse('2026-09-20T00:00:00Z');
const generated = (id: string): CuratedRecipeDraft => ({
  name: `Lemon chickpeas ${id}`, description: 'A bright bowl with a creamy lemon dressing.',
  ingredients: [{ name: 'chickpeas', quantity: '1 can' }, { name: 'lemon juice', quantity: '2 tbsp' }],
  instructions: ['Drain and rinse the chickpeas.', 'Toss with lemon juice and serve.'],
  tags: ['vegetarian', 'quick'], category: 'Mains', servings: 2, totalMinutes: 15,
  photoURL: 'https://images.example.test/chickpeas.png', imageKind: 'ai-generated',
});
const generator = () => mock(async ({ recipeId }: { recipeId: string }) => generated(recipeId));
const storedRecipes = (docs: Map<string, Data>) => [...docs.entries()].filter(([key]) => /^recipes\/[^/]+$/.test(key));

describe('scheduled curated Discover', () => {
  test('plans 3–5 stable irregular quarter-hour windows with a future refresh time', () => {
    for (let day = 0; day < 60; day++) {
      const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
      const plan = discoveryWindows(date);
      expect(plan.length).toBeGreaterThanOrEqual(3);
      expect(plan.length).toBeLessThanOrEqual(5);
      expect(discoveryWindows(date)).toEqual(plan);
      expect(new Set(plan.map(window => window.at)).size).toBe(plan.length);
      expect(plan.every(window => window.at % 900_000 === 0)).toBe(true);
      expect(plan.every(window => new Date(window.at).toISOString().startsWith(date))).toBe(true);
    }
    expect(discoveryTiming(start).due).toBeNull();
    expect(discoveryTiming(start).next.at).toBeGreaterThan(start);
    const last = discoveryWindows('2026-09-20').at(-1)!;
    expect(discoveryTiming(last.at + 1).next.at).toBeGreaterThan(start + 86_400_000);
  });
  test('atomically bootstraps 12 original recipes into four real browsable cookbooks', async () => {
    const db = database();
    const generateRecipe = generator();
    const result = await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start });
    expect(result).toEqual({ status: 'published', editionId: 'bootstrap-v1', generatedCount: 12 });
    expect(generateRecipe).toHaveBeenCalledTimes(12);
    expect(db.identities.createUser).toHaveBeenCalledTimes(4);
    for (const creator of CURATED_CREATORS) {
      const account = db.users.get(creator.uid)!;
      expect(account.disabled).toBe(true);
      expect(account.email).toBeUndefined();
      expect(account.password).toBeUndefined();
      const profile = db.documents.get(`users/${creator.uid}`)!;
      expect(profile).toMatchObject({ profileKind: 'curated', recipeCount: 3, followerCount: 0, followingCount: 0 });
      expect([...db.documents.keys()].filter(key => key.startsWith(`users/${creator.uid}/cookbook/`))).toHaveLength(3);
    }
    const recipes = storedRecipes(db.documents);
    expect(recipes).toHaveLength(12);
    for (const [, recipe] of recipes) {
      expect(recipe).toMatchObject({ visibility: 'public', contentOrigin: 'ai-curated', popularity: { likes: 0, cookbooks: 0 }, publishedAt: new Date(start).toISOString() });
      expect(recipe.sourceUrl).toBeUndefined();
      expect(recipe.sourceKey).toBeUndefined();
      expect(recipe.sourceAuthor).toBeUndefined();
      expect(recipe.createdAt).toEqual(new Date(start));
    }
    expect(db.documents.get('discovery/state')?.activeEditionId).toBe('bootstrap-v1');
    expect((await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start })).status).toBe('not-due');
    expect(generateRecipe).toHaveBeenCalledTimes(12);
  });
  test('retains staged successes and resumes bootstrap without repaying for completed drafts', async () => {
    const db = database();
    let rejectFirst = true;
    const generateRecipe = mock(async ({ recipeId }: { recipeId: string }) => {
      if (rejectFirst && recipeId.endsWith('-0')) throw new Error('Secret-bearing provider diagnostic');
      return generated(recipeId);
    });
    const run = () => runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start });
    await expect(run()).rejects.toThrow('previous edition remains live');
    expect(storedRecipes(db.documents)).toHaveLength(0);
    expect(db.documents.get('discovery/state')?.activeEditionId).toBeUndefined();
    expect(db.documents.has('discoveryDrafts/curated-bootstrap-v1-1')).toBe(true);
    expect(JSON.stringify(db.documents.get('discoveryRuns/bootstrap-v1'))).not.toContain('Secret-bearing');
    rejectFirst = false;
    expect((await run()).status).toBe('published');
    expect(generateRecipe).toHaveBeenCalledTimes(13);
    expect(storedRecipes(db.documents)).toHaveLength(12);
  });
  test('refreshes throughout a day while reserving at most six fresh recipes', async () => {
    const db = database();
    const generateRecipe = generator();
    await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start });
    for (const window of discoveryWindows('2026-09-20')) {
      const now = () => window.at + 1;
      expect((await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now })).status).toBe('published');
      expect((await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now })).status).toBe('not-due');
    }
    expect(storedRecipes(db.documents)).toHaveLength(18);
    expect(generateRecipe).toHaveBeenCalledTimes(18);
    expect(db.documents.get('discoveryDays/2026-09-20')).toMatchObject({ reservedRecipes: 6, generationAttempts: 6 });
  });
  test('a failed refresh keeps the published edition and existing ownership/social counts intact', async () => {
    const db = database();
    db.documents.set('users/community-person', { followerCount: 7 });
    db.documents.set('recipes/community-recipe', { createdBy: 'community-person', name: 'Original' });
    await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: generator(), repository: db.repository, now: () => start });
    const creatorUid = CURATED_CREATORS[0]!.uid;
    db.documents.set(`users/${creatorUid}`, { ...db.documents.get(`users/${creatorUid}`), followerCount: 9 });
    const before = db.documents.get('discovery/state')?.activeEditionId;
    await expect(runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: async () => { throw new Error('Provider failed'); }, repository: db.repository, now: () => discoveryWindows('2026-09-20')[0]!.at + 1 })).rejects.toThrow();
    expect(db.documents.get('discovery/state')?.activeEditionId).toBe(before);
    expect(db.documents.get(`users/${creatorUid}`)?.followerCount).toBe(9);
    expect(db.documents.get('recipes/community-recipe')).toEqual({ createdBy: 'community-person', name: 'Original' });
    expect(db.documents.get('users/community-person')).toEqual({ followerCount: 7 });
  });
  test('recovers a missed day before the next planned window without publishing that slot twice', async () => {
    const db = database();
    const generateRecipe = generator();
    await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start });
    const tomorrow = start + 86_400_000;
    const first = discoveryWindows('2026-09-21')[0]!;
    expect(first.at).toBeGreaterThan(tomorrow);
    const recovered = await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => tomorrow });
    expect(recovered).toMatchObject({ status: 'published', editionId: first.id, generatedCount: 2 });
    expect((await runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => first.at + 1 })).status).toBe('not-due');
    expect(Date.parse(db.documents.get('discovery/state')!.nextRefreshAt)).toBeGreaterThan(first.at);
  });
  test('duplicate deliveries share a global lease and expired owners cannot publish or release it', async () => {
    const db = database();
    const first = await db.repository.acquire(start) as DiscoveryLease;
    expect(await db.repository.acquire(start + 1)).toBe('busy');
    const replacement = await db.repository.acquire(start + 16 * 60_000) as DiscoveryLease;
    expect(replacement.token).not.toBe(first.token);
    await expect(db.repository.reserveAttempt(first, first.recipeIds[0]!, start + 16 * 60_000)).rejects.toThrow('lease expired');
    await db.repository.fail(first, start + 16 * 60_000);
    expect(db.documents.get('discovery/state')?.leaseToken).toBe(replacement.token);
  });
  test('limits paid attempts and allows a failed bootstrap to recover on a later day', async () => {
    const db = database();
    const first = await db.repository.acquire(start) as DiscoveryLease;
    const id = first.recipeIds[0]!;
    await db.repository.reserveAttempt(first, id, start);
    await db.repository.reserveAttempt(first, id, start);
    await expect(db.repository.reserveAttempt(first, id, start)).rejects.toThrow('budget exhausted');
    await db.repository.fail(first, start);
    const tomorrow = await db.repository.acquire(start + 86_400_000) as DiscoveryLease;
    await db.repository.reserveAttempt(tomorrow, id, start + 86_400_000);
    expect(db.documents.get('discoveryDays/2026-09-21')?.bootstrapGenerationAttempts).toBe(1);
  });
  test('UTC rollover replaces all exhausted slot counters despite Firestore recursive map merges', async () => {
    const db = database();
    const first = await db.repository.acquire(start) as DiscoveryLease;
    const [firstId, secondId] = first.recipeIds as [string, string, ...string[]];
    for (const id of [firstId, secondId]) {
      await db.repository.reserveAttempt(first, id, start);
      await db.repository.reserveAttempt(first, id, start);
      await expect(db.repository.reserveAttempt(first, id, start)).rejects.toThrow('budget exhausted');
    }
    await db.repository.fail(first, start);
    const nextDay = start + 86_400_000;
    const resumed = await db.repository.acquire(nextDay) as DiscoveryLease;
    await db.repository.reserveAttempt(resumed, firstId, nextDay);
    expect(db.documents.get('discoveryRuns/bootstrap-v1')?.attempts).toEqual({ [firstId]: 1 });
    await db.repository.reserveAttempt(resumed, secondId, nextDay);
    expect(db.documents.get('discoveryRuns/bootstrap-v1')).toMatchObject({
      attemptDay: '2026-09-21', attempts: { [firstId]: 1, [secondId]: 1 },
      recipeIds: first.recipeIds, leaseToken: resumed.token, status: 'running',
    });
    expect(db.documents.get('discoveryDays/2026-09-20')?.bootstrapGenerationAttempts).toBe(4);
    expect(db.documents.get('discoveryDays/2026-09-21')?.bootstrapGenerationAttempts).toBe(2);
  });
  test('rejects duplicate normalized titles without publishing a partial edition', async () => {
    const db = database();
    await expect(runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: async () => generated('same'), repository: db.repository, now: () => start })).rejects.toThrow();
    expect(storedRecipes(db.documents)).toHaveLength(0);
    expect(db.documents.get('discovery/state')?.activeEditionId).toBeUndefined();
    expect(curatedTitleKey('Café: Lemon!')).toBe(curatedTitleKey('Cafe lemon'));
  });
  test('cannot appropriate a pre-existing recipe with a colliding managed ID', async () => {
    const db = database();
    db.documents.set('recipes/curated-bootstrap-v1-0', { createdBy: 'real-person', name: 'Keep mine' });
    await expect(runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: generator(), repository: db.repository, now: () => start })).rejects.toThrow();
    expect(db.documents.get('recipes/curated-bootstrap-v1-0')).toEqual({ createdBy: 'real-person', name: 'Keep mine' });
    expect(db.documents.get('discovery/state')?.activeEditionId).toBeUndefined();
  });
  test('a published edition respects private recipes and personal hides at read time', async () => {
    const db = database();
    const lease = await db.repository.acquire(start) as DiscoveryLease;
    const recipes = Array.from({ length: 12 }, (_, index) => ({ ...generated(String(index)), id: String(index), createdBy: CURATED_CREATORS[index % 4]!.uid, contentOrigin: 'ai-curated', visibility: 'public' } as Recipe));
    const edition = composeDiscoveryEdition(lease, recipes, CURATED_CREATORS, start);
    const privateId = recipes.find(recipe => recipe.id !== edition.heroRecipeId)!.id;
    const content = materializeDiscovery(edition, recipes.map(recipe => ({ ...recipe, visibility: recipe.id === privateId ? 'private' : 'public' })), new Set([edition.heroRecipeId]));
    expect(content.heroRecipe?.id).not.toBe(edition.heroRecipeId);
    const visibleIds = content.collections!.flatMap(collection => collection.recipes.map(recipe => recipe.id));
    expect(visibleIds).not.toContain(privateId);
    expect(visibleIds).not.toContain(edition.heroRecipeId);
    expect(content.edition?.id).toBe(lease.runId);
  });
  test('curated profile metadata requires the explicit server kind and does not leak other fields', () => {
    expect(curatedProfileFields({ bio: 'Fake badge', specialty: 'Anything' })).toEqual({ profileKind: 'community' });
    expect(curatedProfileFields({ profileKind: 'curated', handle: 'maya.green', bio: 'Fictional Fridgie curator', accent: 'sage', privateToken: 'hidden' })).toEqual({ profileKind: 'curated', handle: 'maya.green', bio: 'Fictional Fridgie curator', accent: 'sage' });
  });
  test('keeps only allowlisted diagnostics, never provider bodies, raw messages or unknown reason strings', () => {
    for (const [status, code] of [[429, 'PROVIDER_RATE_LIMITED'], [401, 'PROVIDER_ACCESS_DENIED'], [403, 'PROVIDER_ACCESS_DENIED'], [400, 'PROVIDER_REQUEST_REJECTED'], [408, 'PROVIDER_TIMEOUT'], [504, 'PROVIDER_TIMEOUT'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
      const failure = safeDiscoveryFailure({ status, message: 'API key and model response secret', body: { key: 'hidden' }, reason: 'unsafe response text', code: 'untrusted raw code' }, 'generation', 'curated-bootstrap-v1-0');
      expect(failure).toEqual({ code, status, phase: 'generation', recipeId: 'curated-bootstrap-v1-0' });
      expect(JSON.stringify(failure)).not.toContain('secret');
    }
    expect(safeDiscoveryFailure(new Error('Raw model response'), 'publication')).toEqual({ code: 'GENERATION_FAILED', phase: 'publication' });
    expect(safeDiscoveryFailure({ name: 'APIConnectionTimeoutError' })).toEqual({ code: 'PROVIDER_TIMEOUT', phase: 'generation' });
    expect(safeDiscoveryFailure({ code: 7 }, 'staging')).toEqual({ code: 'BACKEND_PERMISSION_DENIED', phase: 'staging' });
    expect(safeDiscoveryFailure(new Error('Claude hit the output limit before finishing the JSON.'))).toEqual({ code: 'MODEL_OUTPUT_INVALID', phase: 'generation' });
    expect(safeDiscoveryFailure({ code: 'INVALID_RECIPE', reason: 'instructions.count' })).toEqual({ code: 'INVALID_RECIPE', reason: 'instructions.count', phase: 'generation' });
    expect(safeDiscoveryFailure({ status: 123456, reason: 'name', code: 'INVALID_RECIPE' }, 'generation', 'https://secret.example')).toEqual({ code: 'INVALID_RECIPE', reason: 'name', phase: 'generation' });
  });
  test('preserves a validator failure through allSettled while awaiting and retaining the successful sibling draft', async () => {
    const db = database();
    const generateRecipe = async ({ recipeId }: { recipeId: string }) => {
      if (recipeId.endsWith('-0')) throw new CuratedGenerationError('INVALID_RECIPE', 'ingredients.count');
      return generated(recipeId);
    };
    await expect(runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe, repository: db.repository, now: () => start })).rejects.toThrow('INVALID_RECIPE');
    expect(db.documents.get('discoveryRuns/bootstrap-v1')).toMatchObject({ status: 'failed', error: 'INVALID_RECIPE', failure: { code: 'INVALID_RECIPE', phase: 'generation', recipeId: 'curated-bootstrap-v1-0', reason: 'ingredients.count' } });
    expect(db.documents.has('discoveryDrafts/curated-bootstrap-v1-1')).toBe(true);
    expect(db.documents.get('discovery/state')?.leaseUntil).toBe(0);
    expect(storedRecipes(db.documents)).toHaveLength(0);
  });
  test('records safe provider status for live failure diagnosis without publishing any partial recipe', async () => {
    const db = database();
    await expect(runDiscoveryTick({ creators: CURATED_CREATORS, generateRecipe: async () => { throw Object.assign(new Error('Sensitive request body'), { status: 429, request: { apiKey: 'sensitive' } }); }, repository: db.repository, now: () => start })).rejects.toThrow('PROVIDER_RATE_LIMITED');
    expect(db.documents.get('discoveryRuns/bootstrap-v1')?.failure).toEqual({ code: 'PROVIDER_RATE_LIMITED', status: 429, phase: 'generation', recipeId: 'curated-bootstrap-v1-0' });
    expect(JSON.stringify(db.documents.get('discoveryRuns/bootstrap-v1'))).not.toContain('sensitive');
    expect(db.documents.get('discovery/state')?.activeEditionId).toBeUndefined();
  });
});
