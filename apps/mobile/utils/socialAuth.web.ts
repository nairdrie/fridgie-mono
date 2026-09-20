// The native SDKs cannot be evaluated by React Native Web. Email sign-in is
// available in the browser; platform social sign-in stays in the mobile app.
import type { AuthCredential } from 'firebase/auth';

export class SocialAuthError extends Error {}

async function nativeSignIn(): Promise<AuthCredential | null> {
  throw new SocialAuthError('Use the Fridgie app for social sign-in, or continue with email here.');
}

export const signInWithGoogle = nativeSignIn;
export const signInWithFacebook = nativeSignIn;
export const signInWithApple = nativeSignIn;
