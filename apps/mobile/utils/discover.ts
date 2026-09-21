import type { ExploreCollection, ExploreContent, Recipe } from '@/types/types';

/** Stable source order, without giving recipes repeated in several shelves extra weight. */
export function discoverRecipes(content: ExploreContent | null): Recipe[] {
  const seen = new Set<string>();
  return [
    ...(content?.heroRecipe ? [content.heroRecipe] : []),
    ...(content?.collections ?? []).flatMap(collection => collection.recipes),
    ...(content?.trending ?? []),
    ...(content?.newest ?? []),
  ].filter(recipe => {
    if (!recipe?.id || seen.has(recipe.id)) return false;
    seen.add(recipe.id);
    return true;
  });
}

/** Older API versions still provide a useful feed during a rolling release. */
export function discoverCollections(content: ExploreContent | null): ExploreCollection[] {
  const curated = content?.collections?.filter(collection => collection.recipes?.length);
  if (curated?.length) {
    // Editorial shelves supplement the community feed. Do not let a new
    // edition hide people's recipes, or repeat the same imported source in it.
    const alreadyFeatured = [...curated.flatMap(collection => collection.recipes), ...(content?.heroRecipe ? [content.heroRecipe] : [])];
    const seenIds = new Set(alreadyFeatured.map(recipe => recipe.id));
    const seenSources = new Set(alreadyFeatured.map(recipe => recipe.sourceKey).filter(Boolean));
    const community = [...(content?.trending ?? []), ...(content?.newest ?? [])].filter(recipe => {
      if (!recipe?.id || recipe.contentOrigin === 'ai-curated' || seenIds.has(recipe.id) || (recipe.sourceKey && seenSources.has(recipe.sourceKey))) return false;
      seenIds.add(recipe.id);
      if (recipe.sourceKey) seenSources.add(recipe.sourceKey);
      return true;
    });
    return community.length
      ? [...curated, { id: 'from-the-community', title: 'From the community', accent: 'peach', recipes: community }]
      : curated;
  }
  const collections: ExploreCollection[] = [];
  if (content?.trending?.length) collections.push({ id: 'community-picks', title: 'Worth staying in for', accent: 'sage', recipes: content.trending });
  if (content?.newest?.length) collections.push({ id: 'new-in', title: 'Fresh from the kitchen', accent: 'peach', recipes: content.newest });
  return collections;
}

export function surpriseRecipe(recipes: Recipe[], previousId?: string | null, random = Math.random): Recipe | null {
  const choices = recipes.length > 1 ? recipes.filter(recipe => recipe.id !== previousId) : recipes;
  if (!choices.length) return null;
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))];
}

/** Publication time, rather than opening time, determines whether an edition is fresh. */
export function discoverEditionLabel(publishedAt?: string, now = new Date()): string {
  if (!publishedAt) return 'The Discover edit';
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime()) || date > now) return 'The Discover edit';
  if (date.toDateString() === now.toDateString()) return 'Fresh today';
  return `${date.toLocaleDateString('en', { month: 'short', day: 'numeric' })} edition`;
}

export function recipeQuickDetails(recipe: Recipe): string {
  const details: string[] = [];
  if (typeof recipe.totalMinutes === 'number' && Number.isFinite(recipe.totalMinutes) && recipe.totalMinutes > 0) details.push(`${Math.round(recipe.totalMinutes)} min`);
  if (typeof recipe.servings === 'number' && recipe.servings > 0) details.push(`Serves ${recipe.servings}`);
  return details.join(' · ') || recipe.category || 'Recipe inspiration';
}
