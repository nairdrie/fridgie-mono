import type { ConfigContext, ExpoConfig } from 'expo/config';

// Keep this helper as CJS: Expo evaluates app.config.ts with a lightweight
// transpiler that does not load sibling TypeScript modules in EAS/Node.
const { resolveAdMobBuildConfig } = require('./config/admob-build.cjs') as {
  resolveAdMobBuildConfig(env: Record<string, string | undefined>): {
    production: boolean;
    enabled: boolean;
    androidAppId: string;
    iosAppId: string;
    androidNativeUnitId: string;
    iosNativeUnitId: string;
  };
};
const { resolveStripeWalletBuildConfig } = require('./config/stripe-wallets.cjs') as {
  resolveStripeWalletBuildConfig(env: Record<string, string | undefined>):
    | { applePayEnabled: false; merchantIdentifier: undefined }
    | { applePayEnabled: true; merchantIdentifier: string };
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const ads = resolveAdMobBuildConfig(process.env);
  const stripeWallets = resolveStripeWalletBuildConfig(process.env);
  return {
    ...config,
    name: config.name ?? 'Fridgie',
    slug: config.slug ?? 'fridgie',
    plugins: [
      ...(config.plugins ?? []),
      ['@stripe/stripe-react-native', {
        enableGooglePay: true,
        ...(stripeWallets.applePayEnabled
          ? { merchantIdentifier: stripeWallets.merchantIdentifier }
          : {}),
      }],
      ['./plugins/withStripeApplePayOptIn', {
        enabled: stripeWallets.applePayEnabled,
        ...(stripeWallets.applePayEnabled
          ? { merchantIdentifier: stripeWallets.merchantIdentifier }
          : {}),
      }],
      ['react-native-google-mobile-ads', {
        androidAppId: ads.androidAppId,
        iosAppId: ads.iosAppId,
        // Consent is resolved before SDK initialization or any request.
        delayAppMeasurementInit: true,
      }],
    ],
    extra: {
      ...(config.extra ?? {}),
      discoverAds: {
        admobEnabled: ads.enabled,
        production: ads.production,
        androidNativeUnitId: ads.androidNativeUnitId,
        iosNativeUnitId: ads.iosNativeUnitId,
        targetingMode: 'contextual',
      },
    },
  };
};
