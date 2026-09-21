import { fs } from './firebase';
import { publicProfiles } from './publicProfiles';
import type { ExploreContent, ExploreCreator, Recipe } from './types';
import type { StoredDiscoveryEdition } from './discovery';

/** Project IDs against current recipe visibility; editions never bypass hides. */
export function materializeDiscovery(edition: StoredDiscoveryEdition, recipes: Recipe[], hidden = new Set<string>()): Pick<ExploreContent, 'edition' | 'heroRecipe' | 'collections'> {
  const byId = new Map(recipes.filter(recipe => recipe.visibility !== 'private' && !hidden.has(recipe.id) && recipe.contentOrigin === 'ai-curated').map(recipe => [recipe.id, recipe]));
  const collections = edition.collections.map(collection => ({
    id: collection.id, title: collection.title, subtitle: collection.subtitle, accent: collection.accent,
    recipes: collection.recipeIds.map(id => byId.get(id)).filter((recipe): recipe is Recipe => !!recipe),
  })).filter(collection => collection.recipes.length > 0);
  const heroRecipe = byId.get(edition.heroRecipeId) ?? collections[0]?.recipes[0];
  return {
    edition: { id: edition.id, title: edition.title, subtitle: edition.subtitle, publishedAt: edition.publishedAt, ...(edition.nextRefreshAt ? { nextRefreshAt: edition.nextRefreshAt } : {}) },
    ...(heroRecipe ? { heroRecipe } : {}), collections,
  };
}

export async function publishedDiscovery(hidden: Set<string>): Promise<Partial<ExploreContent> | null> {
  const state = (await fs.collection('discovery').doc('state').get()).data();
  if (!state?.activeEditionId) return null;
  const snapshot = await fs.collection('discoveryEditions').doc(state.activeEditionId).get();
  if (!snapshot.exists) return null;
  const edition = snapshot.data() as StoredDiscoveryEdition;
  if (!edition.heroRecipeId || !Array.isArray(edition.collections) || !Array.isArray(edition.creatorUids)) return null;
  const ids = [...new Set([edition.heroRecipeId, ...edition.collections.flatMap(collection => collection.recipeIds)])];
  const [recipeDocs, profiles] = await Promise.all([
    fs.getAll(...ids.map(id => fs.collection('recipes').doc(id))), publicProfiles(edition.creatorUids),
  ]);
  const recipes = recipeDocs.filter(doc => doc.exists).map(doc => {
    const data = doc.data()!;
    const author = profiles.get(data.createdBy);
    return { id: doc.id, ...data, authorName: author?.displayName ?? null, authorUid: data.createdBy } as Recipe;
  });
  const content = materializeDiscovery(edition, recipes, hidden);
  const featuredCreators: ExploreCreator[] = edition.creatorUids.flatMap(uid => {
    const profile = profiles.get(uid);
    if (!profile || profile.profileKind !== 'curated') return [];
    const featured = recipes.find(recipe => recipe.createdBy === uid && recipe.visibility !== 'private' && !hidden.has(recipe.id));
    return [{
      ...profile, uid, displayName: profile.displayName || 'Fridgie kitchen',
      followerCount: profile.followerCount ?? 0, recipeCount: profile.recipeCount ?? 0,
      ...(featured ? { featuredRecipe: { id: featured.id, name: featured.name, photoURL: featured.photoURL ?? '' } } : {}),
    }];
  });
  return { ...content, featuredCreators };
}
