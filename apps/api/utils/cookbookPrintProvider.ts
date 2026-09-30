import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookbookPrintAddress, CookbookPrintMoney, CookbookPrintSku } from '@fridgie/shared/types';
import type { CoverGeometry } from './cookbookPrintPdf';

export const LULU_PRODUCTS: Record<CookbookPrintSku, { podPackageId: string; minPages: number; maxPages: number }> = {
  'matte-softcover': { podPackageId: '0700X1000.FC.STD.PB.080CW444.MXX', minPages: 32, maxPages: 800 },
  'matte-hardcover': { podPackageId: '0700X1000.FC.STD.CW.080CW444.MXX', minPages: 24, maxPages: 800 },
};

export interface ProviderQuoteRequest {
  sku: CookbookPrintSku;
  pageCount: number;
  quantity: 1;
  address: CookbookPrintAddress;
  shippingLevel?: string;
}

export interface ProviderQuoteResult {
  providerQuoteId?: string;
  printing: CookbookPrintMoney;
  shipping: CookbookPrintMoney;
  providerTax: CookbookPrintMoney;
  fulfillmentFee: CookbookPrintMoney;
  total: CookbookPrintMoney;
  shippingLevel: string;
  productionEstimate?: string;
  deliveryEstimate?: string;
  raw: unknown;
}

export interface ProviderSubmitRequest {
  orderId: string;
  contactEmail: string;
  title: string;
  sku: CookbookPrintSku;
  pageCount: number;
  quantity: 1;
  address: CookbookPrintAddress;
  shippingLevel: string;
  interiorUrl: string;
  coverUrl: string;
  interiorMd5: string;
  coverMd5: string;
}

export interface ProviderOrderResult {
  providerOrderId: string;
  externalId?: string;
  status: string;
  lineItemStatus?: string;
  tracking?: { carrier?: string; trackingNumber?: string; trackingUrl?: string };
  raw: unknown;
}

export interface PrintProvider {
  readonly id: 'lulu';
  readonly name: string;
  quote(request: ProviderQuoteRequest): Promise<ProviderQuoteResult>;
  submit(request: ProviderSubmitRequest): Promise<ProviderOrderResult>;
  getOrder(providerOrderId: string): Promise<ProviderOrderResult>;
  findByExternalId(orderId: string): Promise<ProviderOrderResult | null>;
  coverGeometry(sku: CookbookPrintSku, pageCount: number): Promise<CoverGeometry | undefined>;
  verifyWebhook(rawBody: string, signature: string | null): boolean;
}

type LuluEnvironment = 'sandbox' | 'production';

interface LuluConfig {
  environment: LuluEnvironment;
  clientKey: string;
  clientSecret: string;
  softcoverPodPackageId: string;
  hardcoverPodPackageId: string;
  productionEnabled: boolean;
  productionValidationAcknowledged: boolean;
}

export class PrintConfigurationError extends Error {
  readonly code = 'PRINT_NOT_CONFIGURED';
  readonly status = 503;
}

function configFromEnvironment(): LuluConfig {
  const environment = process.env.LULU_ENV === 'production' ? 'production' : 'sandbox';
  return {
    environment,
    clientKey: process.env.LULU_CLIENT_KEY || '',
    clientSecret: process.env.LULU_CLIENT_SECRET || '',
    softcoverPodPackageId: process.env.LULU_SOFTCOVER_POD_PACKAGE_ID || LULU_PRODUCTS['matte-softcover'].podPackageId,
    hardcoverPodPackageId: process.env.LULU_HARDCOVER_POD_PACKAGE_ID || LULU_PRODUCTS['matte-hardcover'].podPackageId,
    productionEnabled: process.env.PRINT_PRODUCTION_ENABLED === 'true',
    productionValidationAcknowledged: process.env.PRINT_LULU_VALIDATION_ACKNOWLEDGED === 'true',
  };
}

/** Fail closed: selecting Lulu production is not enough to make a real book. */
export function assertLuluConfiguration(config = configFromEnvironment()): LuluConfig {
  if (!config.clientKey || !config.clientSecret) throw new PrintConfigurationError('Lulu credentials are missing. Preview is available, but checkout is not configured.');
  if (config.environment === 'production' && (!config.productionEnabled || !config.productionValidationAcknowledged)) {
    throw new PrintConfigurationError('Production printing is locked until the explicit production and Lulu validation gates are enabled.');
  }
  if (process.env.NODE_ENV === 'production' && config.environment !== 'production' && process.env.PRINT_ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
    // A production deployment may intentionally host a staff sandbox, but only
    // behind another explicit flag. Never silently mix live Stripe with Lulu's
    // sandbox.
    throw new PrintConfigurationError('This production deployment is not explicitly configured for Lulu sandbox use.');
  }
  return config;
}

function baseUrl(environment: LuluEnvironment): string {
  return environment === 'production' ? 'https://api.lulu.com' : 'https://api.sandbox.lulu.com';
}

function podPackageId(config: LuluConfig, sku: CookbookPrintSku): string {
  return sku === 'matte-softcover' ? config.softcoverPodPackageId : config.hardcoverPodPackageId;
}

function luluAddress(address: CookbookPrintAddress, email = process.env.PRINT_SUPPORT_EMAIL || 'support@fridgie.ca') {
  return {
    name: address.name,
    street1: address.line1,
    ...(address.line2 ? { street2: address.line2 } : {}),
    city: address.city,
    state_code: address.stateOrProvince,
    postcode: address.postalCode,
    country_code: address.country.toUpperCase(),
    phone_number: address.phone,
    email,
    is_business: false,
  };
}

function luluShippingOptionsAddress(address: CookbookPrintAddress) {
  return {
    name: address.name,
    street1: address.line1,
    street2: address.line2 || '',
    city: address.city,
    state: address.stateOrProvince,
    postcode: address.postalCode,
    country: address.country.toUpperCase(),
    phone_number: address.phone,
    is_business: false,
    is_postbox: false,
  };
}

function quoteCurrency(country: string): string {
  if (process.env.PRINT_QUOTE_CURRENCY) return process.env.PRINT_QUOTE_CURRENCY.toUpperCase();
  if (country.toUpperCase() === 'CA') return 'CAD';
  if (country.toUpperCase() === 'AU') return 'AUD';
  if (country.toUpperCase() === 'GB') return 'GBP';
  return 'USD';
}

function decimalMinor(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 100);
  return undefined;
}

function firstMinor(object: any, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = path.split('.').reduce((cursor, key) => cursor?.[key], object);
    const parsed = decimalMinor(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function currencyFrom(object: any): string {
  const value = object?.currency || object?.currency_code || object?.total_cost?.currency || object?.cost?.currency;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/i.test(value)) throw new Error('LULU_QUOTE_CURRENCY_MISSING');
  return value.toUpperCase();
}

export class LuluPrintProvider implements PrintProvider {
  readonly id = 'lulu' as const;
  readonly name = 'Lulu Press, Inc.';
  private token?: { value: string; expiresAt: number };

  constructor(private readonly configured: LuluConfig = configFromEnvironment(), private readonly request: typeof fetch = fetch) {}

  private config() { return assertLuluConfiguration(this.configured); }

  private async accessToken(): Promise<string> {
    const config = this.config();
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.request(`${baseUrl(config.environment)}/auth/realms/glasstree/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientKey}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Lulu authentication failed (${response.status}).`), { code: 'LULU_AUTH_FAILED', retryable: response.status >= 500 });
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('LULU_AUTH_INVALID');
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 3600) * 1_000 };
    return body.access_token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const config = this.config();
    const response = await this.request(`${baseUrl(config.environment)}/print-api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let body: any;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { detail: raw.slice(0, 500) }; }
    if (!response.ok) {
      throw Object.assign(new Error(`Lulu request failed (${response.status}).`), {
        code: response.status === 400 || response.status === 422 ? 'LULU_REJECTED' : 'LULU_UNAVAILABLE',
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        providerStatus: response.status,
        providerDetail: body?.detail || body?.message,
      });
    }
    return body;
  }

  async quote(request: ProviderQuoteRequest): Promise<ProviderQuoteResult> {
    const config = this.config();
    const product = { page_count: request.pageCount, pod_package_id: podPackageId(config, request.sku), quantity: request.quantity };
    const address = luluAddress(request.address);
    const currency = quoteCurrency(request.address.country);
    const shippingOptions = await this.api('/shipping-options/', { method: 'POST', body: JSON.stringify({ currency, line_items: [product], shipping_address: luluShippingOptionsAddress(request.address) }) });
    const options = Array.isArray(shippingOptions) ? shippingOptions : shippingOptions?.shipping_options ?? shippingOptions?.results ?? [];
    const selected = request.shippingLevel
      ? options.find((option: any) => option?.level === request.shippingLevel || option?.shipping_level === request.shippingLevel)
      : options.find((option: any) => option?.level === 'MAIL' || option?.shipping_level === 'MAIL') ?? options[0];
    const shippingLevel = selected?.level || selected?.shipping_level;
    if (!shippingLevel) throw Object.assign(new Error('No shipping method is available for this address.'), { code: 'SHIPPING_UNAVAILABLE' });
    const calculation = await this.api('/print-job-cost-calculations/', {
      method: 'POST',
      // The current OpenAPI body schema says shipping_option while several
      // first-party code examples say shipping_level. Schema wins by default;
      // keep the override only for a sandbox-proven account contract.
      body: JSON.stringify({ line_items: [product], shipping_address: address, [process.env.LULU_COST_SHIPPING_FIELD || 'shipping_option']: shippingLevel }),
    });
    const responseCurrency = currencyFrom(calculation);
    const totalMinor = firstMinor(calculation, ['total_cost_incl_tax', 'total_cost', 'total']);
    const shippingMinor = firstMinor(calculation, ['shipping_cost.total_cost_excl_tax', 'shipping_cost.cost_excl_tax', 'shipping_cost', 'shipping'])
      ?? firstMinor(selected, ['cost_excl_tax', 'cost']);
    if (totalMinor === undefined || totalMinor <= 0 || shippingMinor === undefined || shippingMinor < 0) {
      throw Object.assign(new Error('Lulu returned an incomplete cost calculation.'), { code: 'LULU_QUOTE_INVALID', retryable: false });
    }
    const taxMinor = firstMinor(calculation, ['total_tax', 'tax', 'tax_cost']) ?? 0;
    const lineCosts = Array.isArray(calculation?.line_item_costs) ? calculation.line_item_costs : [];
    const declaredPrintingMinor = lineCosts.reduce((sum: number, item: any) => sum + (firstMinor(item, ['total_cost_excl_tax', 'cost_excl_tax', 'cost']) ?? 0), 0);
    const printingMinor = declaredPrintingMinor || totalMinor - shippingMinor - taxMinor;
    const fulfillmentMinor = totalMinor - printingMinor - shippingMinor - taxMinor;
    if (printingMinor <= 0 || taxMinor < 0 || fulfillmentMinor < 0) {
      throw Object.assign(new Error('Lulu returned an inconsistent cost calculation.'), { code: 'LULU_QUOTE_INVALID', retryable: false });
    }
    const money = (amountMinor: number): CookbookPrintMoney => ({ amountMinor, currency: responseCurrency });
    const dispatch = selected?.max_dispatch_date || selected?.min_dispatch_date;
    const delivery = selected?.max_delivery_date || selected?.min_delivery_date;
    return {
      providerQuoteId: calculation?.id ? String(calculation.id) : undefined,
      printing: money(printingMinor), shipping: money(shippingMinor), providerTax: money(taxMinor), fulfillmentFee: money(fulfillmentMinor), total: money(totalMinor),
      shippingLevel,
      productionEstimate: dispatch ? `Estimated to leave production ${dispatch}` : 'Usually 3-5 business days in production',
      deliveryEstimate: delivery ? `Estimated delivery ${delivery}` : undefined,
      raw: { shippingOption: selected, calculation },
    };
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderOrderResult> {
    const config = this.config();
    const body = {
      contact_email: request.contactEmail,
      external_id: request.orderId,
      production_delay: Math.max(60, Math.min(1440, Number(process.env.LULU_PRODUCTION_DELAY_MINUTES || 1440))),
      shipping_address: luluAddress(request.address, request.contactEmail),
      shipping_level: request.shippingLevel,
      line_items: [{
        external_id: `${request.orderId}:book`,
        title: request.title,
        quantity: request.quantity,
        pod_package_id: podPackageId(config, request.sku),
        cover: { source_url: request.coverUrl, source_md5_sum: request.coverMd5 },
        interior: { source_url: request.interiorUrl, source_md5_sum: request.interiorMd5 },
      }],
    };
    const result = await this.api('/print-jobs/', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return this.normalizeOrder(result);
  }

  async getOrder(providerOrderId: string): Promise<ProviderOrderResult> {
    const result = await this.api(`/print-jobs/${encodeURIComponent(providerOrderId)}/`);
    return this.normalizeOrder(result);
  }

  async findByExternalId(orderId: string): Promise<ProviderOrderResult | null> {
    const createdAfter = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // Lulu documents `external_id` as a searchable reference, not a unique or
    // idempotent key. Walk bounded result pages and exact-match locally before
    // deciding an ambiguous submission is safe to repeat.
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.api(`/print-jobs/?search=${encodeURIComponent(orderId)}&created_after=${encodeURIComponent(createdAfter)}&page=${page}&page_size=100`);
      const rows = Array.isArray(result) ? result : result?.results ?? [];
      const match = rows.find((item: any) => String(item?.external_id) === orderId);
      if (match) return this.normalizeOrder(match);
      if (!result?.next && rows.length < 100) break;
    }
    return null;
  }

  async coverGeometry(_sku: CookbookPrintSku, _pageCount: number): Promise<CoverGeometry | undefined> {
    // Lulu's public OpenAPI does not currently expose a reliable custom-cover
    // geometry endpoint. Softcover geometry is calculated locally from the
    // official formula. Casewrap requires operator-supplied template values and
    // remains blocked by the providerVerified preflight error.
    return undefined;
  }

  verifyWebhook(rawBody: string, signature: string | null): boolean {
    if (!signature || !this.configured.clientSecret) return false;
    const expected = createHmac('sha256', this.configured.clientSecret).update(rawBody).digest();
    const header = signature.trim().replace(/^sha256=/i, '');
    const received = /^[a-f0-9]{64}$/i.test(header)
      ? Buffer.from(header, 'hex')
      : /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(header)
        ? Buffer.from(header, 'base64')
        : Buffer.alloc(0);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private normalizeOrder(result: any): ProviderOrderResult {
    const line = Array.isArray(result?.line_items) ? result.line_items[0] : undefined;
    const providerOrderId = result?.id ?? result?.print_job_id;
    if (providerOrderId === undefined || providerOrderId === null) throw new Error('LULU_ORDER_ID_MISSING');
    return {
      providerOrderId: String(providerOrderId),
      externalId: typeof result?.external_id === 'string' ? result.external_id : undefined,
      status: String(result?.status?.name ?? result?.status ?? 'UNKNOWN'),
      lineItemStatus: line ? String(line?.status?.name ?? line?.status ?? '') || undefined : undefined,
      tracking: line && (line.tracking_id || line.tracking_url || line.tracking_urls?.[0]) ? {
        carrier: line.carrier_name || line.carrier,
        trackingNumber: line.tracking_id,
        trackingUrl: line.tracking_url || line.tracking_urls?.[0],
      } : undefined,
      raw: result,
    };
  }
}

export function luluProvider(): PrintProvider {
  return new LuluPrintProvider();
}
