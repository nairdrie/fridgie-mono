// File: app/api/user/[id]/follow/route.ts

import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { fs, adminAuth } from '@/utils/firebase';
import { FieldValue } from 'firebase-admin/firestore';

const route = new Hono();

// All routes in this file are protected
route.use('*', auth);

/**
 * POST /api/user/:id/follow
 * Follows a user and creates a notification.
 *
 * IDEMPOTENT. `followerCount` and `followingCount` are shown on profiles, so
 * they have to count the follow EDGES that exist rather than the number of
 * times somebody tapped: a double tap, a retried request, or a second device
 * acting on a stale `isFollowing` would otherwise inflate a stranger's follower
 * count with a follow that was already there. The transaction reads the edge
 * first and does nothing at all when it already exists — no counters, and no
 * second notification for a follow that never happened.
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
        
        // 1. Get the current user's auth data to use in the notification.
        const currentUserAuthRecord = await adminAuth.getUser(currentUserId);
        const senderUsername = currentUserAuthRecord.displayName || 'Someone';
        const senderAvatar = currentUserAuthRecord.photoURL || null;
        
        // --- End of new code ---

        const followingRef = currentUserRef.collection('following').doc(targetUserId);
        const followerRef = targetUserRef.collection('followers').doc(currentUserId);
        // 2. The notification document, written in the same transaction as the
        // edge it announces.
        const notificationRef = fs.collection('notifications').doc(); // Create a new doc with a random ID

        // A transaction rather than a batch: the counters may only move when
        // the edge does, and that is a decision the write has to READ first.
        await fs.runTransaction(async (transaction) => {
            // Every read before any write, as Firestore requires.
            const alreadyFollowing = (await transaction.get(followingRef)).exists;

            // Both halves of the edge, written unconditionally so that asking
            // to follow also repairs one that only ever got written on one side.
            transaction.set(followingRef, {});   // target, in the follower's "following"
            transaction.set(followerRef, {});    // follower, in the target's "followers"

            // Everything below is what makes this a NEW follow. Already one?
            // Then the counters are already counting it and the target has
            // already been told.
            if (alreadyFollowing) return;

            // Increment counts atomically. `set`/merge rather than `update` so a
            // user who has no Firestore document yet — the counters are the only
            // thing that creates one — starts at 1 instead of failing the follow.
            transaction.set(currentUserRef, { followingCount: FieldValue.increment(1) }, { merge: true });
            transaction.set(targetUserRef, { followerCount: FieldValue.increment(1) }, { merge: true });

            transaction.set(notificationRef, {
                type: 'NEW_FOLLOWER',
                recipientUid: targetUserId,
                senderUid: currentUserId,
                // Use details from the auth record
                senderUsername,
                senderAvatar,
                read: false,
                createdAt: FieldValue.serverTimestamp(),
            });
        });

        return c.json({ success: true, message: `Successfully followed ${targetUserId}.` });

    } catch (error) {
        console.error("Follow operation failed:", error);
        return c.json({ error: 'Failed to follow user.' }, 500);
    }
});

/**
 * DELETE /api/user/:id/follow
 * Unfollows a user.
 *
 * IDEMPOTENT, and for a sharper reason than the add: an unconditional decrement
 * is a write anyone can aim at anyone. Unfollowing someone you do not follow
 * used to take one off THEIR follower count regardless, so the number on a
 * stranger's profile could be walked to zero and past it by repeating a request
 * that was, as far as the follow graph is concerned, a no-op.
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

        const followingRef = currentUserRef.collection('following').doc(targetUserId);
        const followerRef = targetUserRef.collection('followers').doc(currentUserId);

        await fs.runTransaction(async (transaction) => {
            // Every read before any write, as Firestore requires.
            const wasFollowing = (await transaction.get(followingRef)).exists;

            // Remove from subcollections. Unconditional: a half-written edge
            // from before this route was a transaction should still be cleaned
            // up by asking to unfollow.
            transaction.delete(followingRef);
            transaction.delete(followerRef);

            // Counters move only for a follow that was really there.
            if (!wasFollowing) return;

            transaction.set(currentUserRef, { followingCount: FieldValue.increment(-1) }, { merge: true });
            transaction.set(targetUserRef, { followerCount: FieldValue.increment(-1) }, { merge: true });
        });

        return c.json({ success: true, message: `Successfully unfollowed ${targetUserId}.` });

    } catch (error) {
        console.error("Unfollow operation failed:", error);
        return c.json({ error: 'Failed to unfollow user.' }, 500);
    }
});

export default route;