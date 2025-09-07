import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';

// --- Types ---
export interface Ingredient {
    name: string;
    quantity: string;
}

export interface Recipe {
    id: string;
    photoURL?: string;
    name: string;
    description: string;
    ingredients: Ingredient[];
    instructions: string[];
}

interface MealPreferences {
    dietaryNeeds?: string[];
    cookingStyles?: string[];
    cuisines?: string[];
    dislikedIngredients?: string[];
    query?: string;
}

interface SuggestionRequestBody {
    vetoedTitles?: string[];
}

// --- Hono Route Setup ---
const route = new Hono();

// --- API Client Initialization ---
const openai = new OpenAI({
    apiKey: Bun.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are a creative recipe assistant. Your task is to generate 3 unique and varied meal recipes based on user preferences.
Ensure the recipes are distinct from one another (e.g., different primary proteins, cooking methods, or flavor profiles).

You MUST return a raw JSON array with exactly 3 recipe objects, matching this structure:
[
    {
        "name": "Recipe Name",
        "description": "A short, enticing description that highlights the main flavors or ingredients.",
        "ingredients": [
            { "name": "Ingredient Name", "quantity": "e.g., 1 cup or 200g" }
        ],
        "instructions": [
            "Step 1...",
            "Step 2...",
            "Step 3..."
        ]
    }
]

DO NOT include markdown, code fences, or any text outside of the JSON array.
`;

// --- Middleware ---
route.use('*', auth);

// --- Route Handler ---
route.post('/', async (c) => {
    const uid = c.get('uid') as string;

    // Read optional 'vetoedTitles' from the request body
    let vetoedTitles: string[] = [];
    try {
        const body = await c.req.json<SuggestionRequestBody>();
        if (body.vetoedTitles && Array.isArray(body.vetoedTitles)) {
            vetoedTitles = body.vetoedTitles;
        }
    } catch (e) {
        // Ignore errors if the body is empty or not valid JSON
    }
    
    // Fetch user's meal preferences from Firestore
    const prefRef = fs.collection('userPreferences').doc(uid);
    const prefDoc = await prefRef.get();

    if (!prefDoc.exists) {
        return c.json({ error: 'Meal preferences not set.', action: 'redirect_to_preferences' }, 404);
    }

    // Construct the prompt for the AI based on user preferences
    const preferences = prefDoc.data() as MealPreferences;
    const userPromptParts: string[] = ['Generate recipes based on these preferences:'];

    if (preferences.dietaryNeeds?.length) userPromptParts.push(`- Dietary Needs: ${preferences.dietaryNeeds.join(', ')}.`);
    if (preferences.cookingStyles?.length) userPromptParts.push(`- Preferred Cooking Styles: ${preferences.cookingStyles.join(', ')}.`);
    if (preferences.cuisines?.length) userPromptParts.push(`- Preferred Cuisines: ${preferences.cuisines.join(', ')}.`);
    if (preferences.dislikedIngredients?.length) userPromptParts.push(`- Must NOT contain: ${preferences.dislikedIngredients}.`);
    
    if (vetoedTitles.length > 0) {
        userPromptParts.push(`- Do NOT suggest any recipes closely related to the following: ${vetoedTitles.join(', ')}.`);
    }

    const userPrompt = userPromptParts.length > 1 ? userPromptParts.join('\n') : 'Generate any 3 varied recipes.';

    try {
        // Step 1: Generate recipe suggestions from OpenAI
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: "json_object" },
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI returned empty content.');
        
        // Parse the AI's JSON response to get the recipes array
        let recipes: Omit<Recipe, 'id'>[] = [];
        const parsedContent = JSON.parse(content);

        if (Array.isArray(parsedContent)) {
            recipes = parsedContent;
        } else if (typeof parsedContent === 'object' && parsedContent !== null) {
            // Handle cases where the AI might wrap the array in an object
            const key = Object.keys(parsedContent).find(k => Array.isArray(parsedContent[k]));
            if (key) recipes = parsedContent[key];
        }

        if (recipes.length === 0) throw new Error('Failed to parse a valid recipe array from AI response.');
        
    return c.json(recipes);

    } catch (error) {
    console.error('AI suggestion failed:', error);
        return c.json({ error: 'Failed to generate a meal suggestion.' }, 500);
    }
});

export default route;
