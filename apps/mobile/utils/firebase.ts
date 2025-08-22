import { initializeApp } from 'firebase/app';

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

const app = initializeApp(firebaseConfig);