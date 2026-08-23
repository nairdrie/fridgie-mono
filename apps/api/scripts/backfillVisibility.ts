// One-off: stamp `visibility: 'public'` on every recipe that predates the field.
//
// Absent is READ as public everywhere, so this changes no behaviour on its own.
// It exists so that the reverse becomes possible: an indexed
// `where('visibility', '==', 'public')` query cannot match a document that
// lacks the field, and Explore will want one the moment the corpus outgrows the
// in-memory filtering it does today.
//
// Public is the right default here specifically because it is the status quo.
// Every one of these recipes has been readable from Explore and search since
// the day it was saved — there was no visibility model at all — so writing
// 'private' would not be restoring a privacy expectation, it would be silently
// emptying people's Explore feed of content that was always shared.
//
// Recipes imported from a photo are the case that needed protecting, and they
// are protected going forward: the photo importer stamps 'private' at creation.
//
//   cd apps/api && bun scripts/backfillVisibility.ts [--dry-run]

import type { DocumentSnapshot } from 'firebase-admin/firestore';
// The app's own credential resolution, rather than a second copy of it here.
// The older scripts in this directory each hardcode
// `utils/firebase-service-account.json`, which is only one of the three ways
// this project supplies credentials — and not the one a developer with a
// populated `.env` is using. Bun loads `.env` from the working directory, so
// FIREBASE_CREDENTIALS, the local key file and Application Default Credentials
// all work from here exactly as they do for the running API.
import { fs } from '../utils/firebase';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 200;
/** Firestore caps a batch at 500 writes. */
const BATCH_SIZE = 400;

async function backfillVisibility() {
    console.log(`🔥 Backfilling recipe visibility${DRY_RUN ? ' (dry run)' : ''}...`);

    let lastDoc: DocumentSnapshot | undefined;
    let scanned = 0;
    let updated = 0;

    while (true) {
        let query = fs.collection('recipes').orderBy('__name__').limit(PAGE_SIZE);
        if (lastDoc) query = query.startAfter(lastDoc);

        const snapshot = await query.get();
        if (snapshot.empty) break;

        // Only documents actually missing the field are touched, so the script
        // is safe to re-run and safe to interrupt.
        const stale = snapshot.docs.filter((doc) => !doc.data()?.visibility);
        scanned += snapshot.size;

        for (let i = 0; i < stale.length; i += BATCH_SIZE) {
            const chunk = stale.slice(i, i + BATCH_SIZE);
            if (!DRY_RUN) {
                const batch = fs.batch();
                for (const doc of chunk) batch.update(doc.ref, { visibility: 'public' });
                await batch.commit();
            }
            updated += chunk.length;
        }

        console.log(`  scanned ${scanned}, ${updated} stamped public`);
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < PAGE_SIZE) break;
    }

    console.log(
        DRY_RUN
            ? `✅ Dry run: ${updated} of ${scanned} recipes would be stamped public.`
            : `✅ Done: ${updated} of ${scanned} recipes stamped public.`,
    );
}

backfillVisibility().catch((error) => {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
});
