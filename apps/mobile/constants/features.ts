/**
 * Feature flags for flows that are intentionally switched off for now.
 *
 * Each flag is read at the entry points of its flow, so turning a feature back
 * on is a one-line change here — nothing else has to move. Kept as plain
 * constants (not env/remote config) on purpose: these are deliberate on/off
 * decisions in the build, not per-user or per-environment toggles.
 */

/**
 * Remote push notifications: asking for notification permission on login and
 * registering the device's Expo push token with the server. Nothing consumes
 * the stored token yet (no server-side send path exists), so the whole
 * registration — permission prompt included — is held back until it does.
 */
export const PUSH_NOTIFICATIONS_ENABLED: boolean = false;

/**
 * The post-meal rating flow: the on-device "How was dinner?" reminders, the
 * notification tap that opens the rating screen, and the app-open prompt that
 * pushes past unrated meals into it. Off for now; the rate-meal screen stays
 * registered so nothing else has to change to bring it back.
 */
export const MEAL_RATING_ENABLED: boolean = false;
