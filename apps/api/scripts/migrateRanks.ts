// One-off migration (backend handoff §3.2): repairs stored list items whose
// listOrder / mealOrder don't parse as LexoRanks — including the literal
// 'NEEDS-RANK' older clients persisted — and migrates the legacy `order` key
// written by early list-creation code to `listOrder`.
//
// Usage:
//   DRY_RUN=1 bun scripts/migrateRanks.ts   # report what would change
//   bun scripts/migrateRanks.ts             # apply repairs
//
// Requires Firebase credentials (FIREBASE_CREDENTIALS env var or
// utils/firebase-service-account.json), same as the server.
import { adminRtdb } from '../utils/firebase'
import { mutateList } from '../utils/listStore'
import { sanitizeItems } from '../utils/rank'

const dryRun = !!process.env.DRY_RUN

async function run() {
  const root = await adminRtdb.ref('lists').once('value')
  const groups = (root.val() ?? {}) as Record<string, Record<string, any>>

  let scanned = 0
  let repaired = 0

  for (const [groupId, lists] of Object.entries(groups)) {
    for (const [listId, list] of Object.entries(lists ?? {})) {
      scanned++
      // This up-front snapshot only decides whether a list is WORTH touching.
      // The authoritative read+repair happens inside the transaction below —
      // writing items computed from this (by now stale) snapshot with a bare
      // .set() would silently clobber edits made while the migration runs.
      if (!sanitizeItems(list?.items).changed) continue

      repaired++
      console.log(`${dryRun ? '[dry-run] would repair' : 'repairing'} lists/${groupId}/${listId}`)
      if (!dryRun) {
        const result = await mutateList(groupId, listId, (current) => ({
          ...current,
          items: sanitizeItems(current?.items).items,
        }))
        if (result.status !== 'ok') {
          console.warn(`  skipped lists/${groupId}/${listId}: ${result.status}`)
        }
      }
    }
  }

  console.log(
    `Scanned ${scanned} lists; ${repaired} ${dryRun ? 'need repair' : 'repaired'}.`
  )
  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
