// api/meal/suggest/index.ts
import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';

// --- New Types ---
export interface Ingredient {
  name: string;
  quantity: string;
}

export interface Recipe {
  id: string; // e.g., "spicy-thai-green-curry"
  photoURL?: string; // This will likely be omitted by the AI
  name: string;
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

const route = new Hono();

// Initialize OpenAI client from environment variables
const openai = new OpenAI({
  apiKey: Bun.env.OPENAI_API_KEY,
});

// This system prompt provides the core instructions and defines the output structure.
// It is sent with every request but is static, separating it from the dynamic user preferences.
const systemPrompt = `
You are a creative recipe assistant. Your task is to generate 3 unique and varied meal recipes based on user preferences.
Ensure the recipes are distinct from one another (e.g., different primary proteins, cooking methods, or flavor profiles).

You MUST return a raw JSON array with exactly 3 recipe objects, matching this structure:
[
  {
    "name": "Recipe Name",
    "description": "A short description providing the main ingredients, and a hook",
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

Do not include the 'photoURL' field. Do not include markdown, code fences, or any text outside of the JSON array.
`;

// Protect this route
route.use('*', auth);

/**
 * POST /api/meal/suggest
 * Generates 3 meal suggestions based on the user's saved preferences.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  
  // 1. Fetch user's saved preferences from Firestore
  const prefRef = fs.collection('userPreferences').doc(uid);
  const prefDoc = await prefRef.get();

  // 2. Check if preferences exist
  if (!prefDoc.exists) {
    return c.json({
        error: 'Meal preferences not set.',
        action: 'redirect_to_preferences'
    }, 404);
  }

  const preferences = prefDoc.data() as MealPreferences;

  // 3. Build a simple user prompt with only the dynamic preferences
  const userPromptParts: string[] = ['Generate recipes based on these preferences:'];
  if (preferences.dietaryNeeds?.length) {
    userPromptParts.push(`- Dietary Needs: ${preferences.dietaryNeeds.join(', ')}.`);
  }
  if (preferences.cookingStyles?.length) {
    userPromptParts.push(`- Preferred Cooking Styles: ${preferences.cookingStyles.join(', ')}.`);
  }
  if (preferences.cuisines?.length) {
    userPromptParts.push(`- Preferred Cuisines: ${preferences.cuisines.join(', ')}.`);
  }
  if (preferences.dislikedIngredients?.length) {
    userPromptParts.push(`- Must NOT contain: ${preferences.dislikedIngredients.join(', ')}.`);
  }
  
  const userPrompt = userPromptParts.length > 1 ? userPromptParts.join('\n') : 'Generate any 3 varied recipes.';

  // 4. Call the OpenAI API
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt }, // The static, reusable instructions
        { role: 'user', content: userPrompt }      // The dynamic, user-specific part
      ],
      response_format: { type: "json_object" },
      temperature: 2
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI returned empty content.');
    }
    
    // 5. The API in JSON mode with a detailed prompt should return an array
    // but the type is `any` so we parse it as an object that contains the array.
    // GPT models sometimes wrap the array in a root key like "recipes".
    let recipes: Recipe[] = [];
    const parsedContent = JSON.parse(content);

    // Find the array in the parsed JSON, whether it's the root or nested.
    if (Array.isArray(parsedContent)) {
        recipes = parsedContent;
    } else if (typeof parsedContent === 'object' && parsedContent !== null) {
        const key = Object.keys(parsedContent).find(k => Array.isArray(parsedContent[k]));
        if (key) {
            recipes = parsedContent[key];
        }
    }

    if (recipes.length === 0) {
      throw new Error('Failed to parse a valid recipe array from AI response.');
    }
    
    return c.json(recipes);

  } catch (error) {
    console.error('AI suggestion failed:', error);
    return c.json({ error: 'Failed to generate a meal suggestion.' }, 500);
  }
});

export default route;