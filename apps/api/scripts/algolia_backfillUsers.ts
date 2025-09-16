import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth, UserRecord } from 'firebase-admin/auth';
import { readFileSync } from 'fs';
import { algoliasearch } from 'algoliasearch';

// --- CONFIGURATION ---
const algoliaAppId = Bun.env.ALGOLIA_APP_ID;
const algoliaAdminKey = Bun.env.ALGOLIA_WRITE_KEY; // Using your preferred env var name

if (!algoliaAppId || !algoliaAdminKey) {
    throw new Error("Missing Algolia App ID or Admin Key in environment variables.");
}

// Initialize Firebase
initializeApp({
    credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});

// Initialize Algolia Client
const client = algoliasearch(algoliaAppId, algoliaAdminKey);

async function backfillAuthUsers() {
    console.log("🔥 Starting backfill for Auth USERS to Algolia...");
    const allUsers: UserRecord[] = [];
    let pageToken: string | undefined = undefined;

    // 1. Fetch all users from Firebase Authentication using pagination
    while (true) {
        const listUsersResult = await getAuth().listUsers(1000, pageToken);
        allUsers.push(...listUsersResult.users);
        pageToken = listUsersResult.pageToken;
        if (!pageToken) {
            break; // No more users to fetch
        }
    }
    console.log(`   - Fetched ${allUsers.length} total users from Firebase Auth.`);

    // 2. Filter out anonymous users
    const nonAnonymousUsers = allUsers.filter(user => user.email);
    console.log(`   - Found ${nonAnonymousUsers.length} non-anonymous users to index.`);

    // 3. Format the user data for Algolia
    const userRecords = nonAnonymousUsers.map(user => {
        return {
            objectID: user.uid, // Use the UID as the unique ID
            displayName: user.displayName,
            photoURL: user.photoURL,
            email: user.email,
        };
    });

    // 4. Upload the records to the 'users' index in Algolia
    if (userRecords.length > 0) {
        console.log(`   - Sending ${userRecords.length} users to Algolia...`);
        await client.saveObjects({ indexName: 'users', objects: userRecords });
        console.log("✨ Auth user backfill complete!");
    } else {
        console.log("✅ No users to backfill.");
    }
}

backfillAuthUsers();