import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import  { algoliasearch } from 'algoliasearch';
import { decodeStream } from 'cheerio';
import { FieldPath } from 'firebase-admin/firestore';
import { fs } from '@/utils/firebase';

// --- ⚙️ Configuration ---
const algoliaAppId = process.env.ALGOLIA_APP_ID || Bun.env.ALGOLIA_APP_ID;
// This route only ever SEARCHES, so a search-only key is sufficient and is what
// belongs here. The variable was named `algoliaSearchKey` with a comment saying
// to use the admin key, while reading ALGOLIA_READ_KEY — so the code disagreed
// with itself about how privileged this credential is. Renamed to match what
// the route actually needs; verify in the Algolia dashboard that the value in
// ALGOLIA_READ_KEY really is search-only, since an admin key here could delete
// the index.
const algoliaSearchKey = process.env.ALGOLIA_READ_KEY || Bun.env.ALGOLIA_READ_KEY;

if (!algoliaAppId || !algoliaSearchKey) {
    throw new Error("Missing ALGOLIA_APP_ID or ALGOLIA_READ_KEY in environment variables.");
}

// --- 🚀 Algolia Client Initialization ---
const client = algoliasearch(algoliaAppId, algoliaSearchKey);

// --- 🌐 Hono Route Definition ---
const route = new Hono();
route.use('*', auth); // Secure the endpoint

/**
 * GET /explore/search?q=<query>
 * Searches both the 'recipes' and 'users' indices in Algolia.
 */
route.get('/', async (c) => {
    try {
        const query = c.req.query('q');

        // Validate the search query
        if (!query || typeof query !== 'string' || query.trim() === '') {
            return c.json({ error: 'A search query `q` is required.' }, 400);
        }

        // Define the searches for both indices
        const queries = [
            {
                indexName: 'recipes',
                query: query.trim(),
                params: { hitsPerPage: 10 } // Get up to 10 recipe results
            },
            {
                indexName: 'users',
                query: query.trim(),
                params: { hitsPerPage: 3 }
            }
        ];

        // Perform both searches in a single, efficient API call
        console.log(`Searching Algolia for "${query.trim()}"...`);
        const res = await client.search(queries);

        const results: any = res.results

        const recipes = results[0].hits.map((hit: any) => ({
            id: hit.objectID,
            name: hit.name,
            description: hit.description,
            photoURL: hit.photoURL,
            // Indexed and used by the client for per-cuisine card styling —
            // dropping it here made every search result render the generic style.
            tags: hit.tags ?? [],
        }));

        const usersFromAlgolia = results[1]?.hits || [];
        let enrichedUsers = [];

        // ✨ --- START: NEW LOGIC TO ENRICH USER DATA --- ✨

        // 1. If we have user results from Algolia, proceed to fetch from Firestore
        if (usersFromAlgolia.length > 0) {
            const userIds = usersFromAlgolia.map((user:any) => user.objectID);

            // 2. Fetch all corresponding user documents from Firestore in one query
            const usersSnapshot = await fs.collection('users')
                .where(FieldPath.documentId(), 'in', userIds)
                .get();
            
            // 3. Create a lookup map for efficient data merging (UID -> Firestore data)
            const firestoreDataMap = new Map();
            usersSnapshot.forEach(doc => {
                const data = doc.data();
                firestoreDataMap.set(doc.id, {
                    followerCount: data.followerCount || 0,
                    recipeCount: data.recipeCount || 0,
                });
            });

            // 4. Merge Algolia results with Firestore data
            enrichedUsers = usersFromAlgolia.map((algoliaUser:any) => {
                const firestoreData = firestoreDataMap.get(algoliaUser.objectID) || { followers: 0, recipes: 0 };
                return {
                    ...algoliaUser, // Keep all fields from Algolia (objectID, displayName, photoURL, etc.)
                    ...firestoreData, // Add/overwrite with followers and recipes counts
                };
            });
        }

        // Structure the final response
        const response = {
            recipes,
            users: enrichedUsers
        };

        console.log(response);

        return c.json(response);

    } catch (error) {
        console.error("Algolia multi-search failed:", error);
        return c.json({ error: 'Could not perform search.' }, 500);
    }
});

export default route;