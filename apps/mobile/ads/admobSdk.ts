type GoogleAdsSdk = typeof import('react-native-google-mobile-ads');

/** Native/dev-client boundary. Expo Go safely degrades to no-fill. */
export function loadGoogleAdsSdk(): GoogleAdsSdk | null {
  try {
    return require('react-native-google-mobile-ads') as GoogleAdsSdk;
  } catch {
    return null;
  }
}
