// utils/firebase.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { browserLocalPersistence, getReactNativePersistence, initializeAuth } from 'firebase/auth'; // TODO: this is just a TS error, it compiles and works
import { Platform } from 'react-native';

export const firebaseConfig = {
  apiKey: "AIzaSyCcWf4ImzldQDYMMEK5UmAgTCpLZ_vBlTo",
  authDomain: "grocerease-5abbb.firebaseapp.com",
  databaseURL: "https://grocerease-5abbb-default-rtdb.firebaseio.com",
  projectId: "grocerease-5abbb",
  storageBucket: "grocerease-5abbb.firebasestorage.app",
  messagingSenderId: "725621365755",
  appId: "1:725621365755:web:c69a8b1a73978369bec95e",
  measurementId: "G-M35FBJHZZL"
}

// A helper function to initialize and retrieve the Firebase app instance.
const getFirebaseApp = () => {
  if (getApps().length === 0) {
    return initializeApp(firebaseConfig);
  }
  return getApp();
};

const app = getFirebaseApp();

console.log(`INITIALIZING AUTH FOR ${Platform.OS}`)
const auth = initializeAuth(app, {
  persistence: Platform.OS === 'web'
    ? browserLocalPersistence // Use browser's local storage for web
    : getReactNativePersistence(AsyncStorage), // Use AsyncStorage for native
});


// Export the initialized services
export { app, auth };

