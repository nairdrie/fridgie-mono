import { StripeProvider } from '@stripe/stripe-react-native';
import React from 'react';
import { stripeWalletConfigFromPublicEnv } from '@/utils/stripeWallets';

const stripeWallets = stripeWalletConfigFromPublicEnv();

/** Native Stripe context. The key can be supplied at build time or by checkout. */
export default function StripeAppProvider({ children }: { children: React.ReactNode }) {
  return (
    <StripeProvider
      publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}
      {...(stripeWallets.applePayEnabled
        ? { merchantIdentifier: stripeWallets.merchantIdentifier }
        : {})}
      urlScheme="fridgie"
    >
      <>{children}</>
    </StripeProvider>
  );
}
