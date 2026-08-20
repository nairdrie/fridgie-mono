// index.ts
import { Hono } from 'hono'
import { serve } from 'bun'
import fg from 'fast-glob'
import { cors } from 'hono/cors'
import { adminAuth, adminRtdb } from './utils/firebase'
import type { ServerWebSocket } from 'bun'
import type { DataSnapshot } from 'firebase-admin/database'

// 1️⃣ Hono app for HTTP routes
const app = new Hono()
// `X-List-Rev` carries the revision a categorize write committed at; a browser
// build cannot read a custom response header unless it is exposed here.
app.use('/api/*', cors({ origin: '*', exposeHeaders: ['X-List-Rev'] }))

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

files.sort().reverse();

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
      // The token arrives as a WebSocket subprotocol, not a query parameter.
      // Query strings are logged verbatim by essentially every proxy and access
      // log — Cloud Run writes the full request URL to Cloud Logging — so a
      // token there becomes a live credential sitting in log retention, copied
      // again on every reconnect. Headers are not logged.
      //
      // The query parameter is still accepted so that already-installed clients
      // keep working; drop that branch once no old build is in the wild.
      const offered = (req.headers.get('sec-websocket-protocol') ?? '')
        .split(',').map((p) => p.trim()).filter(Boolean);
      const viaSubprotocol = offered[0] === 'bearer' && offered.length > 1;
      const token = viaSubprotocol ? offered[1]! : url.searchParams.get('token');
      if (!token) {
        // No token provided, reject the connection
        return new Response('Missing authentication token', { status: 401 });
      }
      try {
        // ✅ Verify the token using the Admin SDK
        const decodedToken = await adminAuth.verifyIdToken(token);
        const uid = decodedToken.uid;

        // --- At this point, the user is AUTHENTICATED ---
        // Authorization: the user must be a member of the group whose list
        // they are subscribing to, mirroring the groupAuth HTTP middleware.
        const groupId = url.searchParams.get('groupId');
        if (!groupId) {
          return new Response('Missing groupId', { status: 400 });
        }
        const memberSnap = await adminRtdb.ref(`groups/${groupId}/members/${uid}`).once('value');
        if (!memberSnap.exists()) {
          return new Response('Forbidden', { status: 403 });
        }

        const listId = url.pathname.split('/').pop()!;

        // ✅ Success! Upgrade the connection and pass the verified uid
        // RFC 6455 requires the server to echo back one of the offered
        // subprotocols; omitting it makes the client abort the handshake.
        if (server.upgrade(req, {
          data: { listId, groupId, uid },
          ...(viaSubprotocol ? { headers: { 'Sec-WebSocket-Protocol': 'bearer' } } : {}),
        })) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });

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
