type StripeWalletConfig =
  | {
    applePayEnabled: false;
    merchantIdentifier: undefined;
    merchantCountryCode: undefined;
  }
  | {
    applePayEnabled: true;
    merchantIdentifier: string;
    merchantCountryCode: string;
  };

const { resolveStripeWalletBuildConfig } = require('../config/stripe-wallets.cjs') as {
  resolveStripeWalletBuildConfig(env: Record<string, string | undefined>): StripeWalletConfig;
};

/** The direct env references are intentionally visible to Expo's JS inliner. */
export function stripeWalletConfigFromPublicEnv(): StripeWalletConfig {
  return resolveStripeWalletBuildConfig({
    EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: process.env.EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED,
    EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER: process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER,
    EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY: process.env.EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY,
  });
}
