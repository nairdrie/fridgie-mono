import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { algoliasearch } from 'algoliasearch';

// TODO: automate on creation with cloud func

// --- CONFIGURATION ---
const algoliaAppId = Bun.env.ALGOLIA_APP_ID;
const algoliaAdminKey = Bun.env.ALGOLIA_WRITE_KEY;

if (!algoliaAppId || !algoliaAdminKey) {
    throw new Error("Missing Algolia App ID or Admin Key in environment variables.");
}

// Initialize Firebase
initializeApp({
    credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});
const fs = getFirestore('fridgie-db');

// Initialize Algolia Client
const client = algoliasearch(algoliaAppId, algoliaAdminKey);

async function backfillAlgolia() {
    console.log("🔥 Starting backfill from Firestore to Algolia...");
    const allDocs: QueryDocumentSnapshot[] = [];
    const collectionRef = fs.collection('recipes');
    let lastDoc: QueryDocumentSnapshot | undefined = undefined;

    // 1. Fetch all documents from Firestore using the reliable paginated method
    while (true) {
        let query = collectionRef.orderBy('__name__').limit(20);
        if (lastDoc) {
            query = query.startAfter(lastDoc);
        }
        const snapshot = await query.get();
        if (snapshot.empty) break;
        
        allDocs.push(...snapshot.docs);
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }
    console.log(`   - Fetched ${allDocs.length} total documents from Firestore.`);

    // 2. Format the data for Algolia
    // Algolia requires each record to have a unique 'objectID'. We'll use the Firestore doc ID.
    const records = allDocs.map(doc => {
        const docData = doc.data();
        return {
            objectID: doc.id,
            name: docData.name,
            description: docData.description,
            tags: docData.tags,
            photoURL: docData.photoURL
        };
    });

    // 3. Upload the records to Algolia
    if (records.length > 0) {
        console.log(`   - Sending ${records.length} records to Algolia...`);
        await client.saveObjects({ indexName: 'recipes', objects: records});
        console.log("✨ Backfill complete!");
    } else {
        console.log("✅ No records to backfill.");
    }
}

backfillAlgolia();