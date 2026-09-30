'use strict';

const MERCHANT_IDENTIFIER = /^merchant\.[A-Za-z0-9.-]+$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * Apple Pay is a native capability, a signing-profile capability, and a
 * PaymentSheet option. One explicit public build flag controls all three so a
 * card-only build cannot accidentally request Apple Pay credentials.
 */
function resolveStripeWalletBuildConfig(env) {
  const rawEnabled = (env.EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED || '').trim();
  if (rawEnabled && rawEnabled !== 'true' && rawEnabled !== 'false') {
    throw new Error('EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED must be true, false, or unset.');
  }

  const applePayEnabled = rawEnabled === 'true';
  if (!applePayEnabled) {
    return {
      applePayEnabled: false,
      merchantIdentifier: undefined,
      merchantCountryCode: undefined,
    };
  }

  const merchantIdentifier = (env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER || '').trim();
  if (!MERCHANT_IDENTIFIER.test(merchantIdentifier)) {
    throw new Error('EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER must be a valid merchant.* identifier when Apple Pay is enabled.');
  }

  const merchantCountryCode = (env.EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY || 'CA').trim().toUpperCase();
  if (!COUNTRY_CODE.test(merchantCountryCode)) {
    throw new Error('EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY must be a two-letter country code when Apple Pay is enabled.');
  }

  return {
    applePayEnabled: true,
    merchantIdentifier,
    merchantCountryCode,
  };
}

module.exports = { resolveStripeWalletBuildConfig };
