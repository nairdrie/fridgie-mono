// api/meal/preferences/index.ts
import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';


// --- Types ---
interface MealPreferences {
  dietaryNeeds?: string[];
  cookingStyles?: string[];
  cuisines?: string[];
  dislikedIngredients?: string[];
}

const route = new Hono();

// Protect this route, ensuring we have a user UID
route.use('*', auth);

/**
 * POST /api/meal/preferences
 * Saves or updates the authenticated user's meal preferences within their user document.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  
  try {
    const preferences = await c.req.json<MealPreferences>();

    // Validate the incoming data (basic check)
    if (!preferences || typeof preferences !== 'object') {
      return c.json({ error: 'Invalid preferences format' }, 400);
    }
    
    // Define the document reference to the user's document in the 'users' collection
    const userRef = fs.collection('users').doc(uid);

    // Update the user document with the new preferences nested under a 'preferences' field.
    // Using { merge: true } ensures we don't overwrite other user data.
    await userRef.set({ preferences }, { merge: true });

    return c.json(preferences);
  } catch (error) {
    console.error('Failed to save preferences:', error);
    return c.json({ error: 'An error occurred while saving preferences.' }, 500);
  }
});

/**
 * GET /api/meal/preferences
 * Retrieves the authenticated user's meal preferences from their user document.
 */
route.get('/', async (c) => {
  const uid = c.get('uid') as string;
  // Point to the user's document in the 'users' collection
  const userRef = fs.collection('users').doc(uid);

  try {
    const doc = await userRef.get();
    const userData = doc.data();

    // Check if the user document exists OR if the 'preferences' field exists within it.
    if (!doc.exists || !userData?.preferences) {
      return c.json({ error: 'Meal preferences not set.', action: 'redirect_to_preferences' }, 404);
    }

    // Return only the preferences object from the user document
    return c.json(userData.preferences);
  } catch (error) {
    console.error('Failed to fetch preferences:', error);
    return c.json({ error: 'An error occurred while fetching preferences.' }, 500);
  }

});

export default route;