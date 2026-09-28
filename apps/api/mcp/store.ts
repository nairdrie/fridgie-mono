/**
 * The little persistence the connector's OAuth server needs, as an interface,
 * so the whole authorization flow runs in tests against `memoryStore()` and in
 * production against Firestore (`firestoreStore.ts`).
 *
 * Records that expire carry `expiresAtMs`. The Firestore implementation mirrors
 * it into an `expireAt` timestamp, which a TTL policy on each collection can
 * use to sweep what is dead; nothing here depends on that sweep happening.
 */
export interface KvStore {
  get<T extends object>(collection: string, id: string): Promise<T | null>
  set<T extends object>(collection: string, id: string, value: T): Promise<void>
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<void>
  delete(collection: string, id: string): Promise<void>
  /** Reads and deletes in one atomic step: a second `take` of the same id gets null. */
  take<T extends object>(collection: string, id: string): Promise<T | null>
  where<T extends object>(collection: string, field: string, value: unknown): Promise<{ id: string; value: T }[]>
}

export function memoryStore(): KvStore & { dump(): Map<string, Map<string, any>> } {
  const data = new Map<string, Map<string, any>>()
  const col = (name: string) => {
    if (!data.has(name)) data.set(name, new Map())
    return data.get(name)!
  }
  const clone = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v))
  return {
    dump: () => data,
    async get(c, id) { return clone(col(c).get(id)) ?? null },
    async set(c, id, value) { col(c).set(id, clone(value)) },
    async update(c, id, patch) {
      const existing = col(c).get(id)
      if (existing) col(c).set(id, { ...existing, ...clone(patch) })
    },
    async delete(c, id) { col(c).delete(id) },
    async take(c, id) {
      const value = col(c).get(id)
      col(c).delete(id)
      return clone(value) ?? null
    },
    async where(c, field, value) {
      return [...col(c).entries()]
        .filter(([, v]) => v?.[field] === value)
        .map(([id, v]) => ({ id, value: clone(v) }))
    },
  }
}
