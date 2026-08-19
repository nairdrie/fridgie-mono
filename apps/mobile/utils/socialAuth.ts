// Native social sign-in.
//
// Each provider hands back a Firebase AuthCredential (or null if the user backed
// out), so the caller only has to deal with linkWithCredential/signInWithCredential.
// All three use the platform's own UI — no browser hand-off, no redirect to catch.
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import {
  AuthCredential,
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
} from 'firebase/auth';
import { Platform } from 'react-native';
import { AccessToken, LoginManager, Settings } from 'react-native-fbsdk-next';

// OAuth clients live in Google Cloud project 598650352064, which is the project
// wired into the Firebase console's Google provider — that's why Firebase accepts
// these audiences even though the Firebase project itself is 725621365755.
export const GOOGLE_IOS_CLIENT_ID =
  '598650352064-t8n659ud33kd09jfagcas0akr8j0r3kj.apps.googleusercontent.com';
export const GOOGLE_WEB_CLIENT_ID =
  '598650352064-bjkgnsj14of6fs4f9ggkmi9tlqptuiat.apps.googleusercontent.com';
export const FACEBOOK_APP_ID = '776186408706339';

// The reversed iOS client id, which is also the URL scheme the Google SDK returns to.
export const GOOGLE_IOS_URL_SCHEME = `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.split('.')[0]}`;

/** Thrown when a provider fails for a reason worth showing the user. */
export class SocialAuthError extends Error {}

let configured = false;

/**
 * Idempotent one-time setup for the native SDKs. Safe to call on every sign-in
 * attempt; both SDKs only need it once per process.
 */
export function configureSocialAuth() {
  if (configured) return;
  configured = true;

  GoogleSignin.configure({
    // Android mints its id token for the web client; iOS mints it for the iOS
    // client and uses this one as the server audience.
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID,
  });

  Settings.initializeSDK();
}

/**
 * Google: the account picker on Android, the system sign-in sheet on iOS.
 * Returns null if the user dismissed it.
 */
export async function signInWithGoogle(): Promise<AuthCredential | null> {
  configureSocialAuth();

  try {
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }

    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return null;

    const { idToken } = response.data;
    if (!idToken) {
      throw new SocialAuthError('Google did not return an identity token.');
    }
    return GoogleAuthProvider.credential(idToken);
  } catch (err) {
    if (isErrorWithCode(err)) {
      switch (err.code) {
        case statusCodes.SIGN_IN_CANCELLED:
        case statusCodes.IN_PROGRESS:
          return null;
        case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
          throw new SocialAuthError(
            'Google Play Services is unavailable or out of date on this device.'
          );
      }
    }
    throw err;
  }
}

/**
 * Facebook: hands off to the Facebook app when it's installed, and falls back to
 * the SDK's own sheet when it isn't. Returns null if the user dismissed it.
 */
export async function signInWithFacebook(): Promise<AuthCredential | null> {
  configureSocialAuth();

  const result = await LoginManager.logInWithPermissions(['public_profile', 'email']);
  if (result.isCancelled) return null;

  const token = await AccessToken.getCurrentAccessToken();
  if (!token) {
    throw new SocialAuthError('Facebook did not return an access token.');
  }
  return FacebookAuthProvider.credential(token.accessToken);
}

/** Apple: the system sheet. Returns null if the user dismissed it. */
export async function signInWithApple(): Promise<AuthCredential | null> {
  try {
    const { identityToken } = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!identityToken) {
      throw new SocialAuthError('Apple did not return an identity token.');
    }
    return new OAuthProvider('apple.com').credential({ idToken: identityToken });
  } catch (err: any) {
    if (err?.code === 'ERR_REQUEST_CANCELED') return null;
    throw err;
  }
}
