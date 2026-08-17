// lib/api.ts

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import {
  getAuth,
  getIdToken,
  signInAnonymously,
  User
} from "firebase/auth";
import { Platform } from 'react-native';
import uuid from 'react-native-uuid';
import { Group, Item, List, Meal, MealPreferences, PendingInvitation, Recipe, UserProfile, UserSearchResult } from "../types/types";
import { authStatePromise } from "./authState";
import { auth } from "./firebase";

// API root. Configure per environment via EXPO_PUBLIC_API_URL
// (e.g. in .env / eas.json build profiles):
//   local: http://<your-lan-ip>:3000/api
//   aws:   http://35.182.135.90:3000/api
//   prod:  https://api.fridgie.ca/api
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://api.fridgie.ca/api"

export interface GroupInvitation {
  id: string;
  groupId: string;
  groupName: string;
  inviterName: string;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Thrown by updateList when the server rejects a save because someone else
 * committed first. `list` is the winning document to rebase onto.
 */
export class StaleRevError extends Error {
  rev: number;
  list: List;

  constructor(rev: number, list: List) {
    super('stale_rev');
    this.name = 'StaleRevError';
    this.rev = rev;
    this.list = list;
  }
}

/**
 * Stable for the lifetime of this app instance. The server echoes it back as
 * `lastClientId` on the WS broadcast so we can tell our own writes from someone
 * else's, instead of guessing with a wall-clock window.
 */
export const CLIENT_ID: string = String(uuid.v4());

/** IANA zone, required by GET /list so week boundaries are computed locally. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Wraps fetch() to:
 * 1) Ensure we have a Firebase user (anon or real)
 * 2) Force-refresh their ID token
 * 3) Inject it as an Authorization: Bearer <token> header
 */
async function authorizedFetch(
  input: RequestInfo,
  init: RequestInit = {},
  /** Statuses to return rather than throw on, so the caller can read the body. */
  allowStatus: number[] = []
): Promise<Response> {
  await authStatePromise;
  let user = auth.currentUser
  if (!user) {
    const result = await signInAnonymously(auth)
    user = result.user
  }
  const token = await getIdToken(user, true)

  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  })

  if (!res.ok && !allowStatus.includes(res.status)) {
    // Try to get a more specific error message from the response body
    const errorBody = await res.text();
    const errorMessage = errorBody || `Request failed with status ${res.status}`;
    throw new ApiError(errorMessage, res.status);
  }


  return res;
}

// ─────── LISTS ───────────────────────────────────────────────────────────────

export async function getLists(groupId: string) {
  // `tz` is REQUIRED — the server 400s without it, and uses it to compute the
  // Sunday week boundary in the user's own zone rather than UTC.
  const tz = encodeURIComponent(deviceTimeZone())
  const res = await authorizedFetch(`${BASE_URL}/list?groupId=${groupId}&tz=${tz}`)
  return res.json()
}

export async function getList(groupId: string, listId: string) {
  const res = await authorizedFetch(
    `${BASE_URL}/list/${listId}?groupId=${groupId}`
  )
  return res.json()
}

export async function createList(
  groupId: string,
  weekStart: string
) {
  const res = await authorizedFetch(`${BASE_URL}/list?groupId=${groupId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart }),
  })
  return res.json()
}

/**
 * Saves a list. Always sends `clientId` so the server can tag its broadcast,
 * and sends `rev` when the caller knows the revision it built this edit on —
 * the server then rejects the save with 409 instead of clobbering a concurrent
 * editor. A 409 is surfaced as StaleRevError carrying the winning document.
 */
export async function updateList(
  groupId: string,
  listId: string,
  data: any,
  rev?: number
): Promise<{ status: string; rev: number }> {
  const body = { ...data, clientId: CLIENT_ID, ...(typeof rev === 'number' ? { rev } : {}) }

  const res = await authorizedFetch(
    `${BASE_URL}/list/${listId}?groupId=${groupId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    [409]
  )

  const json = await res.json()
  if (res.status === 409) {
    throw new StaleRevError(json.rev, json.list)
  }
  return json
}

export async function categorizeList(
  groupId: string,
  listId: string,
  items: Item[]
): Promise<Item[]> {
  // Must be wrapped in an object — the server reads `body.items`. Sending a bare
  // array made it silently fall back to its own (stale) DB snapshot and then
  // overwrite the list with it, dropping unsaved edits including overrideBase.
  const res = await authorizedFetch(
    `${BASE_URL}/list/categorize/${listId}?groupId=${groupId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    }
  )
  return res.json()
}

// ─────── GROUPS ────────────────────────────────────────────────────────────

export async function getGroups(): Promise<Group[]> {
  const res = await authorizedFetch(`${BASE_URL}/group`)
  return res.json()
}

// Returns the server's user document, not a Firebase auth User — those share
// almost no fields, so the old `Promise<User>` annotation was actively wrong.
export async function getUserProfile(uid: string): Promise<UserProfile> {
  const res = await authorizedFetch(`${BASE_URL}/user/${uid}`)
  return res.json()
}

export async function followUser(uid: string): Promise<void> {
    await authorizedFetch(`${BASE_URL}/user/follow/${uid}`, { method: 'POST' });
}

export async function unfollowUser(uid: string): Promise<void> {
    await authorizedFetch(`${BASE_URL}/user/follow/${uid}`, { method: 'DELETE' });
}



// --- Group Management API ---
export async function sendGroupInvitation(groupId: string, inviteeUid: string): Promise<void> {
  console.log("SENDING GROUP INVITE");
  await authorizedFetch(`${BASE_URL}/group/invitation/${groupId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteeUid }),
  });
}

export async function getPendingInvitations(groupId: string): Promise<PendingInvitation[]> {
  console.log("getting pending invitations");
    const res = await authorizedFetch(`${BASE_URL}/group/invitation/${groupId}`);
    return res.json();
}

/**
 * Membership is sent as a DELTA, never as an absolute list — an absolute list
 * computed when the editor opened would silently eject anyone who accepted an
 * invitation while it was open.
 */
export async function updateGroup(
    groupId: string,
    updates: { name?: string; addMembers?: string[]; removeMembers?: string[] }
): Promise<void> {
    await authorizedFetch(`${BASE_URL}/group/${groupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
}

export async function deleteGroup(groupId: string): Promise<void> {
  console.log("CALLING DELETE GROUP");
  await authorizedFetch(`${BASE_URL}/group/${groupId}`, { method: 'DELETE' });
}

export async function acceptGroupInvitation(invitationId: string): Promise<void> {
  await authorizedFetch(`${BASE_URL}/invitation/accept/${invitationId}`, { method: 'POST' });
}

export async function declineGroupInvitation(invitationId: string): Promise<void> {
  await authorizedFetch(`${BASE_URL}/invitation/decline/${invitationId}`, { method: 'POST' });
}


// --- Notification API ---
export async function getMyNotifications(): Promise<any[]> { // Define a proper Notification type later
    const res = await authorizedFetch(`${BASE_URL}/notification`);
    return res.json();
}

export async function dismissNotification(notificationId: string): Promise<void> {
    await authorizedFetch(`${BASE_URL}/notification/${notificationId}`, { method: 'DELETE' });
}

/**
 * Searches for users by a query string.
 * @param query The search term (name, email, or phone).
 * @returns A promise that resolves to an array of matching user profiles.
 */
export async function searchUsers(query: string): Promise<UserProfile[]> {
  // Avoid sending empty requests to the backend
  if (!query.trim()) {
    return [];
  }
  const res = await authorizedFetch(`${BASE_URL}/user?q=${encodeURIComponent(query)}`);
  return res.json();
}

/**
 * Creates a new group with a given name and members.
 * @param name The name of the group.
 * @param memberUids An array of user UIDs to invite to the group.
 * @returns A promise that resolves to the newly created group.
 */
export async function createGroup(name: string, inviteeUids?: string[]): Promise<Group> {
  const body: {name: string, inviteeUids?: string[]} = { name, inviteeUids };

  const res = await authorizedFetch(`${BASE_URL}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), // Pass members in the body
  });
  return res.json();
}

export async function registerForPushNotificationsAsync() {
  let token;

  // Check for existing permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // If we don't have permission, ask for it
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  // If the user still didn't grant permission, we can't get a token
  if (finalStatus !== 'granted') {
    alert('Failed to get push token for push notification!');
    return;
  }

  // Before the token fetch, not after: the channel is Android display setup and
  // has nothing to do with tokens, but it used to sit past two `return`s that
  // fire on simulators and on any token failure — so it was often never created.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  } catch (error) {
    // Simulators and misconfigured builds can't get a push token.
    console.warn('Could not get Expo push token', error);
    return;
  }

  // --- 👇 SEND TOKEN TO YOUR SERVER ---
  // This is the crucial step where you link the device to the user
  try {
    // Singular /notification — matches every other notification route. This was
    // pluralised, so every push token silently 404'd and was never persisted.
    await authorizedFetch(`${BASE_URL}/notification/save-push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    const status = error instanceof ApiError ? ` (HTTP ${error.status})` : '';
    console.error(`Could not save push token to server${status}`, error);
  }

  return token;
}

import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

export async function uploadImage(uri: string, path: string): Promise<string> {
  if(!auth.currentUser) throw new Error("User not found");
  if(!uri.startsWith('file://') && !uri.startsWith('data:image')) {
    return uri;
  }
  const response = await fetch(uri);
  const blob = await response.blob();
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob);
  return await getDownloadURL(storageRef);
}

export async function uploadUserPhoto(uri: string): Promise<string> {
  if(!auth.currentUser) throw new Error("User not found");
  const path = `profile_images/${auth.currentUser.uid}`;
  return await uploadImage(uri, path);
}

export async function uploadRecipePhoto(uri: string, recipeId: string) {
  if(!auth.currentUser) throw new Error("User not found");
  const path = `recipe_images/${recipeId}/${Date.now()}`;
  return await uploadImage(uri, path);
}

export async function saveRecipe(recipe: Recipe): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // For POST, send the whole data, for PUT, the backend might only need the changed fields,
    // but sending the whole object is a common pattern for simplicity.
    body: JSON.stringify(recipe),
  });
  return res.json();
}

export async function searchAll(query: string): Promise<{ recipes: Recipe[], users: UserSearchResult[] }> {
  const res = await authorizedFetch(`${BASE_URL}/explore/search?q=${encodeURIComponent(query)}`);
  return res.json();
}


export async function getRecipe(recipeId: string): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe/${recipeId}`);
  return res.json();
}


// The post-meal rating prompt is scheduled on the device now — see
// utils/mealReminders.ts. It was posted to the server here, which stored a job
// nothing ever read, so no reminder was ever delivered.

/**
 * Sends user preferences to the backend to get a meal suggestion.
 * @param preferences An object containing the user's meal preferences.
 * @returns A promise that resolves to a meal suggestion.
 */
export async function getMealSuggestions(vetoedTitles?: string[]): Promise<Recipe[]> {
  const res = await authorizedFetch(`${BASE_URL}/meal/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vetoedTitles }),
  });
  return res.json();
}

export async function saveMealPreferences(preferences: MealPreferences): Promise<MealPreferences> {
  const res = await authorizedFetch(`${BASE_URL}/meal/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
  return res.json();

}

export const getMealPreferences = async (): Promise<MealPreferences> => {
  const res = await authorizedFetch(`${BASE_URL}/meal/preferences`, {
    method: 'GET',
  });
  return res.json()
};

export async function getExploreContent(): Promise<any> {
  const res = await authorizedFetch(`${BASE_URL}/explore`);
  return res.json();
}


// ─────── REAL-TIME UPDATES ──────────────────────────────────────────────────

export async function listenToList(
  groupId: string,
  id: string,
  onData: (data: any) => void,
  onError?: (err: any) => void
) {
  const wsUrl = BASE_URL.replace(/^http/, "ws");

  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = async () => {
    if (closed) return;

    const user = getAuth().currentUser;
    if (!user) {
      const authError = new Error("User is not authenticated.");
      console.error(authError);
      onError?.(authError);
      return;
    }

    // Fetch a fresh token each (re)connect — the previous one may have expired.
    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch (err) {
      onError?.(err);
      scheduleReconnect();
      return;
    }
    if (closed) return;

    ws = new WebSocket(`${wsUrl}/ws/list/${id}?groupId=${groupId}&token=${idToken}`);

    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (e) => {
      try {
        onData(JSON.parse(e.data));
      } catch (err) {
        console.error("WS parse error", err);
      }
    };
    ws.onerror = (err) => {
      console.warn("WS error", err);
      onError?.(err);
    };
    ws.onclose = () => {
      // Reconnect with backoff unless this listener was unsubscribed.
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    reconnectTimer = setTimeout(connect, delay);
  };

  await connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws && ws.readyState <= 1) ws.close();
  };
}

// lib/api.ts
// export async function loginWithToken(idToken: string, setUserProfile: (profile: any) => void) {
export async function loginWithToken(idToken: string) {
  const res = await fetch(`${BASE_URL}/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error('Login failed');

  // const { user } = await res.json(); // ⬅️ Parse the user profile from the response
  // if (user) {
    // setUserProfile(user); // ⬅️ Pass it to the callback
  // }
  await res.json();
}

/**
 * Reads a recipe out of a photograph of a printed or handwritten page.
 *
 * The image goes up as a base64 data URL rather than via Storage: it's
 * transient input, not something the user is saving, so uploading it would
 * leave orphaned objects and expose a publicly-readable URL for what might be
 * a photo of someone's private notebook.
 */
export async function importRecipeFromPhoto(imageDataUrl: string): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe/import/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl }),
  });
  return res.json();
}

export async function importRecipeFromUrl(url: string): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  console.log("import results:", res);
  return res.json();
}


/**
 * Submits feedback (like/dislike) for a specific recipe.
 * @param recipeId The ID of the recipe.
 * @param rating 'liked' or 'disliked'.
 * @param feedback Optional feedback text, primarily for dislikes.
 * @param mealId The meal that prompted the rating, so the server can tie the
 *   verdict back to the occasion it was cooked.
 */
export async function submitRecipeFeedback(
  recipeId: string,
  rating: 'liked' | 'disliked',
  feedback?: string,
  mealId?: string
) {
  const res = await authorizedFetch(`${BASE_URL}/recipe/feedback/${recipeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, feedback, mealId }),
  });
  return res.json();
}

/**
 * Adds a recipe to the current user's personal cookbook.
 * @param recipeId The ID of the recipe to add.
 */
export async function addUserCookbookRecipe(recipeId: string): Promise<void> {
  await authorizedFetch(`${BASE_URL}/cookbook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipeId }),
  });
}

/**
 * Removes a recipe from the current user's personal cookbook.
 * @param recipeId The ID of the recipe to remove.
 */
export async function removeUserCookbookRecipe(recipeId: string): Promise<void> {
  await authorizedFetch(`${BASE_URL}/cookbook/${recipeId}`, {
    method: 'DELETE',
  });
}

/**
 * Retrieves the current user's personal cookbook (a list of recipes).
 */
export async function getUserCookbook(uid: string): Promise<Recipe[]> {
  console.log("getting cookbook for uid", uid);
  const res = await authorizedFetch(`${BASE_URL}/cookbook/${uid}`);
  return res.json();
}

export async function addRecipeToList(groupId: string, listId: string, recipe: Recipe): Promise<Meal> {
  console.log(groupId)
    const res = await authorizedFetch(`${BASE_URL}/meal?groupId=${groupId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        // The body now contains all the necessary info
        body: JSON.stringify({ groupId, listId, recipe }),
    });

    return res.json();
}