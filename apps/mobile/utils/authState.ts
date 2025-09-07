// TODO: is this being used?
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './firebase';

export const authStatePromise = new Promise<User | null>((resolve) => {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    // This will fire once with the initial user state from persistence.
    resolve(user);
    // Unsubscribe to avoid memory leaks, as we only need the first value.
    unsubscribe();
  });
});