type GoogleAdsSdk = typeof import('react-native-google-mobile-ads');

/** The native SDK cannot be resolved by Metro's web target. */
export function loadGoogleAdsSdk(): GoogleAdsSdk | null {
  return null;
}
