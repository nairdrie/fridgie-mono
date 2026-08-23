import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase'; // Assuming you use Firestore for recipes
import { getAuth } from 'firebase-admin/auth';
import { FieldPath } from 'firebase-admin/firestore';
import type { Recipe } from '@/utils/types';
import { hiddenRecipeIds } from '@/utils/moderation';
import { sourceDocId } from '@/utils/recipeSource';

interface Creator {
    uid: string;
    displayName: string;
    photoURL: string | null;
    followerCount: number;
    recipeCount: number;
    featuredRecipe?: {
        id: string;
        name: string;
        photoURL: string;
    };
}

/**
 * How many candidates to pull per slot on offer.
 *
 * Explore filters in memory rather than in the query, because the filters it
 * needs — not private, not hidden by THIS viewer, not a duplicate of a source
 * already on screen — are respectively a composite index, a per-user set
 * Firestore cannot join against, and a group-by. At the current corpus size
 * (~150 recipes) over-fetching threefold and discarding is cheaper than the
 * index maintenance, and much cheaper than being wrong.
 *
 * This is the thing to revisit first when the feed gets slow. It does not
 * survive a corpus in the tens of thousands.
 */
const OVERFETCH = 3;

/** A recipe nobody has taken out of public view, and that this viewer has not hidden. */
const showable = (hidden: Set<string>) => (recipe: any): boolean =>
    recipe?.visibility !== 'private' && !hidden.has(recipe.id);

/**
 * One entry per source, so fifty imports of one viral video are one card.
 *
 * The FIRST copy encountered wins, which is what makes this safe to run over an
 * already-sorted list: on the trending query that is the most-liked copy, and
 * on the newest query it is the most recent one. Recipes with no source — the
 * ones people wrote themselves — are never merged, because there is nothing to
 * say two of them are the same dish.
 */
function dedupeBySource<T extends Record<string, any>>(recipes: T[]): T[] {
    const seen = new Set<string>();
    return recipes.filter((recipe) => {
        if (!recipe.sourceKey) return true;
        if (seen.has(recipe.sourceKey)) return false;
        seen.add(recipe.sourceKey);
        return true;
    });
}

/**
 * Attach "how many people imported this" to whatever is about to be returned.
 *
 * One batched read for the whole payload rather than a count per card. Firestore
 * caps `in` at 30 values, hence the chunking; a source with no counter document
 * yet reports 1, which is true — the recipe in hand is that one import.
 */
async function withImportCounts(recipes: any[]): Promise<any[]> {
    const keys = [...new Set(recipes.map((r) => r.sourceKey).filter(Boolean))] as string[];
    if (keys.length === 0) return recipes;

    const counts = new Map<string, number>();
    try {
        const ids = keys.map(sourceDocId);
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

        const snaps = await Promise.all(chunks.map((chunk) =>
            fs.collection('recipeSources').where(FieldPath.documentId(), 'in', chunk).get()));

        for (const snap of snaps) {
            snap.forEach((doc) => {
                const data = doc.data();
                if (data?.sourceKey) counts.set(String(data.sourceKey), Number(data.importCount) || 1);
            });
        }
    } catch (error) {
        // A missing count is a missing badge, not a missing feed.
        console.warn('Import counts failed:', error instanceof Error ? error.message : error);
    }

    return recipes.map((r) => (
        r.sourceKey ? { ...r, importCount: counts.get(r.sourceKey) ?? 1 } : r
    ));
}

const route = new Hono();
route.use('*', auth);

// GET /api/explore
route.get('/', async (c) => {
    try {
        // Nothing below may show a recipe its owner kept private, or one this
        // particular viewer has hidden or reported. Both filters run over the
        // fetched candidates rather than in the query — see OVERFETCH.
        const hidden = await hiddenRecipeIds(c.get('uid') as string);
        const visible = showable(hidden);

        // --- 1. Fetch Trending Recipes (e.g., most liked) ---
        const trendingSnapshot = await fs.collection('recipes')
            .orderBy('popularity.likes', 'desc')
            .limit(20 * OVERFETCH)
            .get();

        const trending: any = dedupeBySource(
            trendingSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(visible)
        ).slice(0, 20);

        if(trending.length < 20) {
            const randomRecipes = (await getRandomRecipes((20 - trending.length) * OVERFETCH))
                .filter(visible);

            const seenIds = new Set(trending.map((tr: Recipe) => tr.id));
            const seenSources = new Set(trending.map((tr: any) => tr.sourceKey).filter(Boolean));
            for (const recipe of randomRecipes) {
                if (trending.length >= 20) break;
                if (seenIds.has(recipe.id)) continue;
                // The padding has to respect the same one-card-per-source rule,
                // or a recipe deduped out of the list above walks straight back
                // in through the bottom.
                const key = (recipe as any).sourceKey;
                if (key && seenSources.has(key)) continue;
                seenIds.add(recipe.id);
                if (key) seenSources.add(key);
                trending.push(recipe);
            }
        }

        // --- 2. Fetch New Recipes ---
        const newSnapshot = await fs.collection('recipes')
            .orderBy('createdAt', 'desc')
            .limit(10 * OVERFETCH)
            .get();
        const newest = dedupeBySource(
            newSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(visible)
        ).slice(0, 10);


        // --- 4. Fetch Top Users to Follow ---
        const featuredUsersSnapshot = await fs.collection('users').where('featured', '==', true).limit(10).get();
        
        let featuredCreators: Creator[] = [];

        if (!featuredUsersSnapshot.empty) {
            const userDocs = featuredUsersSnapshot.docs;
            const uidsToFetch = userDocs.map(doc => doc.id);

            // Fetch all Auth user records in a single batch for efficiency
            const authUsersResult = await getAuth().getUsers(
                uidsToFetch.map(uid => ({ uid }))
            );

            // Create a lookup map for easy access (UID -> Auth User Record)
            const authUsersMap = new Map(
                authUsersResult.users.map(user => [user.uid, user])
            );

            const featuredRecipeIds = userDocs
                .map(doc => doc.data().featuredRecipe)
                .filter(id => !!id); // Filter out any null or undefined IDs

            // 2. Create a lookup map to store the full recipe objects
            const featuredRecipesMap = new Map();

            // 3. If there are any IDs, fetch them all in a single batch query
            if (featuredRecipeIds.length > 0) {
                const recipesSnapshot = await fs.collection('recipes')
                    .where(FieldPath.documentId(), 'in', featuredRecipeIds)
                    .get();
                
                // 4. Populate the map with recipe data (id -> recipe object)
                recipesSnapshot.forEach(doc => {
                    const data = doc.data();
                    featuredRecipesMap.set(doc.id, {
                        id: doc.id,
                        name: data.name || 'Untitled Recipe',
                        photoURL: data.photoURL || '',
                    });
                });
            }



            // Combine Firestore data with Auth data
            featuredCreators = userDocs.map(doc => {
                const userData = doc.data();
                const authUser = authUsersMap.get(doc.id);
                const featuredRecipeId = userData.featuredRecipe;

                const fullFeaturedRecipe = featuredRecipeId ? featuredRecipesMap.get(featuredRecipeId) : undefined;

                // TODO: followers & recipes count
                return {
                    uid: doc.id,
                    displayName: authUser?.displayName || 'Anonymous User',
                    photoURL: authUser?.photoURL || null,
                    followerCount: userData.followerCount || 0,
                    recipeCount: userData.recipeCount || 0,
                    featuredRecipe: fullFeaturedRecipe
                };
            });
        }


        // --- 5. Assemble the payload for the client ---
        const [trendingWithCounts, newestWithCounts] = await Promise.all([
            withImportCounts(trending),
            withImportCounts(newest),
        ]);

        const exploreData = {
            trending: trendingWithCounts,
            newest: newestWithCounts,
            featuredCreators
        };

        return c.json(exploreData);
    } catch (error) {
        console.error("Failed to fetch explore data:", error);
        return c.json({ error: 'Could not load explore content.' }, 500);
    }
});

async function getRandomRecipes(n: number) {
    // 1. Generate a random 20-character key to act as a starting point.
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomKey = '';
    for (let i = 0; i < 20; i++) { // Always generate a full-length key for better distribution
        randomKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // 2. Query for the next n documents starting from the random key.
    const query = await fs.collection('recipes')
        .where(FieldPath.documentId(), '>=', randomKey)
        .limit(n)
        .get();

    let recipes = query.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 3. (Wrap-around) If we got fewer than n, fetch more from the beginning.
    if (recipes.length < n) {
        const remainingLimit = n - recipes.length;
        const wrapAroundQuery = await fs.collection('recipes')
            .where(FieldPath.documentId(), '<', randomKey) // Get documents before our key
            .limit(remainingLimit)
            .get();
        
        const remainingRecipes = wrapAroundQuery.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        recipes.push(...remainingRecipes);
    }

    return recipes;
}


export default route;