// firebase.ts
import admin from 'firebase-admin'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore } from 'firebase-admin/firestore'
import { existsSync, readFileSync } from 'fs'

const rtdbUrl = 'https://grocerease-5abbb-default-rtdb.firebaseio.com'
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'grocerease-5abbb'
const LOCAL_KEY = './utils/firebase-service-account.json'

/**
 * Credential resolution, most explicit first:
 *
 *   1. FIREBASE_CREDENTIALS — inline service-account JSON. An escape hatch;
 *      the deployed pipeline never sets it.
 *   2. utils/firebase-service-account.json — the local development file.
 *   3. Application Default Credentials — what runs on Cloud Run. The attached
 *      service account IS the credential, so no private key exists in the
 *      image, in Secret Manager, in GitHub, or on disk anywhere. Authority
 *      comes from IAM roles on that account instead.
 *
 * The existsSync guard is load-bearing, not tidiness: the previous version
 * called readFileSync unconditionally, which throws at MODULE LOAD when the
 * file is absent — so in a container the ADC branch below would never be
 * reached.
 */
function resolveCredential() {
  if (process.env.FIREBASE_CREDENTIALS) {
    return admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS))
  }
  if (existsSync(LOCAL_KEY)) {
    return admin.credential.cert(JSON.parse(readFileSync(LOCAL_KEY, 'utf8')))
  }
  return admin.credential.applicationDefault()
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveCredential(),
    databaseURL: rtdbUrl,
    // Explicit on purpose. Cloud Run does not inject GOOGLE_CLOUD_PROJECT the
    // way App Engine and Cloud Functions do, and verifyIdToken checks a token's
    // `aud` against this — so discovery is not something to rely on here.
    projectId,
  })
}

export const adminRtdb = getDatabase(admin.app())
export const adminAuth = admin.auth()
export const fs = getFirestore('fridgie-db')
