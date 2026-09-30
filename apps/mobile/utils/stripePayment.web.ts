/**
 * Web never enters the builder's native checkout branch. These stubs keep the
 * route bundleable without pulling native Stripe code into Fridgie web.
 */
export async function initStripe(): Promise<void> {}

export function useStripe() {
  return {
    initPaymentSheet: async () => ({ error: undefined }),
    presentPaymentSheet: async () => ({
      error: {
        code: 'Failed',
        message: 'Secure checkout is available in the Fridgie iOS or Android app.',
      },
    }),
  };
}
