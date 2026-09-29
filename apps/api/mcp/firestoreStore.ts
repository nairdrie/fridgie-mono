import type { Firestore } from 'firebase-admin/firestore'
import type { KvStore } from './store'

/** Firestore-backed `KvStore`. Collection names are used verbatim. */
export function firestoreStore(db: Firestore): KvStore {
  // Firestore's TTL policies only act on a Timestamp field, so every expiring
  // record gets one alongside the plain number the code reads.
  const withTtl = (value: Record<string, any>) =>
    typeof value.expiresAtMs === 'number' ? { ...value, expireAt: new Date(value.expiresAtMs) } : value
  const strip = <T>(data: any): T => {
    if (!data) return data
    const { expireAt: _ttl, ...rest } = data
    return rest as T
  }

  return {
    async get(c, id) {
      const snap = await db.collection(c).doc(id).get()
      return snap.exists ? strip(snap.data()) : null
    },
    async set(c, id, value) {
      await db.collection(c).doc(id).set(withTtl(value as Record<string, any>))
    },
    async update(c, id, patch) {
      await db.collection(c).doc(id).update(withTtl(patch)).catch((error: any) => {
        // Updating a record that has since been deleted is not an error here.
        if (error?.code !== 5) throw error // 5 = NOT_FOUND
      })
    },
    async delete(c, id) {
      await db.collection(c).doc(id).delete()
    },
    async take(c, id) {
      const ref = db.collection(c).doc(id)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return null
        tx.delete(ref)
        return strip(snap.data())
      })
    },
    async where(c, field, value) {
      const snap = await db.collection(c).where(field, '==', value).get()
      return snap.docs.map((doc) => ({ id: doc.id, value: strip(doc.data()) }))
    },
  }
}
