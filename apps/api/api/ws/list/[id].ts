// // api/ws/list/[id].ts
// import { Hono } from 'hono'
// import { createBunWebSocket } from 'hono/bun'
// import { ref, onValue } from 'firebase/database'
// import { clientRtdb } from '../../../utils/firebase'

// const app = new Hono()
// const { upgradeWebSocket, websocket } = createBunWebSocket()

// app.get(
//   '/',
//   upgradeWebSocket((c) => {
//     const listId = c.req.param('id')
//     if (!listId) {
//       throw new Error('Missing listId param')
//     }

//     let unsubscribe: () => void
//     return {
//       onOpen(_event, ws) {
//         const dbRef = ref(clientRtdb, `lists/${listId}`)
//         unsubscribe = onValue(dbRef, (snapshot) => {
//           try {
//             ws.send(JSON.stringify(snapshot.val()))
//           } catch (err) {
//             console.error('WebSocket send error:', err)
//           }
//         })
//       },

//       onClose() {
//         unsubscribe?.()
//       }
//     }
//   })
// )

// export default {
//   fetch: app.fetch,
//   websocket,
// }
