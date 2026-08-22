// The one place the app admits it is offline.
//
// This is deliberately quiet. A grocery list that keeps working with no signal
// only feels trustworthy if it does not make a fuss about it — the previous
// behaviour, replacing the entire tab with "Can't reach Fridgie", was the
// opposite and is why this exists. So:
//
//   synced   nothing at all, most of the time
//   saving   nothing, unless it lasts long enough to be worth mentioning
//   offline  a calm line saying the edits are on the phone, with the time
//   lost     a merge took something the user typed — the ONE case worth
//            interrupting for, because it is the only one where their work
//            actually changed under them
//
// The last is the honest half of the bargain. Merging silently is right for the
// other 99% of cases, where nothing of anyone's is lost; when something IS
// lost, saying nothing would be hiding it.

import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { primary } from '@/utils/styles';
import type { ListSyncEngine, SyncState } from '@/utils/listSync';

/** A save that finishes inside this window isn't worth telling anyone about. */
const SAVING_VISIBLE_AFTER_MS = 1500;
/** How long the "saved" tick lingers once a queue of offline edits goes out. */
const SYNCED_LINGER_MS = 2500;

function timeOfDay(at: number): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function SyncStatus({ engine }: { engine: ListSyncEngine | null }) {
  const [state, setState] = useState<SyncState | null>(null);
  const [showSaving, setShowSaving] = useState(false);
  const [showSynced, setShowSynced] = useState(false);
  const wasBehindRef = useRef(false);

  useEffect(() => {
    if (!engine) {
      setState(null);
      return;
    }
    return engine.subscribe(setState);
  }, [engine]);

  const status = state?.status ?? 'synced';

  // "Saving" only earns a line if it is taking a while. Flashing it on every
  // keystroke's debounce would make a working app look like a struggling one.
  useEffect(() => {
    if (status !== 'saving') {
      setShowSaving(false);
      return;
    }
    const timer = setTimeout(() => setShowSaving(true), SAVING_VISIBLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Confirm, briefly, but only for someone who was actually waiting on it —
  // there is no point telling a user their list synced if it was never behind.
  useEffect(() => {
    if (status === 'offline' || status === 'pending') {
      wasBehindRef.current = true;
      return;
    }
    if (status === 'synced' && wasBehindRef.current) {
      wasBehindRef.current = false;
      setShowSynced(true);
      const timer = setTimeout(() => setShowSynced(false), SYNCED_LINGER_MS);
      return () => clearTimeout(timer);
    }
  }, [status]);

  if (!engine || !state) return null;

  const conflicts = state.conflicts;

  if (conflicts.length > 0) {
    const first = conflicts[0];
    const others = conflicts.length - 1;
    const what = first?.label ? `"${first.label}"` : 'an item';
    return (
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.bar, styles.conflictBar]}
      >
        <Ionicons name="git-merge-outline" size={16} color="#8a5a00" />
        <Text style={styles.conflictText} numberOfLines={2}>
          Someone else&apos;s change to {what} won
          {others > 0 ? ` (and ${others} more)` : ''} while you were offline.
        </Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => engine.undoConflicts()}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.undo}>Undo</Text>
          </Pressable>
          <Pressable onPress={() => engine.dismissConflicts()} hitSlop={8} accessibilityRole="button">
            <Ionicons name="close" size={18} color="#8a5a00" />
          </Pressable>
        </View>
      </Animated.View>
    );
  }

  if (status === 'offline') {
    const at = timeOfDay(state.savedAt);
    return (
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.bar, styles.offlineBar]}
      >
        <Ionicons name="cloud-offline-outline" size={16} color="#5b6470" />
        <Text style={styles.offlineText} numberOfLines={1}>
          Offline — saved on this phone{at ? ` at ${at}` : ''}
        </Text>
      </Animated.View>
    );
  }

  if (showSaving) {
    return (
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.bar, styles.offlineBar]}
      >
        <Ionicons name="sync-outline" size={16} color="#5b6470" />
        <Text style={styles.offlineText}>Syncing…</Text>
      </Animated.View>
    );
  }

  if (showSynced) {
    return (
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.bar, styles.syncedBar]}
      >
        <Ionicons name="checkmark-circle-outline" size={16} color={primary} />
        <Text style={[styles.offlineText, { color: primary }]}>Synced</Text>
      </Animated.View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
  },
  offlineBar: { backgroundColor: '#f1f3f5' },
  syncedBar: { backgroundColor: '#eef7f0' },
  conflictBar: { backgroundColor: '#fff4d9' },
  offlineText: { flex: 1, fontSize: 13, color: '#5b6470' },
  conflictText: { flex: 1, fontSize: 13, color: '#8a5a00', lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  undo: { fontSize: 13, fontWeight: '700', color: '#8a5a00' },
});
