import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase'; // Assuming you use Firestore for recipes
import { getAuth } from 'firebase-admin/auth';
import OpenAI from 'openai';
import { FieldPath } from 'firebase-admin/firestore';

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
        // (For now, let's just grab a few recent users as an example)
        const userRecords = await getAuth().listUsers(5);
        const topUsers = userRecords.users.map(u => ({
            uid: u.uid,
            displayName: u.displayName,
            photoURL: u.photoURL,
        }));

        // const completion = await openai.chat.completions.create({
        //     model: 'gpt-4o-mini-search-preview-2025-03-11',
        //     messages: [
        //         { role: 'user', content: `Find the best deals in the nofrills flyer this week for postal code M6S5B3. Return the following JSON structure:
        //             [{
        //                 'name': 'eg. Bananas',
        //                 'salePrice': 'eg. $4.00',
        //                 'originalPrice': 'eg. $8.00',
        //                 'source': 'eg. https://nofrills...'
        //             }]
        //         ` },
        //     ],
        //     response_format: { type: 'text' },
        // });

        // const content = completion.choices?.[0]?.message?.content;
        // if (!content) throw new Error('AI returned empty content.');
        
        // console.log(content);
        
        // --- 5. Assemble the payload for the client ---
        const exploreData = {
            trending,
            newest,
            topUsers
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
    for (let i = 0; i < n; i++) {
        randomKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // 2. Query for the next 10 documents starting from the random key.
    const query = await fs.collection('recipes')
        .where(FieldPath.documentId(), '>=', randomKey)
        .limit(n)
        .get();

    let recipes = query.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 3. (Wrap-around) If we got fewer than 10, fetch more from the beginning.
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