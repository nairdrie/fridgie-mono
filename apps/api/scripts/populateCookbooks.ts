// populateCookbooks.js

import admin from 'firebase-admin';
import { initializeApp, cert } from 'firebase-admin/app';
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

// --- CONFIGURATION ---
const MIN_RECIPES_PER_USER = 2;
const MAX_RECIPES_PER_USER = 12;
// --- END CONFIGURATION ---

// Initialize Firebase Admin
initializeApp({
  credential: cert(JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'))),
});

const auth = admin.auth();
const db = getFirestore('fridgie-db');

// The list of 20 user emails to populate
const users = [
    { displayName: 'Eleanor Vance', email: 'eleanor.vance@outlook.com' },
    { displayName: 'Marcus Thorne', email: 'm.thorne78@gmail.com' },
    { displayName: 'Sofia Al-Jamil', email: 'sofia_aljamil@yahoo.com' },
    { displayName: 'Brendan O’Malley', email: 'brendan.omalley@icloud.com' },
    { displayName: 'Chloe Nguyen', email: 'cnguyen@gmail.com' },
    { displayName: 'Julian Croft', email: 'jcroft22@hotmail.com' },
    { displayName: 'Isabelle Dubois', email: 'isabelle.d@protonmail.com' },
    { displayName: 'Rajesh Patel', email: 'r.patel1985@yahoo.com' },
    { displayName: 'Samantha Kim', email: 'sammiekim@gmail.com' },
    { displayName: 'Leo Garcia', email: 'leogarcias_kitchen@outlook.com' },
    { displayName: 'Heidi Zimmerman', email: 'heidi.zimmerman91@aol.com' },
    { displayName: 'Damian Kowalski', email: 'kowalski.damian@gmail.com' },
    { displayName: 'Fiona Campbell', email: 'fionacampbell@icloud.com' },
    { displayName: 'Kenji Tanaka', email: 'kenji_tanaka@hotmail.com' },
    { displayName: 'Ava Chen', email: 'avachen8@yahoo.com' },
    { displayName: 'Franklin Shaw', email: 'frank.shaw77@gmail.com' },
    { displayName: 'Grace Holloway', email: 'graceholloway@outlook.com' },
    { displayName: 'Oscar Mendoza', email: 'o.mendoza@protonmail.com' },
    { displayName: 'Tessa Romano', email: 'tromano_art@yahoo.com' },
    { displayName: 'Simon Fletcher', email: 'simonfletcher@gmail.com' }
];

/**
 * Generates a random Firestore Timestamp within the last 60 days.
 * @returns {Timestamp} A Firestore Timestamp.
 */
function getRandomDateInLastTwoMonths() {
    const now = new Date();
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(now.getDate() - 60);

    const startMillis = sixtyDaysAgo.getTime();
    const endMillis = now.getTime();
    const randomMillis = startMillis + Math.random() * (endMillis - startMillis);

    return Timestamp.fromDate(new Date(randomMillis));
}


async function populateCookbooks() {
    console.log('🚀 Starting cookbook population script...');

    // 1. Fetch all recipes from the 'recipes' collection in batches
    const allRecipes = [];
    const batchSize = 20;
    let lastVisible = null;

    console.log(`- Fetching all recipes in batches of ${batchSize}...`);

    while (true) {
        // Construct a query for the next batch of documents
        let query = db.collection('recipes')
            .orderBy(FieldPath.documentId()) // Order by document ID for consistent pagination
            .limit(batchSize);

        // If we have a 'lastVisible' document from the previous batch, start after it
        if (lastVisible) {
            query = query.startAfter(lastVisible);
        }

        const snapshot = await query.get();

        // If the snapshot is empty, we've fetched all documents
        if (snapshot.empty) {
            break;
        }

        // Map the documents from the current batch and add them to our main array
        const recipesInBatch = snapshot.docs.map(doc => ({
            id: doc.id,
            name: doc.data().name,
            photoURL: doc.data().photoURL || null,
        }));
        allRecipes.push(...recipesInBatch);

        // Set the last document of the current batch for the next iteration
        lastVisible = snapshot.docs[snapshot.docs.length - 1];
    }

    if (allRecipes.length === 0) {
        console.error('❌ No recipes found in the "recipes" collection. Please add recipes before running this script.');
        return;
    }

    // --- NEW LOGIC: Shuffle the entire recipe list ONCE to ensure exclusivity ---
    const shuffledRecipes = [...allRecipes].sort(() => 0.5 - Math.random());
    let recipePointer = 0; // This will track which recipes have been assigned

    console.log(`📚 Found and shuffled ${shuffledRecipes.length} total recipes.`);

    // Check if there are enough recipes to go around
    if (shuffledRecipes.length < users.length * MIN_RECIPES_PER_USER) {
        console.warn('⚠️ Warning: There may not be enough recipes to satisfy the minimum for every user.');
    }

    // 2. Loop through each user and populate their cookbook
    for (const { email } of users) {
        if (recipePointer >= shuffledRecipes.length) {
            console.warn(`🤷 No more recipes left to assign. Stopping at user ${email}.`);
            break; // Exit the loop if we've run out of recipes
        }

        try {
            const userRecord = await auth.getUserByEmail(email);
            const { uid, displayName } = userRecord;

            // --- NEW LOGIC: Assign a unique "slice" of recipes to each user ---
            const recipesToAssignCount = Math.floor(Math.random() * (MAX_RECIPES_PER_USER - MIN_RECIPES_PER_USER + 1)) + MIN_RECIPES_PER_USER;
            const endSlice = Math.min(recipePointer + recipesToAssignCount, shuffledRecipes.length);
            const userCookbookRecipes = shuffledRecipes.slice(recipePointer, endSlice);
            recipePointer = endSlice; // Move the pointer for the next user

            if (userCookbookRecipes.length === 0) {
                console.log(`- No recipes left for ${displayName} (${email}). Skipping.`);
                continue; // Skip to the next user
            }

            const batch = db.batch();

            userCookbookRecipes.forEach(recipe => {
                // Operation 1: Add the recipe to the user's cookbook subcollection
                const cookbookDocRef = db.collection('users').doc(uid).collection('cookbook').doc(recipe.id);
                batch.set(cookbookDocRef, {
                    name: recipe.name,
                    photoURL: recipe.photoURL,
                    addedAt: getRandomDateInLastTwoMonths(),
                    public: true, // --- REQUIREMENT: Add the 'public' property ---
                });

                // Operation 2: Update the original recipe with the creator's UID
                const originalRecipeRef = db.collection('recipes').doc(recipe.id);
                batch.update(originalRecipeRef, { createdBy: uid });
            });

            await batch.commit();

            console.log(`✅ Assigned ${userCookbookRecipes.length} recipes to ${displayName} and updated originals.`);

        } catch (error: any) {
            if (error.code === 'auth/user-not-found') {
                console.warn(`⚠️  User with email ${email} not found. Skipping.`);
            } else {
                console.error(`❌ Failed to process user ${email}:`, error);
            }
        }
    }

    console.log('\n✨ Cookbook population script finished!');
}

// Run the script
populateCookbooks();