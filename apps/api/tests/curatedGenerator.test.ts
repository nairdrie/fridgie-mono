import { describe, expect, mock, test } from 'bun:test';
import { CURATED_CREATORS, CURATED_GENERATION_REASONS, createCuratedRecipeGenerator, validateCuratedRecipe } from '../utils/curatedGenerator';

const draft = () => ({
  name: 'Lemon chickpea skillet', description: 'Tender chickpeas and vegetables in a bright lemon sauce, finished with fresh parsley.',
  ingredients: [
    { name: 'chickpeas, drained', quantity: '2 cans (400 g each)' },
    { name: 'zucchini, diced', quantity: '1 medium' },
    { name: 'olive oil', quantity: '1 tbsp' },
    { name: 'lemon juice', quantity: '2 tbsp' },
    { name: 'parsley, chopped', quantity: '2 tbsp' },
  ],
  instructions: ['Drain the chickpeas and dice the zucchini.', 'Heat the oil in a skillet over medium heat.', 'Add the zucchini and cook for 6 minutes; add chickpeas and warm for 4 minutes.', 'Stir in lemon juice, scatter with parsley and serve warm.'],
  category: 'Mains', tags: ['vegetarian', 'weeknight'], servings: 2, totalMinutes: 20,
});
const request = () => ({ creator: CURATED_CREATORS[0]!, recipeId: 'curated-2026-09-20-0', seed: '2026-09-20:0', recentTitles: [] });
function setup(overrides: Parameters<typeof createCuratedRecipeGenerator>[0] = {}) {
  const completeJson = mock(async (_options: unknown) => draft());
  const generateImage = mock(async () => ({ photoURL: 'https://firebasestorage.googleapis.com/fixture.png', imageKind: 'ai-generated' as const }));
  const warn = mock(() => {});
  return { completeJson, generateImage, warn, generate: createCuratedRecipeGenerator({ model: async () => 'fixture-model', completeJson, generateImage, warn, ...overrides }) };
}

describe('curated generation boundaries', () => {
  test('provides four distinct fictional creators without real portraits or login details', () => {
    expect(CURATED_CREATORS).toHaveLength(4);
    expect(new Set(CURATED_CREATORS.map(item => item.uid)).size).toBe(4);
    for (const item of CURATED_CREATORS) {
      expect(item.uid).toStartWith('curated-');
      expect(item.bio).toContain('fictional');
      expect(item.photoURL).toBeUndefined();
      expect(item).not.toHaveProperty('email');
      expect(item).not.toHaveProperty('password');
    }
  });
  test('keeps a complete valid draft and drops model-supplied ownership and fake sources', async () => {
    const { generate } = setup({ completeJson: async () => ({ ...draft(), createdBy: 'attacker', sourceUrl: 'https://example.com/stolen', popularity: { likes: 200 }, photoURL: 'https://example.com/untrusted.png' }) });
    const result = await generate(request());
    expect(result.name).toBe(draft().name);
    expect(result.imageKind).toBe('ai-generated');
    expect(result.photoURL).toBe('https://firebasestorage.googleapis.com/fixture.png');
    expect(result).not.toHaveProperty('createdBy');
    expect(result).not.toHaveProperty('sourceUrl');
    expect(result).not.toHaveProperty('popularity');
  });
  test('passes hard per-call limits and calls each provider once', async () => {
    const { generate, completeJson, generateImage } = setup();
    await generate(request());
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(completeJson.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 90_000, maxRetries: 0, maxTokens: 4000 });
  });
  test.each([8, 12])('accepts an Olive baking batch for %i people without rescaling its ingredients', async servings => {
    const bakedDraft = {
      name: 'Lemon shortbread cookies',
      description: `Buttery lemon shortbread makes 24 cookies, with ${24 / servings} cookies per serving for ${servings} people.`,
      ingredients: [
        { name: 'all-purpose flour', quantity: '280 g' },
        { name: 'unsalted butter, softened', quantity: '225 g' },
        { name: 'caster sugar', quantity: '100 g' },
        { name: 'lemon zest', quantity: '1 tbsp' },
        { name: 'fine salt', quantity: '1/4 tsp' },
      ],
      instructions: [
        'Heat the oven to 170 C / 340 F and line two baking trays.',
        'Cream the butter and sugar for 2 minutes, then stir in the lemon zest and salt.',
        'Mix in the flour to form a dough. Divide into 24 balls and flatten on the trays, leaving 3 cm between cookies.',
        'Bake for 18 to 20 minutes until the edges are pale gold. Cool on the trays for 10 minutes before serving.',
      ],
      category: 'Baked Goods', tags: ['baking', 'lemon'], servings, totalMinutes: 45,
    };
    const { generate, generateImage } = setup({ completeJson: async () => bakedDraft });
    const result = await generate({ ...request(), creator: CURATED_CREATORS[3]! });
    expect(result.servings).toBe(servings);
    expect(result.ingredients).toEqual(bakedDraft.ingredients);
    expect(result.description).toContain('24 cookies');
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
  test('keeps numeric schema enums, prompt limits and validation in agreement', async () => {
    const { generate, completeJson } = setup();
    await generate(request());
    const options = completeJson.mock.calls[0]?.[0] as { system: string; schema: { properties: Record<string, unknown> } };
    expect(options.schema.properties.servings).toEqual({ type: 'integer', enum: Array.from({ length: 23 }, (_, index) => index + 2) });
    expect(options.schema.properties.totalMinutes).toEqual({ type: 'integer', enum: Array.from({ length: 171 }, (_, index) => index + 10) });
    expect(options.system).toContain('2 to 24 servings');
    expect(options.system).toContain('whole number from 10 to 180');
    expect(options.system).toContain('servings counts people');
    for (const servings of [2, 24]) {
      for (const totalMinutes of [10, 180]) {
        expect(validateCuratedRecipe({ ...draft(), servings, totalMinutes })).toMatchObject({ servings, totalMinutes });
      }
    }
  });
  test('rejects out-of-range and noninteger numbers without coercion or image calls', async () => {
    for (const [field, invalid] of [
      ['servings', [-1, 0, 1, 25, 2.5, '12', null, undefined, NaN, Infinity]],
      ['totalMinutes', [-1, 0, 9, 181, 10.5, '45', null, undefined, NaN, Infinity]],
    ] as const) {
      for (const value of invalid) {
        const { generate, generateImage } = setup({ completeJson: async () => ({ ...draft(), [field]: value }) });
        await expect(generate(request())).rejects.toMatchObject({ code: 'INVALID_RECIPE', reason: field });
        expect(generateImage).not.toHaveBeenCalled();
      }
    }
  });
  test('rejects duplicate titles before spending image quota', async () => {
    const { generate, generateImage } = setup();
    await expect(generate({ ...request(), recentTitles: ['LÉMON—CHICKPEA SKILLET!'] })).rejects.toThrow('DUPLICATE_RECIPE');
    expect(generateImage).not.toHaveBeenCalled();
  });
  test('rejects incomplete or implausible model drafts before generating images', async () => {
    for (const bad of [null, { ...draft(), servings: 0 }, { ...draft(), totalMinutes: 900 }, { ...draft(), ingredients: [] }, { ...draft(), instructions: ['Cook it.'] }, { ...draft(), category: 'Dinner' }, { ...draft(), description: 'Get the recipe at https://example.com' }]) {
      const { generate, generateImage } = setup({ completeJson: async () => bad });
      await expect(generate(request())).rejects.toThrow('INVALID_RECIPE');
      expect(generateImage).not.toHaveBeenCalled();
    }
  });
  test('does not retry failed text generation or spend image quota', async () => {
    const model = mock(async () => { throw new Error('Provider timeout'); });
    const { generate, generateImage } = setup({ completeJson: model });
    await expect(generate(request())).rejects.toThrow('Provider timeout');
    expect(model).toHaveBeenCalledTimes(1);
    expect(generateImage).not.toHaveBeenCalled();
  });
  test('uses clearly labelled public stock fallback after an image error without leaking it', async () => {
    const { generate, warn } = setup({ generateImage: async () => { throw new Error('SECRET-IN-PROVIDER-ERROR'); } });
    const result = await generate(request());
    expect(result.imageKind).toBe('illustrative-stock');
    expect(result.photoURL).toStartWith('https://images.pexels.com/');
    expect(result.imageAttribution?.label).toContain('Illustrative');
    expect(result.imageAttribution?.url).toStartWith('https://www.pexels.com/');
    expect(result).not.toHaveProperty('sourceUrl');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-IN-PROVIDER-ERROR');
  });
  test('rejects unsafe image result and invalid storage object IDs', async () => {
    const { generate, completeJson } = setup({ generateImage: async () => ({ photoURL: 'file:///tmp/photo.png', imageKind: 'ai-generated' }) });
    expect((await generate(request())).imageKind).toBe('illustrative-stock');
    await expect(generate({ ...request(), recipeId: '../outside' })).rejects.toThrow('INVALID_REQUEST');
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
  test('rejects duplicate ingredient rows rather than publishing ambiguous amounts', () => {
    const recipe = draft();
    recipe.ingredients[4] = recipe.ingredients[0]!;
    expect(() => validateCuratedRecipe(recipe)).toThrow('INVALID_RECIPE');
  });
  test('reports only controlled constraint names, never rejected model text', () => {
    const cases = [
      [{ ...draft(), ingredients: [] }, 'ingredients.count'],
      [{ ...draft(), servings: 25 }, 'servings'],
      [{ ...draft(), instructions: [...draft().instructions.slice(0, 3), 'PRIVATE_MODEL_TEXT'.repeat(50)] }, 'instructions.item'],
      [{ ...draft(), totalMinutes: 300 }, 'totalMinutes'],
      [{ ...draft(), tags: ['same', 'same'] }, 'tags.unique'],
    ] as const;
    for (const [value, reason] of cases) {
      let error: any;
      try { validateCuratedRecipe(value); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'INVALID_RECIPE', reason });
      expect(CURATED_GENERATION_REASONS).toContain(error.reason);
      expect(JSON.stringify(error)).not.toContain('PRIVATE_MODEL_TEXT');
    }
  });
});
