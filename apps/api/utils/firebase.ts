// firebase.ts
import admin from 'firebase-admin'
import { initializeApp as initClientApp } from 'firebase/app'
import { getDatabase as getClientDatabase } from 'firebase/database'
import { getDatabase } from 'firebase-admin/database'
import { readFileSync } from 'fs'

const rtdbUrl = 'https://grocerease-5abbb-default-rtdb.firebaseio.com' // 👈 correct RTDB URL
// --- Client SDK (for onValue, streaming)
const clientApp = initClientApp({
  apiKey: 'dummy', // Required but unused in server-side
  databaseURL: rtdbUrl,
})

export const clientRtdb = getClientDatabase(clientApp)

// --- Server SDK (for admin operations)
const serviceAccount = JSON.parse(
  readFileSync('./utils/firebase-service-account.json', 'utf8')
)

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: rtdbUrl, // 👈 correct RTDB URL
  })
}

export const adminRtdb = getDatabase(admin.app())
export const adminAuth = admin.auth()