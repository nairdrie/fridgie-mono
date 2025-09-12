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
import { Group, Item, Meal, MealPreferences, PendingInvitation, Recipe } from "../types/types";
import { authStatePromise } from "./authState";
import { auth } from "./firebase";

// your API root
const BASE_URL = "http://192.168.2.193:3000/api" // LOCAL
// const BASE_URL = "http://35.182.135.90:3000/api" // AWS

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
 * Wraps fetch() to:
 * 1) Ensure we have a Firebase user (anon or real)
 * 2) Force-refresh their ID token
 * 3) Inject it as an Authorization: Bearer <token> header
 */
async function authorizedFetch(
  input: RequestInfo,
  init: RequestInit = {}
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

  if (!res.ok) {
    // Try to get a more specific error message from the response body
    const errorBody = await res.text();
    const errorMessage = errorBody || `Request failed with status ${res.status}`;
    throw new ApiError(errorMessage, res.status);
  }


  return res;
}

// ─────── LISTS ───────────────────────────────────────────────────────────────

export async function getLists(groupId: string) {
  const res = await authorizedFetch(`${BASE_URL}/list?groupId=${groupId}`)
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

export async function updateList(
  groupId: string,
  listId: string,
  data: any
) {
  const res = await authorizedFetch(
    `${BASE_URL}/list/${listId}?groupId=${groupId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  )
  return res.json()
}

export async function categorizeList(
  groupId: string,
  listId: string
): Promise<Item[]> {
  const res = await authorizedFetch(
    `${BASE_URL}/list/categorize/${listId}?groupId=${groupId}`,
    { method: 'POST' }
  )
  return res.json()
}

// ─────── GROUPS ────────────────────────────────────────────────────────────

export async function getGroups(): Promise<Group[]> {
  const res = await authorizedFetch(`${BASE_URL}/group`)
  return res.json()
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

export async function updateGroup(groupId: string, updates: { name?: string; members?: string[] }): Promise<void> {
    // Placeholder for updating group name or removing a member
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

/**
 * Searches for users by a query string.
 * @param query The search term (name, email, or phone).
 * @returns A promise that resolves to an array of matching user profiles.
 */
export async function searchUsers(query: string): Promise<User[]> {
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

  // You must use a real device for push notifications, not a simulator
  if (!Constants.isDevice) {
    console.error("Must use physical device for Push Notifications");
    return;
  }

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

  // This is the magic function that gets the token
  token = (await Notifications.getExpoPushTokenAsync()).data;
  console.log('My Expo Push Token:', token);

  // --- 👇 SEND TOKEN TO YOUR SERVER ---
  // This is the crucial step where you link the device to the user
  try {
    // Use your existing authorizedFetch or API utility
    await authorizedFetch(`${BASE_URL}/notifications/save-push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.error("Could not save push token to server", error);
  }

  // Recommended for Android
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  return token;
}

import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

export async function uploadImage(uri: string, path: string): Promise<string> {
  if(!auth.currentUser) throw new Error("User not found");
  if(!uri.startsWith('file://')) {
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

export async function getRecipe(recipeId: string): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe/${recipeId}`);
  return res.json();
}


export async function scheduleMealRating(mealId: string, listId: string, dayOfWeek: string) {
  const res = await authorizedFetch(`${BASE_URL}/notifications/schedule-rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mealId, listId, dayOfWeek }),
  });
  return res.json();
}

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

// ─────── REAL-TIME UPDATES ──────────────────────────────────────────────────

export async function listenToList(
  groupId: string,
  id: string,
  onData: (data: any) => void,
  onError?: (err: any) => void
) {
  const auth = getAuth();
  const user = auth.currentUser;

  // 3. Handle the case where no user is logged in
  if (!user) {
    const authError = new Error("User is not authenticated.");
    console.error(authError);
    onError?.(authError);
    // Return an empty unsubscribe function to prevent crashes
    return () => {}; 
  }

  // 4. Get the ID token asynchronously
  const idToken = await user.getIdToken();

  // The rest of your code is now correct
  const wsUrl = BASE_URL.replace(/^http/, "ws");
  const ws = new WebSocket(
    `${wsUrl}/ws/list/${id}?groupId=${groupId}&token=${idToken}`
  );

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
    // You could optionally call onError here as well
  };

  return () => {
    if (ws.readyState <= 1) ws.close();
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

export async function importRecipeFromUrl(url: string): Promise<Recipe> {
  const res = await authorizedFetch(`${BASE_URL}/recipe/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return res.json();
}


/**
 * Submits feedback (like/dislike) for a specific recipe.
 * @param recipeId The ID of the recipe.
 * @param rating 'liked' or 'disliked'.
 * @param feedback Optional feedback text, primarily for dislikes.
 */
export async function submitRecipeFeedback(recipeId: string, rating: 'liked' | 'disliked', feedback?: string) {
  const res = await authorizedFetch(`${BASE_URL}/recipe/feedback/${recipeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, feedback }),
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
export async function getUserCookbook(): Promise<Recipe[]> {
  const res = await authorizedFetch(`${BASE_URL}/cookbook`);
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