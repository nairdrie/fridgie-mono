// Post-meal rating reminders, scheduled on the device.
//
// These used to be posted to the server, which wrote a job to RTDB that nothing
// ever read — so no reminder was ever delivered. A server round trip was never
// needed: the reminder is for the same person who set the day, at a time their
// own device can compute the moment they set it. The OS holds the notification
// and fires it whether or not the app is running, with no push token, no APNs
// or FCM credentials, and nothing to schedule server-side.
//
// The trade is that a reminder only fires on the device that set the day, and
// is lost if the app is reinstalled. The in-app prompt on app open (see
// app/(tabs)/list.tsx) is the backstop for both cases.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { DayOfWeek } from '@/types/types';
import { MEAL_RATING_ENABLED } from '@/constants/features';
import { parseWeekStart } from './date';

const DAY_INDEX: Record<DayOfWeek, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

/** Local hour on the meal's day at which to ask how it went. */
export const RATING_PROMPT_HOUR = 20;

/**
 * Deterministic per-meal identifier, so re-scheduling a meal that moved day
 * REPLACES its reminder instead of stacking a second one.
 */
const reminderId = (listId: string, mealId: string) => `meal-rating:${listId}:${mealId}`;

/** The local moment we should ask about a meal planned for `dayOfWeek`. */
export function mealReminderDate(weekStart: string, dayOfWeek: DayOfWeek): Date {
  // parseWeekStart reads the key as a LOCAL date; `new Date('yyyy-MM-dd')`
  // would be UTC midnight, i.e. the previous day west of Greenwich.
  const date = parseWeekStart(weekStart);
  date.setDate(date.getDate() + DAY_INDEX[dayOfWeek]);
  date.setHours(RATING_PROMPT_HOUR, 0, 0, 0);
  return date;
}

/**
 * Permission and the Android channel, established independently of the push
 * token flow. Local notifications need neither a token nor a project, so this
 * must not depend on `registerForPushNotificationsAsync` having succeeded —
 * that bails early on simulators and on any token failure.
 */
async function ensureLocalNotificationsReady(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (status !== 'granted') {
    // Deliberately silent: this is a background nicety, not something to
    // interrupt someone with an alert over if they decline.
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== 'granted') return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }
  return true;
}

interface ScheduleArgs {
  listId: string;
  mealId: string;
  /** Required — the rating screen is per-recipe and cannot open without one. */
  recipeId: string;
  mealName: string;
  weekStart: string;
  dayOfWeek: DayOfWeek;
}

/**
 * Schedules (or re-schedules) the reminder for one meal. Safe to call on every
 * edit; the identifier makes it idempotent.
 */
export async function scheduleMealRatingReminder({
  listId, mealId, recipeId, mealName, weekStart, dayOfWeek,
}: ScheduleArgs): Promise<void> {
  // Meal rating is switched off for now (see constants/features.ts). Bail
  // before scheduling so no "How was dinner?" reminder is ever queued. Cancel
  // stays live below so a device carrying a reminder from before can still
  // shed it on the next edit.
  if (!MEAL_RATING_ENABLED) return;

  const date = mealReminderDate(weekStart, dayOfWeek);

  // Backfilling a day that has already passed shouldn't fire a notification
  // immediately — that reads as a bug. The app-open check catches those.
  if (date.getTime() <= Date.now()) {
    await cancelMealRatingReminder(listId, mealId);
    return;
  }

  if (!(await ensureLocalNotificationsReady())) return;

  await Notifications.scheduleNotificationAsync({
    identifier: reminderId(listId, mealId),
    content: {
      title: 'How was dinner?',
      body: mealName ? `Let us know what you thought of ${mealName}.` : 'Tap to rate tonight’s meal.',
      data: { type: 'meal-rating', recipeId, mealId },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
  });
}

/** Drops a meal's reminder — on delete, or when its day is cleared. */
export async function cancelMealRatingReminder(listId: string, mealId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(reminderId(listId, mealId));
  } catch {
    // Cancelling something that was never scheduled is not an error here.
  }
}
