// components/CarryOverBanner.tsx
//
// WHY THIS EXISTS
//
// A list belongs to a week, and weeks are separate documents. So on Sunday
// morning the app rolls to a fresh list and everything you didn't manage to buy
// is stranded in last week's — still there, still correct, and two taps into a
// week picker that most people never open. The things most likely to be
// stranded are the things you already failed to get once.
//
// WHY IT ASKS RATHER THAN JUST DOING IT
//
// Copying rows forward automatically would be a server-side write to a document
// the user is not looking at, driven by a guess about what they meant. Get that
// wrong and a fresh list starts dirty, which is worse than the problem — the
// whole point of a new week is the clean slate. So this offers, once, and
// takes a no for an answer.
//
// WHEN IT DOESN'T APPEAR
//
// Only when last week's shop actually HAPPENED — at least one row was ticked
// off. That single condition is what separates "we shopped and missed a few"
// from "we never went", and without it a household that planned four meals and
// then ordered a takeaway would be offered forty ingredients for meals that are
// no longer on the plan.

import { Item, List, ListSummary } from '@/types/types';
import { getList } from '@/utils/api';
import { hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface CarryOverBannerProps {
  groupId: string | undefined;
  /** The week being looked at — the one rows would be carried INTO. */
  currentList: List | null;
  /** Every week this group has, so the previous one can be found. */
  allLists: ListSummary[];
  /**
   * Called with rows ready to append. They carry no `listOrder` and no id yet:
   * ranking is the list screen's job, which is where the rest of the list is.
   */
  onCarryOver: (rows: Omit<Item, 'id' | 'listOrder'>[]) => void;
}

/** Offered once per list. A dismissed banner must not come back on every focus. */
const offeredKey = (listId: string) => `carryOverOffered:${listId}`;

export default function CarryOverBanner({ groupId, currentList, allLists, onCarryOver }: CarryOverBannerProps) {
  const [pending, setPending] = useState<Item[] | null>(null);

  const currentListId = currentList?.id;
  const currentWeekStart = currentList?.weekStart;

  useEffect(() => {
    if (!groupId || !currentListId || !currentWeekStart) {
      setPending(null);
      return;
    }

    let ignore = false;

    const check = async () => {
      // Already answered, either way.
      const offered = await AsyncStorage.getItem(offeredKey(currentListId));
      if (offered || ignore) return;

      // The week immediately before this one. Compared as bare `yyyy-MM-dd`
      // keys, which sort lexicographically — `weekStart` is sometimes a full
      // ISO datetime, hence the slice.
      const key = (w: string) => (w ?? '').slice(0, 10);
      const thisKey = key(currentWeekStart);
      const previous = allLists
        .filter((l) => key(l.weekStart) < thisKey)
        .sort((a, b) => key(b.weekStart).localeCompare(key(a.weekStart)))[0];
      if (!previous) return;

      let last: List;
      try {
        last = await getList(groupId, previous.id);
      } catch (error) {
        // A week we can't read is a week with nothing to offer. Silent on
        // purpose: this is an unprompted nicety, not something the user asked
        // for, so it has no business raising an error at them.
        console.error('Could not read last week for carry-over:', error);
        return;
      }
      if (ignore) return;

      const rows: Item[] = Array.isArray(last.items) ? last.items : [];
      const real = rows.filter((r) => r && !r.isSection && (r.text ?? '').trim() !== '');

      // The shop has to have happened. See the header comment.
      if (!real.some((r) => r.checked)) return;

      const unbought = real.filter((r) => !r.checked);
      if (unbought.length === 0) return;

      setPending(unbought);
    };

    check();
    return () => { ignore = true; };
  }, [groupId, currentListId, currentWeekStart, allLists]);

  const close = async () => {
    setPending(null);
    if (currentListId) {
      await AsyncStorage.setItem(offeredKey(currentListId), '1').catch(() => {});
    }
  };

  const accept = async () => {
    if (!pending) return;
    onCarryOver(
      pending.map((row) => ({
        text: row.text,
        quantity: row.quantity,
        checked: false,
        isSection: false,
        // `mealId` is deliberately dropped. The meal it belonged to lives on
        // last week's plan and is not on this one; a row pointing at a meal
        // that isn't here would be grouped under nothing in the meal view and
        // would break the staple rules, which read `mealId` as "the app put
        // this here".
        //
        // `section` goes too, so the row is re-filed into an aisle that exists
        // on THIS list rather than one whose heading was never carried over.
      })),
    );
    await close();
  };

  if (!pending || pending.length === 0) return null;

  const count = pending.length;
  const preview = pending.slice(0, 3).map((r) => (r.text ?? '').trim()).filter(Boolean).join(', ');

  return (
    <View style={styles.banner}>
      <Ionicons name="arrow-forward-circle-outline" size={20} color={primary} />
      <View style={styles.body}>
        <Text style={styles.title}>
          {count} thing{count === 1 ? '' : 's'} you didn&apos;t get last week
        </Text>
        {!!preview && (
          <Text style={styles.preview} numberOfLines={1}>
            {preview}{count > 3 ? ` and ${count - 3} more` : ''}
          </Text>
        )}
      </View>
      <Pressable
        style={styles.action}
        onPress={accept}
        accessibilityRole="button"
        accessibilityLabel={`Add ${count} items from last week to this list`}
      >
        <Text style={styles.actionText}>Add</Text>
      </Pressable>
      <Pressable
        style={styles.dismiss}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={8}
      >
        <Ionicons name="close" size={18} color={inkFaint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: surface,
    borderWidth: 1,
    borderColor: hairline,
  },
  body: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: ink },
  preview: { fontSize: 12, color: inkMuted, marginTop: 2 },
  action: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: primary },
  actionText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  dismiss: { paddingHorizontal: 2 },
});
