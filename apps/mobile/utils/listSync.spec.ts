import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ── fakes ────────────────────────────────────────────────────────────────────
class ApiError extends Error {
  status: number
  constructor(m: string, s: number) { super(m); this.name = 'ApiError'; this.status = s }
}
class StaleRevError extends Error {
  rev: number; list: any
  constructor(r: number, l: any) { super('stale_rev'); this.name = 'StaleRevError'; this.rev = r; this.list = l }
}

let server: any = { rev: 1, items: [], meals: [], lastClientId: null }
let reachable = true
let sent: any[] = []

mock.module('./api', () => ({
  ApiError,
  StaleRevError,
  CLIENT_ID: 'me',
  updateList: async (_g: string, _l: string, data: any, rev?: number) => {
    if (!reachable) throw new ApiError('unreachable', 0)
    sent.push({ data, rev })
    if (typeof rev === 'number' && rev < server.rev) {
      throw new StaleRevError(server.rev, { ...server })
    }
    server = { rev: server.rev + 1, items: data.items, meals: data.meals, lastClientId: 'me' }
    return { status: 'updated', rev: server.rev }
  },
}))

const disk = new Map<string, any>()
const pendingWrites = new Map<string, any>()
mock.module('./listCache', () => ({
  readCachedList: async (g: string, l: string) => disk.get(`${g}:${l}`) ?? null,
  writeCachedList: (entry: any) => {
    const e = { ...entry, savedAt: Date.now() }
    pendingWrites.set(`${entry.groupId}:${entry.listId}`, e)
    disk.set(`${entry.groupId}:${entry.listId}`, e)
  },
  peekPendingList: (g: string, l: string) => pendingWrites.get(`${g}:${l}`),
  flushCache: async () => { pendingWrites.clear() },
  readDirtyCachedLists: async () => [...disk.values()].filter((e) => e.dirty),
}))

const { getListSyncEngine, resetSyncEngines } = await import('./listSync')
type Engine = ReturnType<typeof getListSyncEngine>
const { reportReachable, reportUnreachable } = await import('./connectivity')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Long enough to clear the 500ms save debounce. */
const settle = () => sleep(700)

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, text: id, checked: false, isSection: false, listOrder: '0|100000:', ...over,
})

let engine: Engine
let listId = ''
let n = 0
beforeEach(() => {
  // Disposes every engine from the previous test, so its retry timers cannot
  // fire into this one's fake server.
  resetSyncEngines()
  server = { rev: 1, items: [item('a')], meals: [], lastClientId: null }
  reachable = true
  reportReachable()
  sent = []
  disk.clear()
  pendingWrites.clear()
  listId = `list${n++}`
  engine = getListSyncEngine('g1', listId)
})

describe('the ordinary online path', () => {
  test('a local edit reaches the server and settles as synced', async () => {
    engine.applyRemote(server, 'me')
    engine.recordLocal({ items: [item('a'), item('b')], meals: [] })
    expect(engine.state.status).toBe('pending')
    await settle()
    expect(engine.state.status).toBe('synced')
    expect(server.items.map((i: any) => i.id)).toEqual(['a', 'b'])
  })

  test('rendering what the server just sent is not recorded as an edit', async () => {
    engine.applyRemote(server, 'someone-else')
    engine.recordLocal({ items: [item('a')], meals: [] })
    await settle()
    expect(sent).toHaveLength(0)
    expect(engine.state.status).toBe('synced')
  })

  test('our own echo is not repainted, but the first snapshot always is', () => {
    const first = { ...server, lastClientId: 'me' }
    // Never loaded: this IS the load, whoever wrote it last.
    expect(engine.applyRemote(first, 'me')).not.toBeNull()
    // Loaded: now an echo, and repainting it is what causes save ping-pong.
    expect(engine.applyRemote({ ...first, rev: 2 }, 'me')).toBeNull()
  })
})

describe('losing the connection', () => {
  test('an edit made offline is held, not dropped', async () => {
    engine.applyRemote(server, 'x')
    reachable = false
    reportUnreachable()

    engine.recordLocal({ items: [item('a'), item('offline-add')], meals: [] })
    await settle()

    expect(engine.state.status).toBe('offline')
    expect(engine.hasUnsavedWork).toBe(true)
    expect(server.items).toHaveLength(1)          // server untouched
    const cached = disk.get('g1:list0') ?? [...disk.values()][0]
    expect(cached.dirty).toBe(true)               // and it is on disk
    expect(cached.local.items.map((i: any) => i.id)).toContain('offline-add')
  })

  test('and goes out on its own when the connection returns', async () => {
    engine.applyRemote(server, 'x')
    reachable = false
    reportUnreachable()
    engine.recordLocal({ items: [item('a'), item('offline-add')], meals: [] })
    await settle()
    expect(engine.state.status).toBe('offline')

    reachable = true
    reportReachable()
    await settle()

    expect(engine.state.status).toBe('synced')
    expect(server.items.map((i: any) => i.id)).toEqual(['a', 'offline-add'])
  })

  test('a whole offline session survives an app restart', async () => {
    engine.applyRemote(server, 'x')
    reachable = false
    reportUnreachable()
    engine.recordLocal({ items: [item('a', { checked: true }), item('b'), item('c')], meals: [] })
    await settle()

    // The app is killed. A fresh engine for the same list reads the mirror.
    resetSyncEngines()
    const revived = getListSyncEngine('g1', listId)
    const restored = await revived.hydrate()
    expect(restored!.items.map((i: any) => i.id)).toEqual(['a', 'b', 'c'])
    expect(revived.hasUnsavedWork).toBe(true)

    reachable = true
    reportReachable()
    await settle()
    expect(server.items.map((i: any) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('two people at once', () => {
  test('a concurrent save is merged and re-sent, not clobbered', async () => {
    engine.applyRemote(server, 'x')          // base: [a] @ rev 1
    // Someone else commits while we are typing.
    server = { rev: 5, items: [item('a'), item('theirs')], meals: [], lastClientId: 'them' }
    engine.recordLocal({ items: [item('a'), item('mine')], meals: [] })
    await settle()

    expect(engine.state.status).toBe('synced')
    expect(server.items.map((i: any) => i.id).sort()).toEqual(['a', 'mine', 'theirs'])
  })

  test('their snapshot landing on our unsaved edits merges both', async () => {
    engine.applyRemote(server, 'x')
    reachable = false
    reportUnreachable()
    engine.recordLocal({ items: [item('a', { checked: true })], meals: [] })
    await settle()

    reachable = true
    const next = engine.applyRemote(
      { rev: 4, items: [item('a'), item('theirs')], meals: [], lastClientId: 'them' } as any,
      'me'
    )
    // Our check-off AND their new row.
    expect(next!.items.map((i: any) => i.id).sort()).toEqual(['a', 'theirs'])
    expect(next!.items.find((i: any) => i.id === 'a')!.checked).toBe(true)
  })

  test('a same-field loss is reported and can be undone', async () => {
    engine.applyRemote({ rev: 1, items: [item('a', { text: 'milk' })], meals: [] } as any, 'x')
    engine.recordLocal({ items: [item('a', { text: 'oat milk', updatedAt: 100 })], meals: [] })
    // They renamed it too, more recently.
    server = {
      rev: 9,
      items: [item('a', { text: 'soy milk', updatedAt: 500 })],
      meals: [], lastClientId: 'them',
    }
    await settle()

    expect(server.items[0].text).toBe('soy milk')
    expect(engine.state.conflicts).toHaveLength(1)
    expect(engine.state.conflicts[0]!.localValue).toBe('oat milk')

    engine.undoConflicts()
    await settle()
    expect(server.items[0].text).toBe('oat milk')
    expect(engine.state.conflicts).toHaveLength(0)
  })
})

describe('server-initiated writes', () => {
  test('adopting a categorize result does not make the next save stale', async () => {
    engine.applyRemote(server, 'x')
    // categorize committed rev 7 on the server's own initiative
    server = { rev: 7, items: [item('a', { section: 'Dairy' })], meals: [], lastClientId: null }
    engine.adoptServerWrite({ items: [item('a', { section: 'Dairy' })], meals: [] } as any, 7)

    engine.recordLocal({ items: [item('a', { section: 'Dairy' }), item('new')], meals: [] })
    await settle()

    expect(engine.state.status).toBe('synced')
    // One send, no 409 round trip.
    expect(sent).toHaveLength(1)
    expect(sent[0].rev).toBe(7)
  })
})

describe('a week opened for the first time with no signal', () => {
  test('edits are held but NEVER sent as a blind whole-document write', async () => {
    // No snapshot has ever arrived, so there is no confirmed base and no rev.
    reachable = false
    reportUnreachable()
    engine.recordLocal({ items: [item('typed-in-the-shop')], meals: [] })
    await settle()

    reachable = true
    reportReachable()
    await settle()

    // The server still holds its own document. Sending ours would have been a
    // last-write-wins overwrite that deleted whatever was really in that week.
    expect(sent).toHaveLength(0)
    expect(server.items.map((i: any) => i.id)).toEqual(['a'])
    expect(engine.hasUnsavedWork).toBe(true)
  })

  test('and go out, merged, once a snapshot finally arrives', async () => {
    reachable = false
    reportUnreachable()
    engine.recordLocal({ items: [item('typed-in-the-shop')], meals: [] })
    await settle()

    reachable = true
    reportReachable()
    // The socket reconnects and delivers the week as it really is.
    engine.applyRemote(
      { rev: 3, items: [item('a'), item('b')], meals: [], lastClientId: 'them' } as any,
      'me'
    )
    server = { rev: 3, items: [item('a'), item('b')], meals: [], lastClientId: 'them' }
    await settle()

    // Nothing of theirs deleted, nothing of ours lost.
    expect(server.items.map((i: any) => i.id).sort()).toEqual(['a', 'b', 'typed-in-the-shop'])
  })
})
