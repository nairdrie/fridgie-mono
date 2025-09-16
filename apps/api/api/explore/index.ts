import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase'; // Assuming you use Firestore for recipes
import { getAuth } from 'firebase-admin/auth';
import OpenAI from 'openai';
import { FieldPath } from 'firebase-admin/firestore';

interface Creator {
    uid: string;
    displayName: string;
    photoURL: string | null;
    followers: number;
    recipes: number;
    featuredRecipe?: {
        id: string;
        name: string;
        photoURL: string;
    };
}

const route = new Hono();
route.use('*', auth);

const apiKey = process.env.OPENAI_API_KEY || Bun.env.OPENAI_API_KEY;
const openai = new OpenAI({
  apiKey
});

// GET /api/explore
route.get('/', async (c) => {
    try {
        // --- 1. Fetch Trending Recipes (e.g., most liked) ---
        const trendingSnapshot = await fs.collection('recipes')
            .orderBy('popularity.likes', 'desc')
            .limit(20)
            .get();
            

        const trending: any = trendingSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))

        if(trending.length < 20) {
            const randomRecipes = await getRandomRecipes(20 - trending.length);
            trending.push(...randomRecipes);
        }

        // --- 2. Fetch New Recipes ---
        const newSnapshot = await fs.collection('recipes')
            .orderBy('createdAt', 'desc')
            .limit(10)
            .get();
        const newest = newSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))


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

            // Combine Firestore data with Auth data
            featuredCreators = userDocs.map(doc => {
                const userData = doc.data();
                const authUser = authUsersMap.get(doc.id);

                return {
                    uid: doc.id,
                    displayName: authUser?.displayName || 'Anonymous User',
                    photoURL: authUser?.photoURL || null,
                    followers: userData.followerCount || 0,
                    recipes: userData.publicRecipesCount || 0,
                    featuredRecipe: userData.featuredRecipe
                };
            });
        }


        // --- 5. Assemble the payload for the client ---
        const exploreData = {
            trending,
            newest,
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