import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { CookbookPrintAddress } from '@fridgie/shared/types';
import { StripePaymentGateway } from '../utils/cookbookPrintPayment';
import { LULU_PRODUCTS, LuluPrintProvider } from '../utils/cookbookPrintProvider';

const address: CookbookPrintAddress = {
  name: 'Ada Cook',
  line1: '12 Test Kitchen Road',
  line2: 'Unit 3',
  city: 'Toronto',
  stateOrProvince: 'ON',
  postalCode: 'M5V 2T6',
  country: 'CA',
  phone: '+14165550123',
};

const luluConfig = {
  environment: 'sandbox' as const,
  clientKey: 'sandbox-client',
  clientSecret: 'sandbox-secret',
  softcoverPodPackageId: LULU_PRODUCTS['matte-softcover'].podPackageId,
  hardcoverPodPackageId: LULU_PRODUCTS['matte-hardcover'].podPackageId,
  productionEnabled: false,
  productionValidationAcknowledged: false,
};

type Call = { url: string; init: RequestInit };

function bodyOf(call: Call): any {
  if (typeof call.init.body !== 'string') throw new Error(`Expected a JSON body for ${call.url}`);
  return JSON.parse(call.init.body);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function luluFixtureFetch() {
  const calls: Call[] = [];
  const request = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/auth/realms/glasstree/protocol/openid-connect/token')) {
      return json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    if (url.endsWith('/print-api/v1/shipping-options/')) {
      return json({ shipping_options: [
        {
          level: 'MAIL',
          cost_excl_tax: '7.00',
          min_dispatch_date: '2026-10-02',
          max_dispatch_date: '2026-10-03',
          min_delivery_date: '2026-10-08',
          max_delivery_date: '2026-10-09',
        },
        { level: 'EXPRESS', cost_excl_tax: '18.00' },
      ] });
    }
    if (url.endsWith('/print-api/v1/print-job-cost-calculations/')) {
      return json({
        id: 9988,
        currency: 'CAD',
        total_cost_incl_tax: '25.50',
        total_tax: '1.50',
        shipping_cost: { total_cost_excl_tax: '7.00' },
        line_item_costs: [{ total_cost_excl_tax: '17.00' }],
      });
    }
    if (url.endsWith('/print-api/v1/print-jobs/') && init.method === 'POST') {
      return json({
        id: 4321,
        external_id: 'order-fixture',
        status: { name: 'CREATED' },
        line_items: [{
          status: { name: 'CREATED' },
          carrier_name: 'Canada Post',
          tracking_id: 'TRACK123',
          tracking_url: 'https://tracking.example/TRACK123',
        }],
      });
    }
    if (url.includes('/print-api/v1/print-jobs/?')) {
      return json({ results: [{ id: 4321, external_id: 'order-fixture', status: { name: 'CREATED' }, line_items: [] }] });
    }
    throw new Error(`Unexpected fixture request: ${init.method || 'GET'} ${url}`);
  }) as typeof fetch;
  return { request, calls };
}

describe('Lulu provider contract', () => {
  test('builds sandbox shipping/cost requests and parses a complete landed-cost quote', async () => {
    const fixture = luluFixtureFetch();
    const provider = new LuluPrintProvider(luluConfig, fixture.request);
    const quote = await provider.quote({
      sku: 'matte-softcover',
      pageCount: 64,
      quantity: 1,
      address,
    });

    expect(quote).toMatchObject({
      providerQuoteId: '9988',
      printing: { amountMinor: 1700, currency: 'CAD' },
      shipping: { amountMinor: 700, currency: 'CAD' },
      providerTax: { amountMinor: 150, currency: 'CAD' },
      fulfillmentFee: { amountMinor: 0, currency: 'CAD' },
      total: { amountMinor: 2550, currency: 'CAD' },
      shippingLevel: 'MAIL',
      productionEstimate: 'Estimated to leave production 2026-10-03',
      deliveryEstimate: 'Estimated delivery 2026-10-09',
    });

    const auth = fixture.calls.find(call => call.url.endsWith('/token'))!;
    expect(auth.init.method).toBe('POST');
    expect(new Headers(auth.init.headers).get('Authorization')).toBe(`Basic ${Buffer.from('sandbox-client:sandbox-secret').toString('base64')}`);
    expect(String(auth.init.body)).toBe('grant_type=client_credentials');

    const shipping = fixture.calls.find(call => call.url.endsWith('/shipping-options/'))!;
    expect(bodyOf(shipping)).toEqual({
      currency: 'CAD',
      line_items: [{
        page_count: 64,
        pod_package_id: LULU_PRODUCTS['matte-softcover'].podPackageId,
        quantity: 1,
      }],
      shipping_address: {
        name: 'Ada Cook',
        street1: '12 Test Kitchen Road',
        street2: 'Unit 3',
        city: 'Toronto',
        state: 'ON',
        postcode: 'M5V 2T6',
        country: 'CA',
        phone_number: '+14165550123',
        is_business: false,
        is_postbox: false,
      },
    });

    const calculation = fixture.calls.find(call => call.url.endsWith('/print-job-cost-calculations/'))!;
    expect(bodyOf(calculation)).toMatchObject({
      line_items: [{ page_count: 64, quantity: 1 }],
      shipping_option: 'MAIL',
      shipping_address: {
        name: 'Ada Cook',
        street1: '12 Test Kitchen Road',
        street2: 'Unit 3',
        city: 'Toronto',
        state_code: 'ON',
        postcode: 'M5V 2T6',
        country_code: 'CA',
        phone_number: '+14165550123',
        is_business: false,
      },
    });
  });

  test('submits immutable artifact URLs/checksums under the Fridgie order id and reuses its access token', async () => {
    const fixture = luluFixtureFetch();
    const provider = new LuluPrintProvider(luluConfig, fixture.request);
    await provider.quote({ sku: 'matte-softcover', pageCount: 64, quantity: 1, address });
    const result = await provider.submit({
      orderId: 'order-fixture',
      contactEmail: 'ada@example.com',
      title: 'Kitchen Keepsakes',
      sku: 'matte-softcover',
      pageCount: 64,
      quantity: 1,
      address,
      shippingLevel: 'MAIL',
      interiorUrl: 'https://signed.example/interior.pdf',
      coverUrl: 'https://signed.example/cover.pdf',
      interiorMd5: '11111111111111111111111111111111',
      coverMd5: '22222222222222222222222222222222',
    });

    expect(result).toMatchObject({
      providerOrderId: '4321',
      status: 'CREATED',
      lineItemStatus: 'CREATED',
      tracking: {
        carrier: 'Canada Post',
        trackingNumber: 'TRACK123',
        trackingUrl: 'https://tracking.example/TRACK123',
      },
    });
    expect(fixture.calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1);

    const submission = fixture.calls.find(call => call.url.endsWith('/print-jobs/') && call.init.method === 'POST')!;
    expect(bodyOf(submission)).toEqual({
      contact_email: 'ada@example.com',
      external_id: 'order-fixture',
      production_delay: 1440,
      shipping_address: {
        name: 'Ada Cook',
        street1: '12 Test Kitchen Road',
        street2: 'Unit 3',
        city: 'Toronto',
        state_code: 'ON',
        postcode: 'M5V 2T6',
        country_code: 'CA',
        phone_number: '+14165550123',
        email: 'ada@example.com',
        is_business: false,
      },
      shipping_level: 'MAIL',
      line_items: [{
        external_id: 'order-fixture:book',
        title: 'Kitchen Keepsakes',
        quantity: 1,
        pod_package_id: LULU_PRODUCTS['matte-softcover'].podPackageId,
        cover: {
          source_url: 'https://signed.example/cover.pdf',
          source_md5_sum: '22222222222222222222222222222222',
        },
        interior: {
          source_url: 'https://signed.example/interior.pdf',
          source_md5_sum: '11111111111111111111111111111111',
        },
      }],
    });
  });

  test('reconciles by exact external id rather than trusting a fuzzy provider search', async () => {
    const fixture = luluFixtureFetch();
    const provider = new LuluPrintProvider(luluConfig, fixture.request);
    const found = await provider.findByExternalId('order-fixture');
    expect(found).toMatchObject({ providerOrderId: '4321', status: 'CREATED' });
    const search = fixture.calls.find(call => call.url.includes('/print-jobs/?'))!;
    expect(search.init.method).toBeUndefined();
    expect(search.url).toContain('search=order-fixture');
    expect(search.url).toContain('created_after=');
  });

  test('walks provider result pages before deciding an ambiguous submission is absent', async () => {
    const calls: string[] = [];
    const request = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/token')) return json({ access_token: 'fixture-access-token', expires_in: 3600 });
      if (url.includes('page=1&')) return json({ next: 'page-2', results: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, external_id: `other-${index}`, status: { name: 'CREATED' } })) });
      if (url.includes('page=2&')) return json({ next: null, results: [{ id: 7654, external_id: 'order-on-page-two', status: { name: 'CREATED' }, line_items: [] }] });
      throw new Error(`Unexpected fixture request ${url}`);
    }) as unknown as typeof fetch;
    const provider = new LuluPrintProvider(luluConfig, request);
    expect(await provider.findByExternalId('order-on-page-two')).toMatchObject({ providerOrderId: '7654' });
    expect(calls.some(url => url.includes('page=2&'))).toBe(true);
  });

  test('rejects incomplete or internally inconsistent cost calculations', async () => {
    const request = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/token')) return json({ access_token: 'fixture-access-token', expires_in: 3600 });
      if (url.endsWith('/shipping-options/')) return json({ shipping_options: [{ level: 'MAIL', cost_excl_tax: '7.00' }] });
      if (url.endsWith('/print-job-cost-calculations/')) return json({ currency: 'CAD', shipping_cost: { total_cost_excl_tax: '7.00' }, line_item_costs: [] });
      throw new Error(`Unexpected fixture request ${url}`);
    }) as unknown as typeof fetch;
    const provider = new LuluPrintProvider(luluConfig, request);
    await expect(provider.quote({ sku: 'matte-softcover', pageCount: 64, quantity: 1, address })).rejects.toMatchObject({ code: 'LULU_QUOTE_INVALID' });
  });

  test('verifies Lulu HMAC in hex and base64 and rejects missing/tampered signatures', () => {
    const provider = new LuluPrintProvider(luluConfig, (() => { throw new Error('network should not be used'); }) as unknown as typeof fetch);
    const raw = JSON.stringify({ id: 4321, external_id: 'order-fixture', status: 'SHIPPED' });
    const digest = createHmac('sha256', luluConfig.clientSecret).update(raw).digest();
    expect(provider.verifyWebhook(raw, `sha256=${digest.toString('hex')}`)).toBe(true);
    expect(provider.verifyWebhook(raw, digest.toString('base64'))).toBe(true);
    expect(provider.verifyWebhook(`${raw} `, digest.toString('hex'))).toBe(false);
    expect(provider.verifyWebhook(raw, null)).toBe(false);
    expect(provider.verifyWebhook(raw, 'not-a-signature')).toBe(false);
  });
});

describe('Stripe webhook verification', () => {
  test('attaches the Stripe Tax calculation to the manual-capture PaymentIntent', async () => {
    const gateway = new StripePaymentGateway({
      secretKey: 'sk_test_fixture',
      publishableKey: 'pk_test_fixture',
      webhookSecret: 'whsec_fixture',
    });
    let params: any;
    let requestOptions: any;
    (gateway as any).stripe.paymentIntents.create = async (input: unknown, options: unknown) => {
      params = input;
      requestOptions = options;
      return { id: 'pi_fixture', client_secret: 'pi_fixture_secret_fixture', status: 'requires_payment_method' };
    };

    await gateway.createAuthorization({
      orderId: 'order-fixture',
      amountMinor: 2550,
      currency: 'CAD',
      taxCalculationId: 'taxcalc_fixture',
      idempotencyKey: 'order:order-fixture:payment-intent:v1',
    });

    expect(params).toMatchObject({
      amount: 2550,
      currency: 'cad',
      capture_method: 'manual',
      hooks: { inputs: { tax: { calculation: 'taxcalc_fixture' } } },
      metadata: { order_id: 'order-fixture' },
    });
    expect(requestOptions).toEqual({ idempotencyKey: 'order:order-fixture:payment-intent:v1' });
  });

  test('recovers an already-succeeded capture without issuing a second capture request', async () => {
    const gateway = new StripePaymentGateway({
      secretKey: 'sk_test_fixture',
      publishableKey: 'pk_test_fixture',
      webhookSecret: 'whsec_fixture',
    });
    let captures = 0;
    (gateway as any).stripe.paymentIntents.retrieve = async () => ({ id: 'pi_fixture', status: 'succeeded' });
    (gateway as any).stripe.paymentIntents.capture = async () => { captures += 1; return { id: 'pi_fixture', status: 'succeeded' }; };

    expect(await gateway.capture('pi_fixture', 'order:order-fixture:capture:v1')).toBe('succeeded');
    expect(captures).toBe(0);
  });

  test('verifies the untouched raw body locally and rejects tampering without any network call', async () => {
    const secret = 'whsec_fixture_secret';
    const gateway = new StripePaymentGateway({
      secretKey: 'sk_test_fixture',
      publishableKey: 'pk_test_fixture',
      webhookSecret: secret,
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const raw = JSON.stringify({
      id: 'evt_fixture',
      object: 'event',
      api_version: '2025-02-24.acacia',
      created: timestamp,
      data: { object: { id: 'pi_fixture', object: 'payment_intent', metadata: { order_id: 'order-fixture' } } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: 'payment_intent.amount_capturable_updated',
    });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    expect(await gateway.verifyWebhook(raw, header)).toMatchObject({
      id: 'evt_fixture',
      type: 'payment_intent.amount_capturable_updated',
      data: { object: { id: 'pi_fixture' } },
    });
    await expect(gateway.verifyWebhook(`${raw}\n`, header)).rejects.toThrow();
    await expect(gateway.verifyWebhook(raw, `t=${timestamp},v1=${'0'.repeat(64)}`)).rejects.toThrow();
  });
});
