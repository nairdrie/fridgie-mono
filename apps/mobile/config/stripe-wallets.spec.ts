import { describe, expect, test } from 'bun:test';

const { resolveStripeWalletBuildConfig } = require('./stripe-wallets.cjs') as {
  resolveStripeWalletBuildConfig(env: Record<string, string | undefined>): {
    applePayEnabled: boolean;
    merchantIdentifier?: string;
    merchantCountryCode?: string;
  };
};

describe('Stripe wallet build configuration', () => {
  test('defaults to a card-capable build without the Apple Pay capability', () => {
    expect(resolveStripeWalletBuildConfig({})).toEqual({
      applePayEnabled: false,
      merchantIdentifier: undefined,
      merchantCountryCode: undefined,
    });
    expect(resolveStripeWalletBuildConfig({
      EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: 'false',
      EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER: 'merchant.com.nairdrie.fridgie',
    }).merchantIdentifier).toBeUndefined();
  });

  test('requires complete valid merchant configuration for Apple Pay', () => {
    expect(() => resolveStripeWalletBuildConfig({
      EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: 'yes',
    })).toThrow('must be true, false, or unset');
    expect(() => resolveStripeWalletBuildConfig({
      EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: 'true',
    })).toThrow('EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER');
    expect(() => resolveStripeWalletBuildConfig({
      EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: 'true',
      EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER: 'com.nairdrie.fridgie',
    })).toThrow('EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER');
  });

  test('enables native and runtime Apple Pay from the same public build inputs', () => {
    expect(resolveStripeWalletBuildConfig({
      EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED: 'true',
      EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER: 'merchant.com.nairdrie.fridgie',
      EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY: 'ca',
    })).toEqual({
      applePayEnabled: true,
      merchantIdentifier: 'merchant.com.nairdrie.fridgie',
      merchantCountryCode: 'CA',
    });
  });
});
