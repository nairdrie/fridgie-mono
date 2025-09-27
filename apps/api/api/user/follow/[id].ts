// File: app/api/user/[id]/follow/route.ts

import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs } from '@/utils/firebase';
import { FieldValue } from 'firebase-admin/firestore';

// TODO: notification on follow

const route = new Hono();

// All routes in this file are protected
route.use('*', auth);

/**
 * POST /api/user/:id/follow
 * Follows a user.
 */
route.post('/', async (c) => {
    const currentUserId = c.get('uid');
    const targetUserId = c.req.param('id');

     if(!targetUserId) {
        return c.json({ error: 'Failed to follow user.' }, 500);
    }

    if (currentUserId === targetUserId) {
        return c.json({ error: 'You cannot follow yourself.' }, 400);
    }

    try {
        const currentUserRef = fs.collection('users').doc(currentUserId);
        const targetUserRef = fs.collection('users').doc(targetUserId);

        const batch = fs.batch();

        // Add target to current user's "following" subcollection
        batch.set(currentUserRef.collection('following').doc(targetUserId), {});
        // Add current user to target's "followers" subcollection
        batch.set(targetUserRef.collection('followers').doc(currentUserId), {});

        // Increment counts atomically
        batch.update(currentUserRef, { followingCount: FieldValue.increment(1) });
        batch.update(targetUserRef, { followerCount: FieldValue.increment(1) });
        
        await batch.commit();

        return c.json({ success: true, message: `Successfully followed ${targetUserId}.` });

    } catch (error) {
        console.error("Follow operation failed:", error);
        return c.json({ error: 'Failed to follow user.' }, 500);
    }
});

/**
 * DELETE /api/user/:id/follow
 * Unfollows a user.
 */
route.delete('/', async (c) => {
    const currentUserId = c.get('uid');
    const targetUserId = c.req.param('id');

    if(!targetUserId) {
        return c.json({ error: 'Failed to unfollow user.' }, 500);
    }

    try {
        const currentUserRef = fs.collection('users').doc(currentUserId);
        const targetUserRef = fs.collection('users').doc(targetUserId);

        const batch = fs.batch();

        // Remove from subcollections
        batch.delete(currentUserRef.collection('following').doc(targetUserId));
        batch.delete(targetUserRef.collection('followers').doc(currentUserId));
        
        // Decrement counts atomically
        batch.update(currentUserRef, { followingCount: FieldValue.increment(-1) });
        batch.update(targetUserRef, { followerCount: FieldValue.increment(-1) });

        await batch.commit();

        return c.json({ success: true, message: `Successfully unfollowed ${targetUserId}.` });

    } catch (error) {
        console.error("Unfollow operation failed:", error);
        return c.json({ error: 'Failed to unfollow user.' }, 500);
    }
});

export default route;