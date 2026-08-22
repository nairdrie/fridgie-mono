// Persistence for the household's staples.
//
// The rules for WHAT counts as a rejection live in packages/shared/staples.ts,
// with the client, because the client has to recognise the same rows. This file
// is only storage: counters in, a set of keys out.
//
// Shape at `groupStaples/{groupId}/{stapleKey}`:
//
//   n           how many times this household has rejected the row
//   at          when the last rejection happened, for debugging a wrong answer
//   name        the wording last seen, so the UI can say "olive oil" rather
//               than "olive-oil" — display only, never matched on
//   alwaysShow  the user has said they DO buy this. Permanent, and it beats
//               any count, which is what stops the feature being a one-way door
//
// Keyed by groupId so a shared household and a private list never teach each
// other: "we always have parmesan" is a fact about a kitchen, not a person.

import { ServerValue } from 'firebase-admin/database'
import { adminRtdb } from './firebase'
import { STAPLE_THRESHOLD } from '@fridgie/shared/staples'

interface StapleRecord {
  n?: number
  at?: number
  name?: string
  alwaysShow?: boolean
}

const groupRef = (groupId: string) => adminRtdb.ref(`groupStaples/${groupId}`)

/**
 * Adds one rejection to each key.
 *
 * `ServerValue.increment` rather than a read-modify-write: two devices saving
 * the same list at once is the normal case here, not the exotic one, and a lost
 * increment is a staple that takes an extra week to promote.
 *
 * `alwaysShow` is deliberately NOT reset. Someone who has told us they buy this
 * has said something the counter cannot outvote — otherwise the next three
 * deletions would silently hide it again and there would be no way out.
 */
export async function recordStapleRejections(
  groupId: string,
  keys: string[],
  names: Record<string, string> = {},
): Promise<void> {
  if (!groupId || keys.length === 0) return

  const now = Date.now()
  const updates: Record<string, unknown> = {}
  for (const key of keys) {
    updates[`${key}/n`] = ServerValue.increment(1)
    updates[`${key}/at`] = now
    if (names[key]) updates[`${key}/name`] = names[key]
  }

  await groupRef(groupId).update(updates)
}

export interface StapleEntry {
  key: string
  /** Last wording seen for this staple. Display only. */
  name: string
  rejections: number
}

/**
 * Everything this household has told us about, staple or not.
 *
 * Returned whole rather than pre-filtered so the settings screen can show the
 * near-misses too — a user who wants to know why the app hid the paprika
 * deserves to see the count that did it.
 */
export async function getStapleRecords(groupId: string): Promise<{
  staples: StapleEntry[]
  alwaysShow: string[]
}> {
  const snap = await groupRef(groupId).once('value')
  const all = (snap.val() ?? {}) as Record<string, StapleRecord>

  const staples: StapleEntry[] = []
  const alwaysShow: string[] = []

  for (const [key, record] of Object.entries(all)) {
    if (!record || typeof record !== 'object') continue
    if (record.alwaysShow) {
      alwaysShow.push(key)
      continue
    }
    const n = typeof record.n === 'number' ? record.n : 0
    if (n >= STAPLE_THRESHOLD) {
      staples.push({ key, name: record.name || key.replace(/-/g, ' '), rejections: n })
    }
  }

  staples.sort((a, b) => b.rejections - a.rejections || a.key.localeCompare(b.key))
  return { staples, alwaysShow }
}

/**
 * "I do buy this" — permanently stops a key being treated as a staple.
 *
 * The count is zeroed as well as the flag being set, so that if the user ever
 * clears the flag the row starts from a clean slate rather than from a total
 * that was already over the line.
 */
export async function setAlwaysShow(groupId: string, key: string, alwaysShow: boolean): Promise<void> {
  if (!groupId || !key) return
  if (alwaysShow) {
    await groupRef(groupId).child(key).update({ alwaysShow: true, n: 0 })
  } else {
    await groupRef(groupId).child(key).update({ alwaysShow: null })
  }
}
