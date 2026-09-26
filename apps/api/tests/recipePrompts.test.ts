import { describe, expect, test } from 'bun:test';
import {
  photoParsingSystemPrompt,
  quantityFormatRules,
  recipeSchema,
} from '../utils/recipePrompts';

describe('shared imported-recipe quantity contract', () => {
  test('requires source-unit fidelity instead of equivalent-unit conversion', () => {
    expect(quantityFormatRules).toContain('preserve the measurement unit used by the source');
    expect(quantityFormatRules).toContain('Canonicalize its spelling only');
    expect(quantityFormatRules).toContain('do not turn tsp, tbsp, or cup into ml or l');

    const quantity = recipeSchema.properties.ingredients.items.properties.quantity;
    expect(quantity.description).toContain("Preserve an imported source's unit");
    expect(quantity.description).toContain('never convert it to an equivalent unit');
  });

  test('photo imports receive the same source-unit rules as URL and social imports', () => {
    expect(photoParsingSystemPrompt).toContain(quantityFormatRules);
    expect(photoParsingSystemPrompt).toContain('preserve the measurement unit used by the source');
  });
});
