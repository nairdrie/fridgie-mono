import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createRecipeSaveHandler } from '../api/recipe';

const base = { name: 'Lemon chickpeas', ingredients: [{ name: 'chickpeas', quantity: '1 can' }], instructions: ['Toss and serve.'], createdBy: 'curated-maya-green', contentOrigin: 'ai-curated', curatedCreatorUid: 'curated-maya-green', publishedAt: '2026-09-20T00:00:00Z', popularity: { likes: 5 }, ratingCount: 3, ratingTotal: 14, photoURL: 'https://images.example.test/generated.png', imageKind: 'ai-generated', visibility: 'public' };
function setup(existing: Record<string, any> | null = base) {
  let written: Record<string, any> | null = null;
  const database = { collection: () => ({
    add: async (value: any) => { written = value; return { id: 'new-user-fork' }; },
    doc: () => ({ get: async () => ({ exists: !!existing, data: () => existing }), set: async (value: any) => { written = value; }, update: async (value: any) => { written = value; } }),
  }) };
  const app = new Hono().use('*', async (c, next) => { c.set('uid', 'real-user'); await next(); }).post('/', createRecipeSaveHandler(database as any));
  return { request: (body: any) => app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), written: () => written };
}

describe('recipe curation provenance HTTP contract', () => {
  test('forks curated recipes into adapted user recipes, retaining ancestry without the official badge', async () => {
    const { request, written } = setup();
    const response = await request({ id: 'curated-root', name: 'My version', contentOrigin: 'ai-curated', curatedCreatorUid: 'forged' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: 'new-user-fork', createdBy: 'real-user', contentOrigin: 'ai-adapted', curatedCreatorUid: 'curated-maya-green', forkedFromId: 'curated-root', name: 'My version', imageKind: 'ai-generated' });
    expect(written()?.popularity).toBeUndefined();
    expect(written()?.ratingCount).toBeUndefined();
    expect(written()?.ratingTotal).toBeUndefined();
  });
  test('a further fork retains the original root and adapted origin', async () => {
    const { request } = setup({ ...base, createdBy: 'another-user', contentOrigin: 'ai-adapted', forkedFromId: 'curated-root' });
    expect(await (await request({ id: 'existing-fork', name: 'My adaptation' })).json()).toMatchObject({ contentOrigin: 'ai-adapted', forkedFromId: 'curated-root', curatedCreatorUid: 'curated-maya-green' });
  });
  test('an owner edit cannot promote an adapted recipe back to official curation', async () => {
    const { request } = setup({ ...base, createdBy: 'real-user', contentOrigin: 'ai-adapted', forkedFromId: 'curated-root' });
    expect(await (await request({ id: 'existing-fork', contentOrigin: 'ai-curated', curatedCreatorUid: 'forged', name: 'Edited again' })).json()).toMatchObject({ contentOrigin: 'ai-adapted', curatedCreatorUid: 'curated-maya-green', name: 'Edited again' });
  });
  test('ordinary creates cannot claim managed curation or image labels', async () => {
    const { request, written } = setup(null);
    expect((await request({ name: 'Own recipe', contentOrigin: 'ai-curated', curatedCreatorUid: 'curated-maya-green', publishedAt: 'Yesterday', imageKind: 'ai-generated', imageAttribution: { label: 'Fake', url: 'https://example.test' } })).status).toBe(201);
    for (const field of ['contentOrigin', 'curatedCreatorUid', 'publishedAt', 'imageKind', 'imageAttribution']) expect(written()?.[field]).toBeUndefined();
  });
  test('replacing the image removes inherited image provenance from fork and owner edits', async () => {
    for (const createdBy of ['curated-maya-green', 'real-user']) {
      const { request } = setup({ ...base, createdBy });
      const response = await request({ id: 'recipe-id', photoURL: 'https://images.example.test/my-photo.jpg', imageKind: 'ai-generated' });
      const result = await response.json();
      expect(result.photoURL).toBe('https://images.example.test/my-photo.jpg');
      expect(result.imageKind).toBeUndefined();
      expect(result.imageAttribution).toBeUndefined();
    }
  });
  test('clients cannot preempt a future curated recipe identifier', async () => {
    const { request, written } = setup(null);
    expect((await request({ id: 'curated-bootstrap-v1-0', name: 'Claim this ID' })).status).toBe(400);
    expect(written()).toBeNull();
  });
});
