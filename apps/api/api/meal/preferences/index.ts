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
 * Saves or updates the authenticated user's meal preferences in Firestore.
 */
route.post('/', async (c) => {
  const uid = c.get('uid') as string;
  
  try {
    const preferences = await c.req.json<MealPreferences>();

    // Validate the incoming data (basic check)
    if (!preferences || typeof preferences !== 'object') {
      return c.json({ error: 'Invalid preferences format' }, 400);
    }
    
    // Define the document reference in Firestore
    const prefRef = fs.collection('userPreferences').doc(uid);

    // Set the preferences. Using { merge: true } is good practice
    // as it prevents overwriting other fields if you add them later.
    await prefRef.set(preferences, { merge: true });

    return c.json(preferences);
  } catch (error) {
    console.error('Failed to save preferences:', error);
    return c.json({ error: 'An error occurred while saving preferences.' }, 500);
  }
});

route.get('/', async (c) => {
  const uid = c.get('uid') as string;
  const prefRef = fs.collection('userPreferences').doc(uid);

  try {
    const doc = await prefRef.get();
    if (!doc.exists) {
      return c.json({ error: 'Meal preferences not set.', action: 'redirect_to_preferences' }, 404);
    }

    return c.json(doc.data());
  } catch (error) {
    console.error('Failed to fetch preferences:', error);
    return c.json({ error: 'An error occurred while fetching preferences.' }, 500);
  }

});

export default route;