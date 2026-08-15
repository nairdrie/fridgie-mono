import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, DocumentSnapshot } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

// Standard Firebase Initialization
initializeApp({
    credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});
const fs = getFirestore('fridgie-db');

async function findCorruptDocument() {
    try {
        console.log("🔥 Starting scan to find corrupt document...");
        const collectionRef = fs.collection('recipes');
        const pageSize = 10; // Read 10 documents at a time
        let lastDoc: DocumentSnapshot | undefined = undefined;
        let documentsProcessed = 0;

        while (true) {
            console.log(`\nFetching next batch of ${pageSize} documents...`);
            
            // Build the paginated query
            let query = collectionRef.orderBy('__name__').limit(pageSize);
            if (lastDoc) {
                query = query.startAfter(lastDoc);
            }

            const snapshot = await query.get();

            if (snapshot.empty) {
                console.log("✅ Reached the end of the collection without hanging.");
                break; // Exit the loop
            }
            
            // Log the IDs of the documents we just successfully fetched
            const ids = snapshot.docs.map(doc => doc.id);
            console.log("✅ Successfully fetched IDs:", ids);

            // Set the last document for the next page
            lastDoc = snapshot.docs[snapshot.docs.length - 1];
            documentsProcessed += snapshot.size;
        }

        console.log(`\n✨ Scan complete. Processed ${documentsProcessed} documents successfully.`);

    } catch (error) {
        console.error("\n❌ An error occurred during the scan:", error);
    }
}

findCorruptDocument();