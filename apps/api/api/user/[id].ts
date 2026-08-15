// File: app/api/user/[id]/route.ts

import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import admin from 'firebase-admin';
import { fs } from '@/utils/firebase'; // Make sure you import your Firestore instance

const route = new Hono();
route.use('*', auth);

route.get('/', async (c) => {
    const currentUserId = c.get('uid'); // The user making the request
    const profileUserId = c.req.param('id'); // The user being viewed

    if (!profileUserId) {
        return c.json({ error: 'User ID is required' }, 400);
    }

    try {
        // Get Auth and Firestore data in parallel for efficiency
        const [userRecord, profileDoc, followDoc] = await Promise.all([
            admin.auth().getUser(profileUserId),
            fs.collection('users').doc(profileUserId).get(),
            // Check if the current user is following the profile user
            fs.collection('users').doc(currentUserId).collection('following').doc(profileUserId).get()
        ]);

        const firestoreData = profileDoc.data() || {};
        
        return c.json({
            uid: userRecord.uid,
            displayName: userRecord.displayName || null,
            photoURL: userRecord.photoURL || null,
            email: userRecord.email || null,
            // Add new data from Firestore
            followerCount: firestoreData.followerCount || 0,
            followingCount: firestoreData.followingCount || 0,
            isFollowing: followDoc.exists, // True if the follow document exists
        });
    } catch (error: any) {
        if (error.code === 'auth/user-not-found') {
            return c.json({ error: 'User not found' }, 404);
        }
        console.error(`Failed to fetch user ${profileUserId}:`, error);
        return c.json({ error: 'Failed to retrieve user profile.' }, 500);
    }
});

export default route;