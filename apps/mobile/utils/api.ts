// lib/api.ts

import {
  getIdToken,
  signInAnonymously
} from "firebase/auth";
import { Group, Item } from "../types/types";
import { auth } from "./firebase";

// your API root
const BASE_URL = "http://192.168.2.193:3000/api"

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
  let user = auth.currentUser
  if (!user) {
    const result = await signInAnonymously(auth)
    user = result.user
  }
  const token = await getIdToken(user, /* forceRefresh= */ true)

  return fetch(input, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  })
}

// ─────── LISTS ───────────────────────────────────────────────────────────────

export async function getLists(groupId: string) {
  const res = await authorizedFetch(`${BASE_URL}/list?groupId=${groupId}`)
  if (!res.ok) throw new Error('Failed to fetch lists')
  return res.json()
}

export async function getList(groupId: string, listId: string) {
  const res = await authorizedFetch(
    `${BASE_URL}/list/${listId}?groupId=${groupId}`
  )
  if (!res.ok) throw new Error('Failed to fetch list')
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
  if (!res.ok) throw new Error('Failed to create list')
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
  if (!res.ok) throw new Error('Failed to update list')
}

export async function categorizeList(
  groupId: string,
  listId: string
): Promise<Item[]> {
  const res = await authorizedFetch(
    `${BASE_URL}/list/categorize/${listId}?groupId=${groupId}`,
    { method: 'POST' }
  )
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ─────── GROUPS ────────────────────────────────────────────────────────────

export async function getGroups(): Promise<Group[]> {
  const res = await authorizedFetch(`${BASE_URL}/group`)
  if (!res.ok) throw new Error(`Failed to fetch groups (${res.status})`)
  return res.json()
}

export async function createGroup(name: string): Promise<Group> {
  const res = await authorizedFetch(`${BASE_URL}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create group: ${text}`)
  }
  return res.json()
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
export async function loginWithToken(idToken: string) {
  const res = await fetch(`${BASE_URL}/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error('Login failed');
}

