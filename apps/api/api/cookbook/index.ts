import { Hono } from 'hono'
import { FieldValue } from 'firebase-admin/firestore'
import { adminRtdb, fs } from '@/utils/firebase'
import { auth } from '@/middleware/auth'
import type { Group, Meal } from '@/utils/types'

const route = new Hono()

// All cookbook routes require authentication
route.use('*', auth)


const getMealDate = (weekStart: string, dayOfWeek?: Meal['dayOfWeek']): Date => {
  const weekStartDate = new Date(weekStart);
  if (dayOfWeek) {
    const dayMap = { 'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6 };
    // Adjust for the week starting on a specific day if needed, assuming Sunday start
    const dayOffset = dayMap[dayOfWeek];
    weekStartDate.setDate(weekStartDate.getDate() + dayOffset);
  }
  return weekStartDate;
};


/**
 * POST /api/cookbook
 * Adds a recipe to the user's personal cookbook.
 */
route.post('/', async (c) => {
  const uid = c.get('uid')
  const { recipeId } = await c.req.json<{ recipeId: string }>()

  if (!recipeId) {
    return c.json({ error: 'Missing recipeId' }, 400)
  }

  // Find the root recipe to ensure we save a reference to the original
  const recipeDoc = await fs.collection('recipes').doc(recipeId).get()
  if (!recipeDoc.exists) {
    return c.json({ error: 'Recipe not found' }, 404)
  }
  
  const rootRecipeId = recipeDoc.data()?.forkedFromId || recipeId
  const rootRecipeRef = fs.collection('recipes').doc(rootRecipeId)
  const rootRecipeData = (await rootRecipeRef.get()).data()

  // Add a reference to the user's cookbook subcollection
  // We use the recipe ID as the document ID to prevent duplicates
  const cookbookRef = fs.collection('users').doc(uid).collection('cookbook').doc(rootRecipeId)

  try {
    // Run a transaction to perform both writes atomically
    await fs.runTransaction(async (transaction) => {
      // 1. Add to the user's personal cookbook
      transaction.set(cookbookRef, {
        name: rootRecipeData?.name,
        photoURL: rootRecipeData?.photoURL || null,
        addedAt: FieldValue.serverTimestamp(),
      })

      // 2. Increment the popularity counter on the root recipe
      transaction.update(rootRecipeRef, {
        'popularity.cookbooks': FieldValue.increment(1)
      })
    })

    return c.json({ message: 'Recipe added to cookbook' }, 201)
  } catch (error: any) {
    console.error('Error adding to cookbook:', error)
    return c.json({ error: 'Could not add to cookbook', details: error.message }, 500)
  }
})

/**
 * GET /api/cookbook
 * Retrieves all recipes in the user's cookbook.
 */
route.get('/', async (c) => {
  const uid = c.get('uid')

  try {
    // --- Step 1: Get user's cookbook recipe IDs from Firestore ---
    const cookbookSnapshot = await fs.collection('users').doc(uid).collection('cookbook').orderBy('addedAt', 'desc').get()
    
    if (cookbookSnapshot.empty) {
      return c.json([])
    }
    const recipeIds = cookbookSnapshot.docs.map(doc => doc.id)

    // --- Step 2: Find all user's groups from RTDB ---
    const groupsSnapshot = await adminRtdb.ref('groups').once('value');
    // ✨ Define the type to match the new structure: { uid: true }
    const allGroups = groupsSnapshot.val() as Record<string, { members?: Record<string, boolean> }> | null;
    const groupIds: string[] = [];

    if (allGroups) {
      for (const groupId in allGroups) {
        const group = allGroups[groupId];
        // ✨ Correctly check if the user's UID exists as a key in the members object
        if (group?.members?.[uid]) {
          groupIds.push(groupId);
        }
      }
    }

    if (groupIds.length === 0) {
      // If user has no groups, we can't find a lastAte date.
      const recipesSnapshot = await fs.collection('recipes').where('__name__', 'in', recipeIds).get();
      const recipes = recipesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        lastAte: null, // No groups, so lastAte is null
      }));
      return c.json(recipes);
    }

    // --- Step 3: Scan RTDB lists for all meals across all user's groups ---
    const lastAteMap = new Map<string, Date>();
    const rtdbPromises = groupIds.map(groupId => 
      adminRtdb.ref(`lists/${groupId}`).once('value')
    );
    const listSnapshots = await Promise.all(rtdbPromises);

    for (const snapshot of listSnapshots) {
      if (snapshot.exists()) {
        const lists = snapshot.val();
        for (const listId in lists) {
          const list = lists[listId];
          if (list.meals && Array.isArray(list.meals)) {
            list.meals.forEach((meal: Meal) => {
              if (meal.recipeId) {
                const mealDate = getMealDate(list.weekStart, meal.dayOfWeek);
                const existingDate = lastAteMap.get(meal.recipeId);
                if (!existingDate || mealDate > existingDate) {
                  lastAteMap.set(meal.recipeId, mealDate);
                }
              }
            });
          }
        }
      }
    }

    // --- Step 4: Fetch full recipe documents from Firestore and merge `lastAte` data ---
    const recipesSnapshot = await fs.collection('recipes').where('__name__', 'in', recipeIds).get()
    
    const recipes = recipesSnapshot.docs.map(doc => {
      const recipeData = doc.data();
      const lastAteDate = lastAteMap.get(doc.id);

      return {
        id: doc.id,
        ...recipeData,
        lastAte: lastAteDate ? lastAteDate.toISOString() : null,
      };
    });

    return c.json(recipes)
  } catch (error: any) {
    console.error('Error fetching cookbook:', error)
    return c.json({ error: 'Could not fetch cookbook', details: error.message }, 500)
  }
})

export default route