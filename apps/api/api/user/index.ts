// api/users/index.ts

import { Hono } from 'hono'
import { getAuth } from 'firebase-admin/auth';
import { auth } from '@/middleware/auth'

// Define the shape of the user profile data we'll return to the client
interface UserProfile {
  uid: string;
  email: string | null;
  phoneNumber: string | null;
  photoURL: string | null;
  displayName: string | null;
}

const route = new Hono()

// Protect all routes in this file with authentication middleware
route.use('*', auth)

/**
 * GET /api/user/search?q=<query>
 * Searches for users by display name, email, or phone number.
 */
route.get('/', async (c) => {
  try {
    const query = c.req.query('q')?.trim().toLowerCase();

    // Don't perform a search for short or empty queries to save resources
    if (!query || query.length < 2) {
      return c.json([]);
    }

    // TODO: this is terrible. we should cache user data in firestore, generate n-grams, and search with array-contains
    const listUsersResult = await getAuth().listUsers(1000);

    // Filter the full user list in memory on the server
    const filteredUsers = listUsersResult.users.filter(user => {
        console.log('user', user);
      const displayName = user.displayName?.toLowerCase() || '';
      const email = user.email?.toLowerCase() || '';
      const phoneNumber = user.phoneNumber || ''; // No normalization needed if searching raw digits

      // Check if the query is a substring of any of the main fields
      return displayName.includes(query) || email.includes(query) || phoneNumber.includes(query);
    });

    // Map the full Firebase Admin UserRecord to the simplified UserProfile
    // that the client expects.
    const results: UserProfile[] = filteredUsers.map(user => ({
      uid: user.uid,
      displayName: user.displayName || null,
      email: user.email || null,
      phoneNumber: user.phoneNumber || null,
      photoURL: user.photoURL || null,
    }));

    // for security, only return if there is exactly 1 match.
    if (results.length === 1) {
      return c.json([results[0]]);
    }
    else {
      return c.json([]);
    }
    
    return c.json(results);

  } catch (error) {
    console.error('Error searching users:', error);
    return c.json({ error: 'An unexpected error occurred while searching for users.' }, 500);
  }
})

export default route