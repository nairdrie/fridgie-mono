import { Hono } from 'hono';
import { adminRtdb } from '@/utils/firebase';
import { auth } from '@/middleware/auth';

const route = new Hono();

// Protect this route to ensure we know which user the token belongs to.
route.use('*', auth);

route.post('/', async (c) => {
  // Get the authenticated user's ID from your auth middleware.
  const uid = c.get('uid');
  
  // Get the push token sent from the app.
  const { token } = await c.req.json();

  // Validate that a token was actually provided in the request body.
  if (!token) {
    return c.json({ error: 'Push token is required.' }, 400);
  }

  try {
    // Construct the path to the specific user's data in the Realtime Database.
    const userRef = adminRtdb.ref(`users/${uid}`);

    // Update the user's record with the new pushToken.
    // Using .update() is safe because it only modifies the specified key ('pushToken')
    // without overwriting other user data.
    await userRef.update({
      pushToken: token,
    });

    // Return a success message to the app.
    return c.json({ status: 'success', message: 'Push token saved.' });
  } catch (error) {
    console.error('Failed to save push token:', error);
    return c.json({ error: 'An internal server error occurred.' }, 500);
  }
});

export default route;