import { describe, expect, test } from 'bun:test';

const { GOOGLE_TEST_PUBLISHER_ID, resolveAdMobBuildConfig } = require('./admob-build.cjs') as {
  GOOGLE_TEST_PUBLISHER_ID: string;
  resolveAdMobBuildConfig(env: Record<string, string | undefined>): {
    production: boolean;
    enabled: boolean;
    androidAppId: string;
    iosAppId: string;
    androidNativeUnitId: string;
    iosNativeUnitId: string;
  };
};

describe('AdMob native build configuration', () => {
  test('development and preview always use Google test inventory', () => {
    const config = resolveAdMobBuildConfig({ EAS_BUILD_PROFILE: 'preview', EXPO_PUBLIC_ADMOB_ENABLED: 'true' });
    expect(config.production).toBe(false);
    expect(config.enabled).toBe(true);
    expect(config.androidAppId).toContain(GOOGLE_TEST_PUBLISHER_ID);
    expect(config.iosAppId).toContain(GOOGLE_TEST_PUBLISHER_ID);
    expect(config.androidNativeUnitId).toContain(GOOGLE_TEST_PUBLISHER_ID);
    expect(config.iosNativeUnitId).toContain(GOOGLE_TEST_PUBLISHER_ID);
  });

  test('production rejects missing, malformed, and Google test IDs', () => {
    expect(() => resolveAdMobBuildConfig({ EAS_BUILD_PROFILE: 'production' })).toThrow('ADMOB_ANDROID_APP_ID');
    expect(() => resolveAdMobBuildConfig({
      EAS_BUILD_PROFILE: 'production',
      ADMOB_ANDROID_APP_ID: `ca-app-pub-${GOOGLE_TEST_PUBLISHER_ID}~3347511713`,
    })).toThrow('ADMOB_ANDROID_APP_ID');
    expect(() => resolveAdMobBuildConfig({
      EAS_BUILD_PROFILE: 'production',
      ADMOB_ANDROID_APP_ID: 'not-an-id',
    })).toThrow('ADMOB_ANDROID_APP_ID');
  });

  test('production accepts only complete real-looking configuration and stays opt-in', () => {
    const config = resolveAdMobBuildConfig({
      EAS_BUILD_PROFILE: 'production',
      ADMOB_ANDROID_APP_ID: 'ca-app-pub-1234567890123456~1234567890',
      ADMOB_IOS_APP_ID: 'ca-app-pub-1234567890123456~1234567891',
      EXPO_PUBLIC_ADMOB_ANDROID_NATIVE_UNIT_ID: 'ca-app-pub-1234567890123456/1234567892',
      EXPO_PUBLIC_ADMOB_IOS_NATIVE_UNIT_ID: 'ca-app-pub-1234567890123456/1234567893',
    });
    expect(config.production).toBe(true);
    expect(config.enabled).toBe(false);
  });
});
