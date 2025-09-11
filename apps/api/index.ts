// index.ts
import { Hono } from 'hono'
import { serve } from 'bun'
import fg from 'fast-glob'
import { cors } from 'hono/cors'
import { ref, onValue } from 'firebase/database'
import { adminAuth, adminRtdb, clientRtdb } from './utils/firebase'      // adjust if needed
import type { ServerWebSocket } from 'bun'
import type { DataSnapshot } from 'firebase-admin/database'

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
  idleTimeout: 30,
  // Step 1: route HTTP & trigger WS upgrade
  async fetch(req, server) {
    const url = new URL(req.url)

    // If this is our WS path, do the upgrade
    if (url.pathname.startsWith('/api/ws/list/')) {
      const token = url.searchParams.get('token');
      if (!token) {
        // No token provided, reject the connection
        return new Response('Missing authentication token', { status: 401 });
      }
      try {
        // ✅ Verify the token using the Admin SDK
        const decodedToken = await adminAuth.verifyIdToken(token);
        const uid = decodedToken.uid;

        // --- At this point, the user is AUTHENTICATED ---
        // Now you can perform your AUTHORIZATION check (like groupAuth)
        const groupId = url.searchParams.get('groupId');
        // Example check: const isMember = await isUserInGroup(uid, groupId);
        // if (!isMember) return new Response('Forbidden', { status: 403 });

        const listId = url.pathname.split('/').pop()!;
        
        // ✅ Success! Upgrade the connection and pass the verified uid
        server.upgrade(req, { data: { listId, groupId, uid } });
        return new Response(null, { status: 204 });

      } catch (error) {
        // Token is invalid or expired, reject the connection
        console.error("WebSocket auth error:", error);
        return new Response('Invalid authentication token', { status: 401 });
      }
    }

    // Otherwise, let Hono handle the HTTP request
    return app.fetch(req)
  },

  // Step 2: Bun-native WebSocket handlers
  websocket: {
    // onOpen: subscribe to Firebase
    open(ws: ServerWebSocket<{ groupId: string; listId: string; uid: string; listener?: (snap: DataSnapshot) => void }>) {
      const { groupId, listId, uid } = ws.data;

      console.log(`✅ WebSocket opened for verified user: ${uid}`);
      
      // ✅ Now that the user is authorized, use the powerful adminRtdb
      const dbRef = adminRtdb.ref(`lists/${groupId}/${listId}`);
      
      ws.data.listener = (snap: DataSnapshot) => {
        ws.send(JSON.stringify(snap.val()));
      };
      dbRef.on('value', ws.data.listener);
    },
    // onMessage: optional client→server messages
    message(
      ws: ServerWebSocket<{ listId: string; unsubscribe?: () => void }>,
      message: string
    ) {
      console.log('Client says:', message)
      // e.g. ws.send(`Echo: ${message}`)
    },

    close(ws: ServerWebSocket<{ groupId: string; listId: string; uid: string; listener?: (snap: DataSnapshot) => void }>) {
      const { groupId, listId } = ws.data;
      if (ws.data.listener) {
        const dbRef = adminRtdb.ref(`lists/${groupId}/${listId}`);
        dbRef.off('value', ws.data.listener);
      }
    }
  },
})
