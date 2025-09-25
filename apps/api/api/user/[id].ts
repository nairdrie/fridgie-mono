import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import admin from 'firebase-admin';

const route = new Hono();

// Apply authentication middleware to all routes in this file
route.use('*', auth);

/**
 * GET /api/user/[id]
 * Fetches a user's public profile information by their UID.
 */
route.get('/', async (c) => {
    // Extract the user ID from the URL path parameter
    const userId = c.req.param('id');

    if (!userId) {
        return c.json({ error: 'User ID is required' }, 400);
    }

    try {
        // Use the Firebase Admin SDK to retrieve the user record
        const userRecord = await admin.auth().getUser(userId);

        // Return a subset of the user's data that is safe to be public
        return c.json({
            uid: userRecord.uid,
            displayName: userRecord.displayName || null,
            photoURL: userRecord.photoURL || null,
            email: userRecord.email || null, // Be mindful of privacy; only return if necessary for your app's features
        });
    } catch (error: any) {
        // Handle cases where the user is not found
        if (error.code === 'auth/user-not-found') {
            return c.json({ error: 'User not found' }, 404);
        }
        // Handle other potential errors
        console.error(`Failed to fetch user ${userId}:`, error);
        return c.json({ error: 'Failed to retrieve user profile.' }, 500);
    }
});

export default route;