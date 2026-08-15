import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, DocumentSnapshot } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

// Standard Firebase Initialization
initializeApp({
    credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});
const fs = getFirestore('fridgie-db');

async function backfillRecipeImagesPaginated() {
    try {
        console.log("🔥 Starting paginated backfill process...");
        const collectionRef = fs.collection('recipes');
        const pageSize = 20; // Process 20 documents at a time
        let lastDoc: DocumentSnapshot | undefined = undefined;
        let totalUpdated = 0;

        while (true) {
            // Build the paginated query, same as the successful scanner script
            let query = collectionRef.orderBy('__name__').limit(pageSize);
            if (lastDoc) {
                query = query.startAfter(lastDoc);
            }

            const snapshot = await query.get();

            if (snapshot.empty) {
                break; // Reached the end of the collection
            }

            // Create a new batch for this page of documents
            const batch = fs.batch();
            let processedInBatch = 0;

            snapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.hasImage === undefined) {
                    const hasPhoto = !!data.photoURL;
                    batch.update(doc.ref, { hasImage: hasPhoto });
                    processedInBatch++;
                }
            });

            if (processedInBatch > 0) {
                console.log(`Committing batch with ${processedInBatch} updates...`);
                await batch.commit();
                totalUpdated += processedInBatch;
            } else {
                console.log("No updates needed for this batch.");
            }

            // Set the last document for the next page
            lastDoc = snapshot.docs[snapshot.docs.length - 1];
        }

        console.log(`\n✨ Backfill complete! Updated a total of ${totalUpdated} recipes.`);
        process.exit(0);

    } catch (error) {
        console.error("\n❌ An error occurred during the paginated backfill:", error);
        process.exit(1);
    }
}

backfillRecipeImagesPaginated();