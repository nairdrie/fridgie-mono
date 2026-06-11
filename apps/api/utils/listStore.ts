import { adminRtdb } from './firebase'

export type ListMutationResult =
  | { status: 'ok'; rev: number; list: any }
  | { status: 'stale'; rev: number; list: any }
  | { status: 'missing' }

/**
 * Applies a mutation to a list document inside an RTDB transaction (backend
 * handoff §3.3). Every committed mutation:
 * - bumps the monotonically increasing `rev` on the list doc,
 * - stamps `lastClientId` (or removes it for server-initiated writes), so
 *   websocket consumers can hard-ignore their own echoes.
 *
 * If `expectedRev` is provided and is behind the stored rev, nothing is
 * written and `status: 'stale'` is returned with the current document so the
 * client can rebase. Writes without `expectedRev` keep the previous
 * last-write-wins behaviour (backwards compatible with older clients).
 */
export async function mutateList(
  groupId: string,
  listId: string,
  mutate: (current: any) => any,
  options: { clientId?: string; expectedRev?: number } = {}
): Promise<ListMutationResult> {
  const ref = adminRtdb.ref(`lists/${groupId}/${listId}`)

  // Transactions start from a locally cached null; check existence up front so
  // a missing list doesn't get created from a partial payload.
  const existing = await ref.once('value')
  if (!existing.exists()) return { status: 'missing' }

  let stale = false
  const result = await ref.transaction((current: any) => {
    // First attempt may run against the unloaded local cache; returning the
    // null back forces a retry with real data without writing anything.
    if (current === null) return null

    const currentRev = typeof current.rev === 'number' ? current.rev : 0
    if (typeof options.expectedRev === 'number' && options.expectedRev < currentRev) {
      stale = true
      return // abort
    }
    stale = false

    return {
      ...mutate(current),
      rev: currentRev + 1,
      // null removes the key, marking the write as server-initiated
      lastClientId: options.clientId ?? null,
    }
  })

  if (!result.committed) {
    const value = result.snapshot?.val() ?? (await ref.once('value')).val()
    if (stale) return { status: 'stale', rev: value?.rev ?? 0, list: value }
    return { status: 'missing' }
  }

  const value = result.snapshot.val()
  if (value === null) return { status: 'missing' }
  return { status: 'ok', rev: typeof value.rev === 'number' ? value.rev : 0, list: value }
}
