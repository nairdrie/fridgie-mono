// lib/api.ts

import {
  getIdToken,
  signInAnonymously
} from "firebase/auth";
import { Group, Item, Meal } from "../types/types";
import { authStatePromise } from "./authState";
import { auth } from "./firebase";

// your API root
const BASE_URL = "http://192.168.2.193:3000/api"

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
  console.log(`try authorized fetch for ${input}. current auth state:  ${auth.currentUser} ${auth.currentUser?.uid} (${auth.currentUser?.isAnonymous})`);
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

export async function createGroup(name: string): Promise<Group> {
  const res = await authorizedFetch(`${BASE_URL}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return res.json()
}

export async function createMeal(
  groupId: string,
  listId: string,
  dayOfWeek: Meal['dayOfWeek']
): Promise<Meal> {
  console.log('FAKE API: Creating meal', { groupId, listId, dayOfWeek });
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
  console.log('FAKE API: Updating meal', { groupId, mealId, data });
  // This would hit your backend to save changes to a meal.
  // Since our listener will provide the "updated" data, we don't need to return anything.
}

export async function deleteMeal(groupId: string, mealId: string) {
  console.log('FAKE API: Deleting meal', { groupId, mealId });
  // This would hit your backend to delete a meal.
}

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
export async function loginWithToken(idToken: string, setUserProfile: (profile: any) => void) {
  const res = await fetch(`${BASE_URL}/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error('Login failed');

  const { user } = await res.json(); // ⬅️ Parse the user profile from the response
  if (user) {
    setUserProfile(user); // ⬅️ Pass it to the callback
  }
}

