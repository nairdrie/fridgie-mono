// lib/api.ts

import {
  getIdToken,
  signInAnonymously,
  User
} from "firebase/auth";
import { Group, Item, Meal, MealPreferences, Recipe } from "../types/types";
import { authStatePromise } from "./authState";
import { auth } from "./firebase";

// your API root
const BASE_URL = "http://192.168.2.193:3000/api" // LOCAL
// const BASE_URL = "http://35.182.135.90:3000/api" // AWS

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
  // ✅ Wait for the initial auth check to complete
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
export async function createGroup(name: string, memberUids?: string[]): Promise<Group> {
  const body: {name: string, memberUids?: string[]} = { name };
  if (memberUids) {
    body['memberUids'] = memberUids;
  }
  const res = await authorizedFetch(`${BASE_URL}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), // Pass members in the body
  });
  return res.json();
}


export async function createMeal(
  groupId: string,
  listId: string,
  dayOfWeek: Meal['dayOfWeek']
): Promise<Meal> {
  // In a real app, this would hit your backend.
  const newMeal: Meal = {
    id: Math.random().toString(36).substring(2, 15),
    listId: listId,
    name: 'New Meal', // Default name
    dayOfWeek: dayOfWeek,
  };
  // Here, you would typically wait for the backend response.
  // We'll return the mock object directly.
  return newMeal;
}

export async function updateMeal(
  groupId: string,
  mealId: string,
  data: Partial<Meal>
) {
  // This would hit your backend to save changes to a meal.
  // Since our listener will provide the "updated" data, we don't need to return anything.
}

export async function deleteMeal(groupId: string, mealId: string) {
  // This would hit your backend to delete a meal.
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

export function listenToList(
  groupId: string,
  id: string,
  onData: (data: any) => void,
  onError?: (err: any) => void
) {
  const wsUrl = BASE_URL.replace(/^http/, "ws")
  const ws = new WebSocket(`${wsUrl}/ws/list/${id}?groupId=${groupId}`)

  ws.onmessage = (e) => {
    try {
      onData(JSON.parse(e.data))
    } catch (err) {
      console.error("WS parse error", err)
    }
  }
  ws.onerror = (err) => {
    console.warn("WS error", err)
    onError?.(err)
  }
  ws.onclose = () => {
  }

  return () => {
    if (ws.readyState <= 1) ws.close()
  }
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


