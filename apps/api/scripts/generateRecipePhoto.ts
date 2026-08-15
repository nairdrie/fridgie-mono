/**
 * bun run scripts/generateRecipePhoto.ts <recipeId | --all> [--ai]
 **/

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';

// --- CONFIGURATION ---

const openaiApiKey = process.env.OPENAI_API_KEY || Bun.env.OPENAI_API_KEY;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || Bun.env.FIREBASE_STORAGE_BUCKET;

if (!openaiApiKey || !storageBucket) {
    console.error("❌ Error: Missing environment variables.");
    process.exit(1);
}

const openai = new OpenAI({ apiKey: openaiApiKey });
const serviceAccount = JSON.parse(readFileSync('utils/firebase-service-account.json', 'utf8'));

initializeApp({
    credential: cert(serviceAccount),
    storageBucket: storageBucket,
});

const fs = getFirestore('fridgie-db');
const bucket = getStorage().bucket();

console.log("✅ Firebase Admin, OpenAI SDK, and Unsplash config initialized.");

// --- MAIN SCRIPT LOGIC ---

async function main() {
    const argument = Bun.argv[2];
    const forceAi = Bun.argv.includes('--ai');

    if (!argument) {
        console.error("❌ Usage: bun run generate-image.ts <recipeId | --all> [--ai]");
        return;
    }

    if (forceAi) {
        console.log("\n🤖 --ai flag detected. Bypassing Unsplash and forcing AI image generation.");
    }

    let recipesToProcess: QueryDocumentSnapshot[] = [];

    // Fetching logic...
    if (argument === '--all') {
        console.log("\n🔥 Batch mode activated. Fetching all documents via pagination...");
        const collectionRef = fs.collection('recipes');
        const allDocs: QueryDocumentSnapshot[] = [];
        let lastDoc: QueryDocumentSnapshot | undefined = undefined;

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
        
        console.log(`   - Fetched ${allDocs.length} total recipes. Now filtering in-script...`);
        recipesToProcess = allDocs.filter(doc => doc.data().hasImage !== true);

        if (recipesToProcess.length === 0) {
            console.log("✅ All recipes already have images. Nothing to do.");
            return;
        }
        console.log(`🔍 Found ${recipesToProcess.length} recipes to process.`);

    } else {
        console.log(`\n🔥 Single mode activated for recipe: ${argument}`);
        const recipeDoc = await fs.collection('recipes').doc(argument).get();
        if (!recipeDoc.exists) {
            console.error(`❌ Recipe with ID "${argument}" not found.`);
            return;
        }
        recipesToProcess.push(recipeDoc as QueryDocumentSnapshot);
    }
    
    // --- Loop to process each fetched recipe ---
    for (const [index, recipeDoc] of recipesToProcess.entries()) {
        const recipeId = recipeDoc.id;
        const recipeData = recipeDoc.data();

        console.log(`\n--- Processing recipe ${index + 1} of ${recipesToProcess.length}: "${recipeData.name}" (${recipeId}) ---`);

        try {
            // MODIFIED: This will now hold the raw image data as a Buffer
            let imageBuffer: Buffer | undefined;
            
            // MODIFIED: Fallback to AI and get the buffer directly
            if (!imageBuffer) {
                console.log("   - Generating image with OpenAI...");
                const prompt = `Photorealistic, vibrant, delicious-looking food photography of "${recipeData.name}". ${recipeData.description || ''}. Shot with a shallow depth of field, bright natural lighting.`;
                const response = await openai.images.generate({
                    model: "gpt-image-1",
                    prompt: prompt,
                    n: 1,
                    size: "1024x1024",
                    quality: "auto",
                });

                const image_base64 = response?.data?.[0]?.b64_json;
                if (!image_base64) throw new Error("Could not find b64_json in OpenAI response.");

                console.log("   - Decoding Base64 image data...");
                imageBuffer = Buffer.from(image_base64, "base64");
            }

            if (!imageBuffer) {
                throw new Error("Could not retrieve an image from any source.");
            }

            // MODIFIED: The upload step is now universal
            const fileName = `recipe-images/${recipeId}-${uuidv4()}.png`;
            const file = bucket.file(fileName);
            console.log(`   - Uploading image to Firebase Storage at: ${fileName}`);
            await file.save(imageBuffer, { metadata: { contentType: 'image/png' } });
            
            await file.makePublic();
            const publicUrl = file.publicUrl();
            
            console.log("   - Updating Firestore document...");
            await recipeDoc.ref.update({ photoURL: publicUrl, hasImage: true });

            console.log(`✨ Successfully updated "${recipeData.name}"!`);
            console.log(`   - Final URL: ${publicUrl}`);

        } catch (error) {
            console.error(`\n❌ An error occurred while processing "${recipeData.name}" (${recipeId}):`, error);
        }
    }
    console.log("\n✅ All processing complete.");
    process.exit(0);
}

main();