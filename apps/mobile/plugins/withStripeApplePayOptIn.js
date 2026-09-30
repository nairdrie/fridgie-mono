const { withEntitlementsPlist } = require('expo/config-plugins');

const APPLE_PAY_ENTITLEMENT = 'com.apple.developer.in-app-payments';

/**
 * The upstream Stripe plugin adds merchant IDs but intentionally preserves an
 * existing entitlement. Make Fridgie's opt-out reversible even for a non-clean
 * local prebuild, while EAS continues to generate from a clean checkout.
 */
module.exports = function withStripeApplePayOptIn(config, props = {}) {
  return withEntitlementsPlist(config, next => {
    if (props.enabled === true) {
      if (typeof props.merchantIdentifier !== 'string' || !props.merchantIdentifier) {
        throw new Error('Stripe Apple Pay requires a merchant identifier.');
      }
      next.modResults[APPLE_PAY_ENTITLEMENT] = [props.merchantIdentifier];
    } else {
      delete next.modResults[APPLE_PAY_ENTITLEMENT];
    }
    return next;
  });
};
