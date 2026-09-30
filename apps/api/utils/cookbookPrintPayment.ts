import Stripe from 'stripe';
import type { CookbookPrintAddress } from '@fridgie/shared/types';
import { PrintConfigurationError } from './cookbookPrintProvider';

export interface PaymentIntentResult {
  id: string;
  clientSecret: string;
  status: string;
}

export interface RetailTaxResult {
  calculationId: string;
  amountTax: number;
  amountTotal: number;
  currency: string;
  expiresAt?: string;
}

export interface RetailTaxAssociationResult {
  calculationId: string;
  transactionId?: string;
  errorCode?: string;
}

export interface PaymentReversalResult {
  status: 'canceled' | 'refund-pending';
  refundId?: string;
}

export interface PaymentGateway {
  readonly publishableKey: string;
  createAuthorization(options: { orderId: string; amountMinor: number; currency: string; email?: string; taxCalculationId?: string; idempotencyKey: string }): Promise<PaymentIntentResult>;
  retrieve(intentId: string): Promise<PaymentIntentResult>;
  capture(intentId: string, idempotencyKey: string): Promise<string>;
  cancel(intentId: string, idempotencyKey: string): Promise<PaymentReversalResult>;
  refund(intentId: string, idempotencyKey: string): Promise<string>;
  calculateTax(options: { reference: string; printingMinor: number; shippingMinor: number; currency: string; address: CookbookPrintAddress; idempotencyKey: string }): Promise<RetailTaxResult>;
  findTaxAssociation(intentId: string): Promise<RetailTaxAssociationResult>;
  verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event>;
}

function paymentConfiguration() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const publishableKey = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const luluProduction = process.env.LULU_ENV === 'production';
  if (!secretKey || !publishableKey) throw new PrintConfigurationError('Stripe test credentials are missing. Preview is available, but checkout is not configured.');
  if (luluProduction) {
    if (process.env.PRINT_PRODUCTION_ENABLED !== 'true' || !secretKey.startsWith('sk_live_') || !publishableKey.startsWith('pk_live_')) {
      throw new PrintConfigurationError('Live printing requires explicit production enablement and matching live Stripe credentials.');
    }
  } else if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
    throw new PrintConfigurationError('Lulu sandbox must use Stripe test credentials.');
  }
  return { secretKey, publishableKey, webhookSecret };
}

function stripeAddress(address: CookbookPrintAddress): Stripe.Tax.CalculationCreateParams.CustomerDetails.Address {
  return {
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    state: address.stateOrProvince,
    postal_code: address.postalCode,
    country: address.country.toUpperCase(),
  };
}

export class StripePaymentGateway implements PaymentGateway {
  readonly publishableKey: string;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(configuration = paymentConfiguration()) {
    this.publishableKey = configuration.publishableKey;
    this.webhookSecret = configuration.webhookSecret;
    this.stripe = new Stripe(configuration.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }

  async createAuthorization(options: { orderId: string; amountMinor: number; currency: string; email?: string; taxCalculationId?: string; idempotencyKey: string }): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create({
      amount: options.amountMinor,
      currency: options.currency.toLowerCase(),
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      ...(options.taxCalculationId ? { hooks: { inputs: { tax: { calculation: options.taxCalculationId } } } } : {}),
      description: `Fridgie printed cookbook ${options.orderId}`,
      receipt_email: options.email,
      metadata: { order_id: options.orderId, product: 'physical_cookbook' },
    }, { idempotencyKey: options.idempotencyKey });
    if (!intent.client_secret) throw new Error('STRIPE_CLIENT_SECRET_MISSING');
    return { id: intent.id, clientSecret: intent.client_secret, status: intent.status };
  }

  async retrieve(intentId: string): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    if (!intent.client_secret) throw new Error('STRIPE_CLIENT_SECRET_MISSING');
    return { id: intent.id, clientSecret: intent.client_secret, status: intent.status };
  }

  async capture(intentId: string, idempotencyKey: string): Promise<string> {
    // A prior request can have reached Stripe even if our response timed out.
    // Retrieve first so a reconciliation retry never attempts to capture an
    // already-succeeded PaymentIntent again.
    const current = await this.stripe.paymentIntents.retrieve(intentId);
    if (current.status !== 'requires_capture') return current.status;
    const intent = await this.stripe.paymentIntents.capture(intentId, {}, { idempotencyKey });
    return intent.status;
  }

  async cancel(intentId: string, idempotencyKey: string): Promise<PaymentReversalResult> {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    if (intent.status === 'canceled') return { status: 'canceled' };
    if (['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(intent.status)) {
      await this.stripe.paymentIntents.cancel(intentId, { cancellation_reason: 'requested_by_customer' }, { idempotencyKey });
      return { status: 'canceled' };
    }
    if (intent.status === 'succeeded') {
      const refundId = await this.refund(intentId, `${idempotencyKey}:refund`);
      return { status: 'refund-pending', refundId };
    }
    throw Object.assign(new Error(`Payment cannot be canceled while it is ${intent.status}.`), { code: 'PAYMENT_NOT_CANCELABLE' });
  }

  async refund(intentId: string, idempotencyKey: string): Promise<string> {
    const refund = await this.stripe.refunds.create({ payment_intent: intentId, reason: 'requested_by_customer' }, { idempotencyKey });
    return refund.id;
  }

  async calculateTax(options: { reference: string; printingMinor: number; shippingMinor: number; currency: string; address: CookbookPrintAddress; idempotencyKey: string }): Promise<RetailTaxResult> {
    if (process.env.STRIPE_TAX_ENABLED !== 'true') {
      throw Object.assign(new Error('Retail tax calculation is not configured.'), { code: 'TAX_NOT_CONFIGURED' });
    }
    const calculation = await this.stripe.tax.calculations.create({
      currency: options.currency.toLowerCase(),
      customer_details: { address: stripeAddress(options.address), address_source: 'shipping' },
      line_items: [
        {
          amount: options.printingMinor,
          reference: `${options.reference}:book`,
          tax_behavior: 'exclusive',
          tax_code: process.env.STRIPE_PRINTED_BOOK_TAX_CODE || 'txcd_35010000',
        },
      ],
      shipping_cost: {
        amount: options.shippingMinor,
        tax_behavior: 'exclusive',
        tax_code: process.env.STRIPE_SHIPPING_TAX_CODE || 'txcd_92010001',
      },
    }, { idempotencyKey: options.idempotencyKey });
    if (!calculation.id) throw new Error('STRIPE_TAX_CALCULATION_ID_MISSING');
    return {
      calculationId: calculation.id,
      amountTax: calculation.tax_amount_exclusive,
      amountTotal: calculation.amount_total,
      currency: calculation.currency.toUpperCase(),
      expiresAt: calculation.expires_at ? new Date(calculation.expires_at * 1_000).toISOString() : undefined,
    };
  }

  async findTaxAssociation(intentId: string): Promise<RetailTaxAssociationResult> {
    const association = await this.stripe.tax.associations.find({ payment_intent: intentId });
    const attempt = association.tax_transaction_attempts?.find(item => item.source === intentId);
    return {
      calculationId: association.calculation,
      transactionId: attempt?.committed?.transaction,
      errorCode: attempt?.errored?.reason,
    };
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event> {
    if (!this.webhookSecret) throw new PrintConfigurationError('Stripe webhook secret is missing.');
    return this.stripe.webhooks.constructEventAsync(rawBody, signature, this.webhookSecret);
  }
}

export function stripePayments(): PaymentGateway {
  return new StripePaymentGateway();
}
