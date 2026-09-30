/**
 * Store and entitlement identifiers live here so a pricing experiment never
 * requires hunting through UI code. `EXPO_PUBLIC_*` values are safe to ship in
 * the app; RevenueCat secret keys belong on the API only.
 */
export const PRO_CONFIG = {
  entitlementId:
    process.env.EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID || 'fridgie_pro',
  offeringId:
    process.env.EXPO_PUBLIC_REVENUECAT_OFFERING_ID || 'default',
  products: {
    monthly:
      process.env.EXPO_PUBLIC_FRIDGIE_PRO_MONTHLY_PRODUCT_ID ||
      'fridgie_pro_monthly',
    annual:
      process.env.EXPO_PUBLIC_FRIDGIE_PRO_ANNUAL_PRODUCT_ID ||
      'fridgie_pro_annual',
  },
  revenueCatKeys: {
    ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY || '',
    android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY || '',
  },
  /** Pricing hypothesis only. Store-returned localized prices always win. */
  fallbackPriceCopy: {
    monthly: 'US$4.99 / month',
    annual: 'US$39.99 / year',
  },
  privacyUrl: process.env.EXPO_PUBLIC_PRIVACY_URL || '',
  termsUrl: process.env.EXPO_PUBLIC_TERMS_URL || '',
} as const;

export type ProBillingPeriod = keyof typeof PRO_CONFIG.products;
