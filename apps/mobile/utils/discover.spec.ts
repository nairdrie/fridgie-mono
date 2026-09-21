import { describe, expect, test } from 'bun:test';
import { discoverCollections, discoverEditionLabel, discoverRecipes, recipeQuickDetails, surpriseRecipe } from './discover';
import type { ExploreContent, Recipe } from '../types/types';

const recipe = (id: string): Recipe => ({ id, name: id, description: '', ingredients: [], instructions: [] });

describe('Discover editions and choices', () => {
  test('a recipe on several shelves is one surprise choice, while every real recipe remains reachable', () => {
    const content: ExploreContent = {
      heroRecipe: recipe('a'),
      collections: [{ id: 'quick', title: 'Quick meals', accent: 'sage', recipes: [recipe('a'), recipe('b')] }],
      trending: [recipe('b'), recipe('c')], newest: [recipe('d')],
    };
    const choices = discoverRecipes(content);
    expect(choices.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(surpriseRecipe(choices, 'a', () => 0)?.id).toBe('b');
    expect(surpriseRecipe(choices, 'a', () => 0.99)?.id).toBe('d');
  });
  test('empty and one-recipe feeds remain usable', () => {
    expect(discoverRecipes(null)).toEqual([]);
    expect(surpriseRecipe([])).toBeNull();
    expect(surpriseRecipe([recipe('only')], 'only')?.id).toBe('only');
  });
  test('legacy API responses remain browsable without a curated edition', () => {
    expect(discoverCollections({ trending: [recipe('a')], newest: [recipe('b')] }).map(item => item.recipes[0].id)).toEqual(['a', 'b']);
    expect(discoverCollections({ collections: [], newest: [recipe('b')] })[0].id).toBe('new-in');
  });
  test('curated editions retain community recipes without duplicate imports or AI entries', () => {
    const ai = { ...recipe('curated'), contentOrigin: 'ai-curated' as const };
    const collections = discoverCollections({
      heroRecipe: recipe('hero'),
      collections: [{ id: 'plant', title: 'Plant-forward', accent: 'sage', recipes: [ai] }],
      trending: [ai, recipe('hero'), { ...recipe('shared'), sourceKey: 'tiktok:123' }, recipe('original')],
      newest: [{ ...recipe('another-copy'), sourceKey: 'tiktok:123' }, recipe('original'), recipe('new'), { ...recipe('adapted-by-user'), contentOrigin: 'ai-adapted' }],
    });
    expect(collections.map(collection => collection.id)).toEqual(['plant', 'from-the-community']);
    expect(collections[1].recipes.map(item => item.id)).toEqual(['shared', 'original', 'new', 'adapted-by-user']);
  });
  test('an edition without community recipes does not display an empty community shelf', () => {
    const ai = { ...recipe('curated'), contentOrigin: 'ai-curated' as const };
    expect(discoverCollections({ collections: [{ id: 'plant', title: 'Plant-forward', accent: 'sage', recipes: [ai] }], trending: [ai] }).map(item => item.id)).toEqual(['plant']);
  });
  test('old or invalid publication timestamps never claim to be fresh today', () => {
    const now = new Date('2026-09-20T15:00:00');
    expect(discoverEditionLabel('2026-09-20T10:00:00', now)).toBe('Fresh today');
    expect(discoverEditionLabel('2026-09-19T10:00:00', now)).toBe('Sep 19 edition');
    expect(discoverEditionLabel('2026-09-21T10:00:00', now)).toBe('The Discover edit');
    expect(discoverEditionLabel('invalid', now)).toBe('The Discover edit');
  });
  test('recipe cards do not invent times or servings', () => {
    expect(recipeQuickDetails(recipe('a'))).toBe('Recipe inspiration');
    expect(recipeQuickDetails({ ...recipe('a'), totalMinutes: 25, servings: 2 })).toBe('25 min · Serves 2');
    expect(recipeQuickDetails({ ...recipe('a'), totalMinutes: NaN, servings: 0 })).toBe('Recipe inspiration');
  });
});
