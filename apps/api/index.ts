// index.ts
import { Hono } from 'hono'
import { serve } from 'bun'
import fg from 'fast-glob'
import { cors } from 'hono/cors'
import { ref, onValue } from 'firebase/database'
import { clientRtdb } from './utils/firebase'      // adjust if needed
import type { ServerWebSocket } from 'bun'

// 1️⃣ Hono app for HTTP routes
const app = new Hono()
app.use('/api/*', cors())

// Utility: filepath → Hono route (`api/foo/[id].ts` → `/foo/:id`)
function toRoute(file: string) {
  return file
    .replace(/^api/, '')
    .replace(/\/index\.ts$/, '')
    .replace(/\.ts$/, '')
    .replace(/\[([^\]]+)\]/g, ':$1')
}

// Mount *only* your pure-HTTP Hono modules
const files = await fg(['api/**/*.ts'])
for (const file of files) {
  const mod = await import(`./${file}`)
  // If it has a `.routes` array, it's a Hono app:
  if (typeof mod.default?.routes !== 'undefined') {
    app.route('/api' + toRoute(file), mod.default)
  }
  // Otherwise we assume it's your WS module, and skip here
}

// 2️⃣ Bun.serve that handles BOTH HTTP and WebSocket upgrades
serve({
  // Step 1: route HTTP & trigger WS upgrade
  fetch(req, server) {
    const url = new URL(req.url)

    // If this is our WS path, do the upgrade
    if (url.pathname.startsWith('/api/ws/list/')) {
      const listId = url.pathname.split('/').pop()!
      const groupId = url.searchParams.get('groupId')
      server.upgrade(req, { data: { listId, groupId } })
      // Must return a Response; 204 is safe since it's never sent
      return new Response(null, { status: 204 })
    }

    // Otherwise, let Hono handle the HTTP request
    return app.fetch(req)
  },

  // Step 2: Bun-native WebSocket handlers
  websocket: {
    // onOpen: subscribe to Firebase
    open(ws: ServerWebSocket<{ groupId: string, listId: string; unsubscribe?: () => void }>) {
      const { groupId, listId } = ws.data
      const dbRef = ref(clientRtdb, `lists/${groupId}/${listId}`)

      ws.data.unsubscribe = onValue(dbRef, (snap) => {
        try {
          ws.send(JSON.stringify(snap.val()))
        } catch (err) {
          console.error('WS send error:', err)
        }
      })
    },

    // onMessage: optional client→server messages
    message(
      ws: ServerWebSocket<{ listId: string; unsubscribe?: () => void }>,
      message: string
    ) {
      console.log('Client says:', message)
      // e.g. ws.send(`Echo: ${message}`)
    },

    // onClose: clean up the Firebase listener
    close(ws: ServerWebSocket<{ listId: string; unsubscribe?: () => void }>) {
      ws.data.unsubscribe?.()
    }
  },
})
