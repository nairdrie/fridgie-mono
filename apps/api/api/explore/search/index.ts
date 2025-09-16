import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import  { algoliasearch } from 'algoliasearch';
import { decodeStream } from 'cheerio';

// --- ⚙️ Configuration ---
const algoliaAppId = Bun.env.ALGOLIA_APP_ID;
const algoliaAdminKey = Bun.env.ALGOLIA_READ_KEY; // Use ADMIN key on the backend

if (!algoliaAppId || !algoliaAdminKey) {
    throw new Error("Missing Algolia App ID or Admin Key in environment variables.");
}

// --- 🚀 Algolia Client Initialization ---
const client = algoliasearch(algoliaAppId, algoliaAdminKey);

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
                params: { hitsPerPage: 3 }  // Get up to 5 user results
            }
        ];

        // Perform both searches in a single, efficient API call
        console.log(`Searching Algolia for "${query.trim()}"...`);
        const res = await client.search(queries);

        const results: any = res.results
        // Structure the final response
        const response = {
            recipes: results[0].hits.map((hit: any) => ({
                id: hit.objectID,
                name: hit.name,
                description: hit.description,
                photoURL: hit.photoURL
            })),
            users: results[1].hits
        };

        console.log(response);

        return c.json(response);

    } catch (error) {
        console.error("Algolia multi-search failed:", error);
        return c.json({ error: 'Could not perform search.' }, 500);
    }
});

export default route;