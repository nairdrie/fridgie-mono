'use strict';

const GOOGLE_TEST_PUBLISHER_ID = '3940256099942544';
const GOOGLE_TEST_APP_IDS = Object.freeze({
  android: `ca-app-pub-${GOOGLE_TEST_PUBLISHER_ID}~3347511713`,
  ios: `ca-app-pub-${GOOGLE_TEST_PUBLISHER_ID}~1458002511`,
});
const GOOGLE_TEST_NATIVE_UNIT_IDS = Object.freeze({
  android: `ca-app-pub-${GOOGLE_TEST_PUBLISHER_ID}/2247696110`,
  ios: `ca-app-pub-${GOOGLE_TEST_PUBLISHER_ID}/3986624511`,
});

const APP_ID = /^ca-app-pub-(\d{16})~\d{10}$/;
const UNIT_ID = /^ca-app-pub-(\d{16})\/\d{10}$/;

function requiredProductionId(env, key, pattern) {
  const value = (env[key] || '').trim();
  const match = pattern.exec(value);
  if (!match || match[1] === GOOGLE_TEST_PUBLISHER_ID) {
    throw new Error(`${key} must be a real Google AdMob ID for a production build; test, missing, and malformed IDs are rejected.`);
  }
  return value;
}

/**
 * Google Mobile Ads is autolinked and requires native app IDs at startup.
 * Preview/development builds use Google's public samples; production builds
 * hard-fail until real IDs are supplied, even while the pilot is remotely off.
 */
function resolveAdMobBuildConfig(env) {
  const production = env.EAS_BUILD_PROFILE === 'production' || env.FRIDGIE_BUILD_ENV === 'production';
  if (!production) {
    return {
      production: false,
      enabled: env.EXPO_PUBLIC_ADMOB_ENABLED === 'true',
      androidAppId: GOOGLE_TEST_APP_IDS.android,
      iosAppId: GOOGLE_TEST_APP_IDS.ios,
      androidNativeUnitId: GOOGLE_TEST_NATIVE_UNIT_IDS.android,
      iosNativeUnitId: GOOGLE_TEST_NATIVE_UNIT_IDS.ios,
    };
  }

  return {
    production: true,
    enabled: env.EXPO_PUBLIC_ADMOB_ENABLED === 'true',
    androidAppId: requiredProductionId(env, 'ADMOB_ANDROID_APP_ID', APP_ID),
    iosAppId: requiredProductionId(env, 'ADMOB_IOS_APP_ID', APP_ID),
    androidNativeUnitId: requiredProductionId(env, 'EXPO_PUBLIC_ADMOB_ANDROID_NATIVE_UNIT_ID', UNIT_ID),
    iosNativeUnitId: requiredProductionId(env, 'EXPO_PUBLIC_ADMOB_IOS_NATIVE_UNIT_ID', UNIT_ID),
  };
}

module.exports = {
  GOOGLE_TEST_PUBLISHER_ID,
  GOOGLE_TEST_APP_IDS,
  GOOGLE_TEST_NATIVE_UNIT_IDS,
  resolveAdMobBuildConfig,
};
