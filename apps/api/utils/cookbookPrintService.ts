import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type {
  CookbookPrintAddress,
  CookbookPrintCheckoutSession,
  CookbookPrintDraft,
  CookbookPrintDraftInput,
  CookbookPrintEligibilitySummary,
  CookbookPrintOrder,
  CookbookPrintPreview,
  CookbookPrintQuote,
  Recipe,
} from '@fridgie/shared/types';
import { adminAuth } from './firebase';
import { getCookbook } from '@/api/cookbook';
import {
  COOKBOOK_PRINT_MILESTONE,
  COOKBOOK_PRINT_LAYOUT_VERSION,
  COOKBOOK_PRINT_POLICY_VERSION,
  canTransitionFulfillment,
  canTransitionPayment,
  cookbookPrintFeatureAvailable,
  cookbookPrintHash,
  createCookbookPrintSnapshot,
  defaultDraftInput,
  layoutCookbook,
  printableCookbook,
  quoteBinding,
  quoteExpired,
  sanitizeDraftInput,
  type CookbookPrintSnapshot,
} from './cookbookPrint';
import { renderCookbookPdfs, rasterizePdf } from './cookbookPrintPdf';
import { luluProvider, type PrintProvider, type ProviderOrderResult } from './cookbookPrintProvider';
import { stripePayments, type PaymentGateway } from './cookbookPrintPayment';
import {
  deleteStoredPrintArtifacts,
  promotePrintArtifacts,
  signPrintArtifacts,
  storePrintArtifacts,
  type StoredPrintArtifacts,
} from './cookbookPrintStorage';
import { CookbookPrintStore, type StoredDraft, type StoredOrder, type StoredQuote } from './cookbookPrintStore';

export class CookbookPrintError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra?: Record<string, unknown>) { super(message); }
}

function requiredText(value: unknown, label: string, max: number): string {
  const result = typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (!result) throw new CookbookPrintError('INVALID_ADDRESS', `${label} is required.`);
  return result;
}

export function sanitizePrintAddress(value: unknown): CookbookPrintAddress {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const country = requiredText(row.country, 'Country', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new CookbookPrintError('INVALID_ADDRESS', 'Use a two-letter country code.');
  const stateOrProvince = typeof row.stateOrProvince === 'string' ? row.stateOrProvince.trim().toUpperCase() : '';
  const subdivisionRequired = ['AU', 'CA', 'MX', 'US'].includes(country);
  if ((subdivisionRequired || stateOrProvince) && !/^[A-Z]{2,3}$/.test(stateOrProvince)) {
    throw new CookbookPrintError('INVALID_ADDRESS', 'Use the 2- or 3-letter province or state code required by the printer.');
  }
  const phone = requiredText(row.phone, 'Phone number', 20);
  if (!/^\+?[\d\s\-.\/()]{8,20}$/.test(phone)) {
    throw new CookbookPrintError('INVALID_ADDRESS', 'Use a valid 8-20 character delivery phone number.');
  }
  return {
    name: requiredText(row.name, 'Recipient name', 100),
    line1: requiredText(row.line1, 'Street address', 120),
    line2: typeof row.line2 === 'string' ? row.line2.trim().slice(0, 120) || undefined : undefined,
    city: requiredText(row.city, 'City', 80),
    stateOrProvince,
    postalCode: requiredText(row.postalCode, 'Postal code', 24),
    country,
    phone,
  };
}

function addressHash(address: CookbookPrintAddress): string {
  return cookbookPrintHash({ ...address, name: address.name.toLocaleLowerCase(), line1: address.line1.toLocaleLowerCase(), city: address.city.toLocaleLowerCase(), postalCode: address.postalCode.replace(/\s/g, '').toUpperCase() });
}

function publicOrder(order: StoredOrder): CookbookPrintOrder {
  return {
    id: order.id, draftId: order.draftId, snapshotId: order.snapshotId, quoteId: order.quoteId,
    title: order.title, sku: order.sku, quantity: 1, total: order.total,
    paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus,
    provider: 'lulu', providerName: order.providerName, providerStatus: order.providerStatus,
    tracking: order.tracking, lastFailure: order.lastFailure, createdAt: order.createdAt, updatedAt: order.updatedAt,
  };
}

export function publicPrintDraft(draft: StoredDraft): CookbookPrintDraft {
  const {
    id, revision, status, createdAt, updatedAt, lastPreviewRevision,
    title, subtitle, dedication, byline, theme, sku, coverRecipeId, coverCrop,
    includeTableOfContents, includeIndex, recipes,
  } = draft;
  return {
    id, revision, status, createdAt, updatedAt, lastPreviewRevision,
    title, subtitle, dedication, byline, theme, sku, coverRecipeId, coverCrop,
    includeTableOfContents, includeIndex, recipes,
  };
}

function sanitizedFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  const item = error as any;
  const code = typeof item?.code === 'string' ? item.code.slice(0, 80) : 'PRINT_PROVIDER_ERROR';
  const retryable = item?.retryable !== false && code !== 'LULU_REJECTED';
  const message = retryable
    ? 'The printer could not accept the job yet. Your payment is safe and this can be retried.'
    : 'The printer rejected the files or order details. No fulfilled order was reported.';
  return { code, message, retryable };
}

function renderPagesForStore(draft: StoredDraft, signed: Awaited<ReturnType<typeof signPrintArtifacts>>): CookbookPrintPreview['pages'] {
  const pages = draft.render?.pages ?? [];
  return pages.map((page: any, index: number) => ({
    pageNumber: page.pageNumber,
    kind: page.kind,
    label: page.label,
    recipeId: page.recipeId,
    section: page.section,
    imageUrl: signed.previewPageUrls[index],
    imageExpiresAt: signed.expiresAt,
  }));
}

export interface CookbookPrintDependencies {
  store: CookbookPrintStore;
  provider: PrintProvider;
  payments: () => PaymentGateway;
  cookbook: (uid: string) => Promise<Recipe[]>;
  account: (uid: string) => Promise<{ displayName?: string | null; email?: string | null }>;
  now: () => Date;
}

export class CookbookPrintService {
  constructor(private readonly dependencies: CookbookPrintDependencies = {
    store: new CookbookPrintStore(),
    provider: luluProvider(),
    payments: stripePayments,
    cookbook: uid => getCookbook(uid) as unknown as Promise<Recipe[]>,
    account: async uid => {
      const account = await adminAuth.getUser(uid);
      return { displayName: account.displayName, email: account.email };
    },
    now: () => new Date(),
  }) {}

  async eligibility(uid: string): Promise<CookbookPrintEligibilitySummary> {
    const recipes = printableCookbook(uid, await this.dependencies.cookbook(uid));
    const restrictedCount = recipes.filter(recipe => recipe.printRestriction !== 'none').length;
    return {
      featureAvailable: cookbookPrintFeatureAvailable(),
      eligibleCount: recipes.length,
      restrictedCount,
      milestoneReached: recipes.length >= COOKBOOK_PRINT_MILESTONE,
      recipes,
    };
  }

  async getOrCreateDraft(uid: string, requested?: unknown): Promise<StoredDraft> {
    const existing = await this.dependencies.store.getDraft(uid);
    if (existing) return existing;
    const [eligibility, account] = await Promise.all([this.eligibility(uid), this.dependencies.account(uid)]);
    const defaults = defaultDraftInput(account.displayName || '', eligibility.recipes);
    const input = requested && typeof requested === 'object'
      ? sanitizeDraftInput({ ...defaults, ...(requested as Record<string, unknown>) }, new Set(eligibility.recipes.map(recipe => recipe.id)))
      : defaults;
    return this.dependencies.store.createDraft(uid, input, this.dependencies.now());
  }

  async getDraft(uid: string, draftId: string): Promise<StoredDraft> {
    const draft = await this.dependencies.store.getDraft(uid, draftId);
    if (!draft) throw new CookbookPrintError('NOT_FOUND', 'Draft not found.', 404);
    return draft;
  }

  async updateDraft(uid: string, draftId: string, expectedRevision: number, raw: unknown): Promise<StoredDraft> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new CookbookPrintError('REVISION_REQUIRED', 'Include the draft revision.', 400);
    const recipes = printableCookbook(uid, await this.dependencies.cookbook(uid));
    const input = sanitizeDraftInput(raw, new Set(recipes.map(recipe => recipe.id)));
    if (!input.title || !input.byline) throw new CookbookPrintError('INVALID_DRAFT', 'A title and byline are required.');
    try { return await this.dependencies.store.updateDraft(uid, draftId, expectedRevision, input, this.dependencies.now()); }
    catch (error: any) {
      if (error?.code === 'REVISION_CONFLICT') throw new CookbookPrintError('REVISION_CONFLICT', error.message, 409, { draft: publicPrintDraft(error.draft) });
      throw error;
    }
  }

  private async snapshotForDraft(uid: string, draft: StoredDraft): Promise<{ snapshot: CookbookPrintSnapshot; plan: ReturnType<typeof layoutCookbook>; recipes: Recipe[] }> {
    const recipes = await this.dependencies.cookbook(uid);
    const snapshotId = `snap_${cookbookPrintHash({ ownerUid: uid, draftId: draft.id, revision: draft.revision, input: sanitizeDraftInput(draft) }).slice(0, 32)}`;
    let snapshot: CookbookPrintSnapshot;
    try {
      snapshot = createCookbookPrintSnapshot({ id: snapshotId, ownerUid: uid, draft, recipes, now: new Date(draft.updatedAt) });
    } catch (error: any) {
      throw new CookbookPrintError(error?.code || 'SNAPSHOT_INVALID', error?.message || 'The book could not be frozen for print.', 409, error?.recipeId ? { recipeId: error.recipeId } : undefined);
    }
    return { snapshot, plan: layoutCookbook(snapshot), recipes };
  }

  async preview(uid: string, draftId: string): Promise<CookbookPrintPreview> {
    let draft = await this.getDraft(uid, draftId);
    if (draft.render?.revision === draft.revision
      && draft.render.layoutVersion === COOKBOOK_PRINT_LAYOUT_VERSION
      && draft.render.artifacts.previewPagePaths.length === draft.render.pages.length) {
      const signed = await signPrintArtifacts(draft.render.artifacts, 15);
      const issues = draft.render.issues as CookbookPrintPreview['issues'];
      return {
        draftId, revision: draft.revision, generatedAt: draft.render.createdAt,
        pageCount: draft.render.artifacts.pageCount, spineWidthInches: draft.render.spineWidthInches,
        coverImageUrl: signed.coverPreviewUrl, interiorPdfUrl: signed.interiorUrl, coverPdfUrl: signed.coverUrl, urlExpiresAt: signed.expiresAt,
        pages: renderPagesForStore(draft, signed), issues, canOrder: !issues.some(issue => issue.severity === 'error'),
      };
    }
    const previous = draft.render?.artifacts;
    const { snapshot: renderSnapshot, plan } = await this.snapshotForDraft(uid, draft);
    const coverGeometry = await this.dependencies.provider.coverGeometry(renderSnapshot.sku, plan.pages.length);
    const artifacts = await renderCookbookPdfs(renderSnapshot, plan, { coverGeometry });
    // Image URLs can point at mutable remote bytes. Bind the immutable
    // snapshot identity to the exact rendered artifacts, not merely their URL
    // strings, so a later server-side image change creates a different snapshot.
    const { id: _workingId, contentHash: _inputHash, ...snapshotInput } = renderSnapshot;
    const frozenHash = cookbookPrintHash({ snapshotInput, interiorSha256: artifacts.interiorSha256, coverSha256: artifacts.coverSha256 });
    const snapshot: CookbookPrintSnapshot = { ...renderSnapshot, id: `snap_${frozenHash.slice(0, 32)}`, contentHash: frozenHash };
    const [pageImages, coverImages] = await Promise.all([
      rasterizePdf(artifacts.interior, { format: 'jpeg', dpi: 110 }),
      rasterizePdf(artifacts.cover, { format: 'jpeg', dpi: 90, firstPage: 1, lastPage: 1 }),
    ]);
    if (pageImages.length !== plan.pages.length) throw new CookbookPrintError('PREVIEW_INCOMPLETE', 'The printer preview did not contain every page.', 500);
    const stored = await storePrintArtifacts({
      ownerUid: uid, scope: 'preview', scopeId: draft.id, version: `r${draft.revision}-${artifacts.interiorSha256.slice(0, 12)}`,
      artifacts, previewPages: pageImages, coverPreview: coverImages[0], now: this.dependencies.now(),
    });
    await this.dependencies.store.saveSnapshot(snapshot, stored);
    const render = {
      revision: draft.revision,
      layoutVersion: COOKBOOK_PRINT_LAYOUT_VERSION,
      snapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      artifacts: stored,
      issues: artifacts.issues,
      spineWidthInches: plan.spineWidthInches,
      pages: plan.pages.map(({ pageNumber, kind, label, recipeId, section }) => ({ pageNumber, kind, label, recipeId, section })),
      createdAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.store.saveDraftRender(uid, draft.id, render);
    if (previous) void deleteStoredPrintArtifacts(previous).catch(() => {});
    draft = { ...draft, render };
    const signed = await signPrintArtifacts(stored, 15);
    return {
      draftId, revision: draft.revision, generatedAt: render.createdAt, pageCount: stored.pageCount, spineWidthInches: plan.spineWidthInches,
      coverImageUrl: signed.coverPreviewUrl, interiorPdfUrl: signed.interiorUrl, coverPdfUrl: signed.coverUrl, urlExpiresAt: signed.expiresAt,
      pages: renderPagesForStore(draft, signed), issues: artifacts.issues, canOrder: !artifacts.issues.some(issue => issue.severity === 'error'),
    };
  }

  async quote(uid: string, draftId: string, rawAddress: unknown): Promise<CookbookPrintQuote> {
    const address = sanitizePrintAddress(rawAddress);
    const draft = await this.getDraft(uid, draftId);
    if (!draft.render || draft.render.revision !== draft.revision || draft.render.layoutVersion !== COOKBOOK_PRINT_LAYOUT_VERSION) throw new CookbookPrintError('PREVIEW_REQUIRED', 'Generate and review the current preview before requesting a price.', 409);
    if ((draft.render.issues as CookbookPrintPreview['issues']).some(issue => issue.severity === 'error')) throw new CookbookPrintError('PREFLIGHT_FAILED', 'Resolve the print errors before requesting a price.', 409);
    const result = await this.dependencies.provider.quote({ sku: draft.sku, pageCount: draft.render.artifacts.pageCount, quantity: 1, address });
    const currency = result.total.currency;
    const basePrinting = result.printing.amountMinor + result.providerTax.amountMinor + result.fulfillmentFee.amountMinor;
    const markup = Math.max(0, Math.round(basePrinting * Number(process.env.PRINT_MARKUP_BPS || 0) / 10_000));
    const printingMinor = basePrinting + markup;
    const shippingMinor = result.shipping.amountMinor;
    let taxMinor = 0;
    let taxStatus: CookbookPrintQuote['taxStatus'] = 'unavailable';
    let taxCalculationId: string | undefined;
    let taxExpiresAt: string | undefined;
    if (process.env.STRIPE_TAX_ENABLED === 'true') {
      const taxInputHash = cookbookPrintHash({ snapshotHash: draft.render.contentHash, addressHash: addressHash(address), printingMinor, shippingMinor, currency });
      const tax = await this.dependencies.payments().calculateTax({
        reference: draft.render.snapshotId,
        printingMinor,
        shippingMinor,
        currency,
        address,
        idempotencyKey: `quote:${draft.render.snapshotId}:taxcalc:${taxInputHash.slice(0, 32)}`,
      });
      if (tax.currency !== currency || tax.amountTotal !== printingMinor + shippingMinor + tax.amountTax) throw new Error('TAX_CALCULATION_MISMATCH');
      taxMinor = tax.amountTax;
      taxStatus = 'estimated';
      taxCalculationId = tax.calculationId;
      taxExpiresAt = tax.expiresAt;
    } else if (process.env.NODE_ENV === 'production' && process.env.PRINT_ALLOW_UNAVAILABLE_TAX !== 'true') {
      throw new CookbookPrintError('TAX_NOT_CONFIGURED', 'Retail tax calculation must be configured before production checkout.', 503);
    }
    const createdAt = this.dependencies.now();
    const expiresAt = new Date(Math.min(createdAt.getTime() + 30 * 60_000, taxExpiresAt ? Date.parse(taxExpiresAt) : Number.POSITIVE_INFINITY));
    const money = (amountMinor: number) => ({ amountMinor, currency });
    const quote: CookbookPrintQuote = {
      id: `quote_${randomUUID()}`, draftId, sku: draft.sku, quantity: 1,
      printing: money(printingMinor), shipping: money(shippingMinor), tax: money(taxMinor), discount: money(0), total: money(printingMinor + shippingMinor + taxMinor),
      taxStatus, shippingMethod: result.shippingLevel, provider: 'lulu', providerName: this.dependencies.provider.name,
      productionEstimate: result.productionEstimate, deliveryEstimate: result.deliveryEstimate,
      createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(),
    };
    const stored: StoredQuote = {
      ...quote, ownerUid: uid, snapshotId: draft.render.snapshotId, snapshotHash: draft.render.contentHash,
      addressHash: addressHash(address), address, providerQuoteId: result.providerQuoteId, providerRaw: result.raw, taxCalculationId,
    };
    await this.dependencies.store.saveQuote(stored);
    return quote;
  }

  async checkout(uid: string, draftId: string, input: {
    quoteId?: string; address?: unknown; checkoutKey?: string;
    rightsConfirmed?: boolean; reviewedEveryPage?: boolean; providerConsent?: boolean;
  }): Promise<CookbookPrintCheckoutSession> {
    if (!input.rightsConfirmed || !input.reviewedEveryPage || !input.providerConsent) {
      throw new CookbookPrintError('ACKNOWLEDGEMENTS_REQUIRED', 'Confirm rights, every preview page, and Lulu data transfer before payment.');
    }
    const checkoutKey = typeof input.checkoutKey === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(input.checkoutKey) ? input.checkoutKey : '';
    if (!checkoutKey || !input.quoteId) throw new CookbookPrintError('CHECKOUT_KEY_REQUIRED', 'Checkout is missing its retry key or quote.');
    const address = sanitizePrintAddress(input.address);
    const [draft, quote, account] = await Promise.all([
      this.getDraft(uid, draftId), this.dependencies.store.getQuote(uid, input.quoteId), this.dependencies.account(uid),
    ]);
    if (!quote || quote.draftId !== draftId) throw new CookbookPrintError('QUOTE_NOT_FOUND', 'That price is no longer available.', 404);
    if (!draft.render || draft.render.revision !== draft.revision || draft.render.layoutVersion !== COOKBOOK_PRINT_LAYOUT_VERSION || draft.render.snapshotId !== quote.snapshotId) throw new CookbookPrintError('QUOTE_CHANGED', 'The book changed after it was priced. Preview and price it again.', 409);
    if (addressHash(address) !== quote.addressHash) {
      const replacement = await this.quote(uid, draftId, address);
      throw new CookbookPrintError('QUOTE_CHANGED', 'Shipping details changed, so the price was refreshed.', 409, { quote: replacement });
    }
    if (quoteExpired(quote, this.dependencies.now())) {
      const replacement = await this.quote(uid, draftId, address);
      throw new CookbookPrintError('QUOTE_CHANGED', 'That price expired and has been refreshed.', 409, { quote: replacement });
    }
    const binding = quoteBinding(quote, quote.addressHash, quote.snapshotHash);
    const orderId = `order_${cookbookPrintHash({ uid, checkoutKey }).slice(0, 28)}`;
    const previous = await this.dependencies.store.getOrder(uid, orderId);
    if (previous && (previous.quoteBinding !== binding || previous.checkoutKey !== checkoutKey)) throw new CookbookPrintError('IDEMPOTENCY_CONFLICT', 'This checkout key was already used for a different order.', 409);
    if (previous?.cancellationRequestedAt) {
      // The cancellation fence intentionally blocks every future provider
      // claim. Never present its reusable PaymentIntent again if the Stripe
      // cancellation call was interrupted; the safe recovery is to retry the
      // idempotent cancellation operation or start a fresh checkout key.
      throw new CookbookPrintError('ORDER_CANCELLATION_PENDING', 'Cancellation has already started for this order. Retry cancellation or start a new checkout.', 409, { order: publicOrder(previous) });
    }
    let order = previous;
    if (!order) {
      const promoted = await promotePrintArtifacts({ ownerUid: uid, orderId, snapshotHash: quote.snapshotHash, source: draft.render.artifacts, now: this.dependencies.now() });
      const now = this.dependencies.now().toISOString();
      const created: StoredOrder = {
        id: orderId, ownerUid: uid, checkoutKey, quoteBinding: binding,
        draftId, snapshotId: quote.snapshotId, quoteId: quote.id, title: draft.title, sku: draft.sku, quantity: 1, total: quote.total,
        paymentStatus: 'requires-payment', fulfillmentStatus: 'awaiting-payment', provider: 'lulu', providerName: this.dependencies.provider.name,
        address, contactEmail: account.email || undefined, shippingLevel: quote.shippingMethod, artifacts: promoted,
        ...(quote.taxCalculationId ? { stripeTaxCalculationId: quote.taxCalculationId, stripeTaxStatus: 'pending' as const } : {}),
        acknowledgements: { rightsConfirmedAt: now, reviewedEveryPageAt: now, providerConsentAt: now, policyVersion: COOKBOOK_PRINT_POLICY_VERSION },
        createdAt: now, updatedAt: now,
      };
      order = (await this.dependencies.store.createOrderIfAbsent(created)).order;
      // A concurrent request can win the deterministic order id between the
      // initial read and create. Never return or charge that winner for a
      // request carrying different price/address/snapshot inputs.
      if (order.ownerUid !== uid || order.quoteBinding !== binding || order.checkoutKey !== checkoutKey) {
        throw new CookbookPrintError('IDEMPOTENCY_CONFLICT', 'This checkout key was already used for a different order.', 409);
      }
    }
    const payments = this.dependencies.payments();
    let intent;
    if (order.stripePaymentIntentId) {
      intent = await payments.retrieve(order.stripePaymentIntentId);
      if (intent.status === 'canceled') {
        throw new CookbookPrintError('PAYMENT_CANCELED', 'This checkout was canceled. Start a new checkout to place another order.', 409, { order: publicOrder(order) });
      }
      // A failed card attempt leaves the PaymentIntent reusable. Restore the
      // local state before presenting that same intent again so its next
      // authorization can claim provider submission normally.
      if (order.paymentStatus === 'failed'
        && order.fulfillmentStatus === 'failed'
        && order.lastFailure?.code === 'PAYMENT_FAILED'
        && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) {
        order = await this.dependencies.store.updateOrder(order.id, {
          paymentStatus: 'requires-payment', fulfillmentStatus: 'awaiting-payment', lastFailure: undefined,
        }, { id: `payment-retry-${intent.id}`, type: 'payment.retry_started' });
      }
      if (intent.status === 'requires_capture') {
        if (canTransitionPayment(order.paymentStatus, 'processing')) {
          order = await this.dependencies.store.updateOrder(order.id, { paymentStatus: 'processing' }, { id: `payment-recovered-${intent.id}`, type: 'payment.authorization_recovered' });
        }
        await this.submitAuthorizedOrder(order.id);
        order = await this.dependencies.store.getOrder(uid, order.id) ?? order;
      } else if (intent.status === 'succeeded' && canTransitionPayment(order.paymentStatus, 'paid')) {
        order = await this.dependencies.store.updateOrder(order.id, {
          paymentStatus: 'paid', ...(await this.taxAssociationPatch(order, payments)),
        }, { id: `payment-recovered-succeeded-${intent.id}`, type: 'payment.capture_recovered' });
      } else if (intent.status === 'processing' && canTransitionPayment(order.paymentStatus, 'processing')) {
        order = await this.dependencies.store.updateOrder(order.id, { paymentStatus: 'processing' }, { id: `payment-recovered-processing-${intent.id}`, type: 'payment.processing_recovered' });
      }
    }
    else {
      try {
        intent = await payments.createAuthorization({
          orderId: order.id, amountMinor: order.total.amountMinor, currency: order.total.currency,
          email: order.contactEmail,
          taxCalculationId: order.stripeTaxCalculationId,
          idempotencyKey: `order:${order.id}:payment-intent:v1`,
        });
        order = await this.dependencies.store.updateOrder(order.id, {
          stripePaymentIntentId: intent.id,
          ...(order.paymentStatus === 'failed' ? { paymentStatus: 'requires-payment' as const, lastFailure: undefined } : {}),
        }, { id: 'payment-intent-created', type: 'payment.intent_created' });
      } catch (error) {
        await this.dependencies.store.updateOrder(order.id, { paymentStatus: 'failed', lastFailure: sanitizedFailure(error) }, { id: `payment-intent-failed-${Date.now()}`, type: 'payment.intent_failed' });
        throw error;
      }
    }
    return { order: publicOrder(order), paymentIntentClientSecret: intent.clientSecret, publishableKey: payments.publishableKey, merchantDisplayName: 'Fridgie' };
  }

  async listOrders(uid: string): Promise<CookbookPrintOrder[]> {
    return (await this.dependencies.store.listOrders(uid)).map(publicOrder);
  }

  async getOrder(uid: string, orderId: string): Promise<CookbookPrintOrder> {
    const order = await this.dependencies.store.getOrder(uid, orderId);
    if (!order) throw new CookbookPrintError('NOT_FOUND', 'Order not found.', 404);
    return publicOrder(order);
  }

  async retrySubmission(uid: string, orderId: string): Promise<CookbookPrintOrder> {
    const order = await this.dependencies.store.getOrder(uid, orderId);
    if (!order) throw new CookbookPrintError('NOT_FOUND', 'Order not found.', 404);
    if (order.fulfillmentStatus !== 'submission-unknown' || !order.lastFailure?.retryable) throw new CookbookPrintError('NOT_RETRYABLE', 'This order is not waiting for a print retry.', 409);
    await this.submitAuthorizedOrder(order.id);
    return this.getOrder(uid, orderId);
  }

  async cancelOrder(uid: string, orderId: string): Promise<CookbookPrintOrder> {
    if (!(await this.dependencies.store.getOrder(uid, orderId))) throw new CookbookPrintError('NOT_FOUND', 'Order not found.', 404);
    // Fence provider submission transactionally before releasing or refunding
    // payment. In-flight and ambiguous Lulu submissions are support cases: the
    // public API has no safe cancel mutation and external_id is not idempotent.
    const order = await this.dependencies.store.claimCancellation(uid, orderId, this.dependencies.now());
    if (!order) throw new CookbookPrintError('ORDER_NOT_CANCELABLE', 'This order may already be on its way to the printer. Contact support for a reviewed cancellation.', 409);
    const reversal = order.stripePaymentIntentId
      ? await this.dependencies.payments().cancel(order.stripePaymentIntentId, `order:${order.id}:cancel`)
      : { status: 'canceled' as const };
    const paymentStatus = reversal.status === 'refund-pending' ? 'refund-pending' : 'failed';
    if (!canTransitionPayment(order.paymentStatus, paymentStatus)) throw new CookbookPrintError('PAYMENT_NOT_CANCELABLE', 'This payment can no longer be canceled.', 409);
    const updated = await this.dependencies.store.updateOrder(order.id, {
      paymentStatus, fulfillmentStatus: 'cancelled', ...(reversal.refundId ? { stripeRefundId: reversal.refundId, stripeRefundStatus: 'pending' as const } : {}),
    }, { id: `cancel-${Date.now()}`, type: reversal.status === 'refund-pending' ? 'order.cancelled_refund_pending' : 'order.cancelled' });
    return publicOrder(updated);
  }

  async requestReprint(uid: string, orderId: string): Promise<CookbookPrintOrder> {
    const order = await this.dependencies.store.getOrder(uid, orderId);
    if (!order) throw new CookbookPrintError('NOT_FOUND', 'Order not found.', 404);
    if (!['delivered', 'shipped'].includes(order.fulfillmentStatus) || !order.providerOrderId) throw new CookbookPrintError('REPRINT_NOT_AVAILABLE', 'A replacement can be requested after the original order ships.', 409);
    if (Date.parse(order.artifacts.deleteAfter) <= this.dependencies.now().getTime()) throw new CookbookPrintError('REPRINT_FILES_EXPIRED', 'The original print files are no longer retained. Contact support.', 409);
    const updated = await this.dependencies.store.updateOrder(order.id, { fulfillmentStatus: 'reprint-requested' }, { id: `reprint-${Date.now()}`, type: 'reprint.requested' });
    return publicOrder(updated);
  }

  /** Executes a replacement only after an operator has reviewed the request.
   * The end-user route cannot call this path, because it incurs a new printer
   * charge without a new customer payment. */
  async submitApprovedReprint(orderId: string): Promise<void> {
    const existing = await this.dependencies.store.getOrderById(orderId);
    if (!existing) return;
    // The gate authorizes the first spend. Once the durable order is already
    // `reprinting`, reconciliation may safely resume that approved operation
    // with the same external id without needing the broad service flag.
    if (existing.fulfillmentStatus === 'reprint-requested' && process.env.PRINT_REPRINT_EXECUTION_ENABLED !== 'true') {
      throw new CookbookPrintError('REPRINT_EXECUTION_LOCKED', 'Approved reprint execution is not enabled.', 503);
    }
    if (existing.fulfillmentStatus === 'reprinting' && existing.reprintExternalId && !existing.providerOrderId) {
      const recovered = await this.dependencies.provider.findByExternalId(existing.reprintExternalId);
      if (recovered) {
        const attached = await this.dependencies.store.updateOrder(existing.id, {
          providerOrderId: recovered.providerOrderId, providerStatus: recovered.status,
          reprintLeaseUntil: undefined, lastFailure: undefined,
        }, { id: `reprint-recovered-${recovered.providerOrderId}`, type: 'reprint.recovered' });
        await this.applyProviderStatus(attached, recovered, `reprint-recovered-${recovered.providerOrderId}-${recovered.status}`);
        return;
      }
    }
    const order = await this.dependencies.store.claimReprint(orderId, this.dependencies.now());
    if (!order?.reprintExternalId) return;
    let accepted: { order: StoredOrder; provider: ProviderOrderResult } | undefined;
    try {
      let providerOrder = await this.dependencies.provider.findByExternalId(order.reprintExternalId);
      if (!providerOrder) {
        const signed = await signPrintArtifacts(order.artifacts, 7 * 24 * 60);
        providerOrder = await this.dependencies.provider.submit({
          orderId: order.reprintExternalId,
          contactEmail: order.contactEmail || process.env.PRINT_SUPPORT_EMAIL || 'support@fridgie.ca',
          title: order.title, sku: order.sku, pageCount: order.artifacts.pageCount, quantity: 1,
          address: order.address as CookbookPrintAddress, shippingLevel: order.shippingLevel,
          interiorUrl: signed.interiorUrl, coverUrl: signed.coverUrl,
          interiorMd5: order.artifacts.interiorMd5, coverMd5: order.artifacts.coverMd5,
        });
      }
      const attached = await this.dependencies.store.updateOrder(order.id, {
        providerOrderId: providerOrder.providerOrderId, providerStatus: providerOrder.status,
        reprintLeaseUntil: undefined, lastFailure: undefined,
      }, { id: `reprint-submitted-${order.reprintAttempt}`, type: 'reprint.submitted' });
      accepted = { order: attached, provider: providerOrder };
    } catch (error) {
      const failure = sanitizedFailure(error);
      await this.dependencies.store.updateOrder(order.id, {
        // Reuse this approved attempt and external id after an ambiguous
        // provider failure; minting a new reprint id could create two books.
        fulfillmentStatus: failure.retryable ? 'reprinting' : 'failed',
        reprintLeaseUntil: undefined, lastFailure: failure,
      }, { id: `reprint-failed-${order.reprintAttempt}-${this.dependencies.now().getTime()}`, type: failure.retryable ? 'reprint.submission_unknown' : 'reprint.failed', detail: failure });
      throw error;
    }
    if (accepted) await this.applyProviderStatus(accepted.order, accepted.provider, `reprint-submit-${accepted.provider.providerOrderId}-${accepted.provider.status}`);
  }

  async submitAuthorizedOrder(orderId: string): Promise<void> {
    const existing = await this.dependencies.store.getOrderById(orderId);
    if (!existing) return;
    if (!existing.providerOrderId && ['submitting', 'submission-unknown'].includes(existing.fulfillmentStatus)) {
      const recovered = await this.dependencies.provider.findByExternalId(existing.id);
      if (recovered) {
        const attached = await this.dependencies.store.updateOrder(existing.id, {
          providerOrderId: recovered.providerOrderId, providerStatus: recovered.status,
          fulfillmentStatus: 'submitted', submitLeaseUntil: undefined, lastFailure: undefined,
        }, { id: `provider-recovered-${recovered.providerOrderId}`, type: 'provider.submission_recovered' });
        await this.applyProviderStatus(attached, recovered, `submission-recovered-${recovered.providerOrderId}-${recovered.status}`);
        return;
      }
    }
    const order = await this.dependencies.store.claimSubmission(orderId, this.dependencies.now());
    if (!order) return;
    let accepted: { order: StoredOrder; provider: ProviderOrderResult } | undefined;
    try {
      // external_id is a reference, not an idempotency guarantee. Always
      // reconcile before POSTing, especially after an ambiguous timeout.
      let providerOrder = await this.dependencies.provider.findByExternalId(order.id);
      if (!providerOrder) {
        const signed = await signPrintArtifacts(order.artifacts, 7 * 24 * 60);
        providerOrder = await this.dependencies.provider.submit({
          orderId: order.id, contactEmail: order.contactEmail || process.env.PRINT_SUPPORT_EMAIL || 'support@fridgie.ca',
          title: order.title, sku: order.sku, pageCount: order.artifacts.pageCount, quantity: 1,
          address: order.address as CookbookPrintAddress, shippingLevel: order.shippingLevel,
          interiorUrl: signed.interiorUrl, coverUrl: signed.coverUrl,
          interiorMd5: order.artifacts.interiorMd5, coverMd5: order.artifacts.coverMd5,
        });
      }
      const attached = await this.dependencies.store.updateOrder(order.id, {
        providerOrderId: providerOrder.providerOrderId, providerStatus: providerOrder.status,
        fulfillmentStatus: 'submitted', submitLeaseUntil: undefined, lastFailure: undefined,
      }, { id: `provider-submitted-${providerOrder.providerOrderId}`, type: 'provider.submitted' });
      accepted = { order: attached, provider: providerOrder };
    } catch (error) {
      const failure = sanitizedFailure(error);
      // Any retryable POST failure is ambiguous: a connection reset or 5xx can
      // happen after Lulu persisted the job. Exact-match recovery plus a
      // cooldown precedes every later POST.
      const ambiguous = failure.retryable;
      const failedOrder = await this.dependencies.store.updateOrder(order.id, {
        fulfillmentStatus: ambiguous ? 'submission-unknown' : 'submission-failed', submitLeaseUntil: undefined, lastFailure: failure,
      }, { id: `provider-failed-${order.submitAttempt ?? Date.now()}`, type: ambiguous ? 'provider.submission_unknown' : 'provider.submission_failed', detail: failure });
      if (!failure.retryable) await this.reverseTerminalProviderFailure(failedOrder);
    }
    if (accepted) await this.applyProviderStatus(accepted.order, accepted.provider, `submit-${accepted.provider.providerOrderId}-${accepted.provider.status}`);
  }

  /** Finishes the payment side of a known terminal Lulu rejection. This is a
   * separate idempotent recovery step because the process can die after the
   * durable provider failure but before Stripe or the final Firestore write. */
  private async reverseTerminalProviderFailure(order: StoredOrder): Promise<void> {
    let patch: Partial<StoredOrder> = { fulfillmentStatus: 'failed' };
    let eventType = 'payment.reversed_after_provider_rejection';
    if (order.stripePaymentIntentId && !['failed', 'refund-pending', 'refunded'].includes(order.paymentStatus)) {
      const reversal = await this.dependencies.payments().cancel(order.stripePaymentIntentId, `order:${order.id}:provider-rejected`);
      const paymentStatus = reversal.status === 'refund-pending' ? 'refund-pending' : 'failed';
      patch = {
        ...patch, paymentStatus,
        ...(reversal.refundId ? { stripeRefundId: reversal.refundId, stripeRefundStatus: 'pending' as const } : {}),
      };
      if (reversal.status === 'refund-pending') eventType = 'payment.refund_pending_after_provider_rejection';
    }
    await this.dependencies.store.updateOrder(order.id, patch, {
      id: 'provider-rejected-payment-reversed', type: eventType,
    });
  }

  private async taxAssociationPatch(order: StoredOrder, payments: PaymentGateway): Promise<Partial<StoredOrder>> {
    if (!order.stripeTaxCalculationId || !order.stripePaymentIntentId || order.stripeTaxStatus === 'committed') return {};
    try {
      const association = await payments.findTaxAssociation(order.stripePaymentIntentId);
      if (association.calculationId !== order.stripeTaxCalculationId) {
        return { stripeTaxStatus: 'failed', stripeTaxError: 'calculation_mismatch' };
      }
      if (association.transactionId) {
        return { stripeTaxStatus: 'committed', stripeTaxTransactionId: association.transactionId, stripeTaxError: undefined };
      }
      if (association.errorCode) {
        return { stripeTaxStatus: 'failed', stripeTaxError: association.errorCode.slice(0, 120) };
      }
      return { stripeTaxStatus: 'pending', stripeTaxError: undefined };
    } catch (error: any) {
      // Payment capture is authoritative. A transient association lookup must
      // not leave a successfully captured order in a state that could trigger
      // a second capture; reconciliation retries this private audit field.
      const code = typeof error?.code === 'string' ? error.code : 'association_lookup_unavailable';
      return { stripeTaxStatus: 'pending', stripeTaxError: code.slice(0, 120) };
    }
  }

  async handleStripeWebhook(rawBody: string, signature: string): Promise<void> {
    const payments = this.dependencies.payments();
    const event = await payments.verifyWebhook(rawBody, signature);
    const payloadHash = cookbookPrintHash(rawBody);
    if (await this.dependencies.store.webhookProcessed('stripe', event.id)) return;
    const object = event.data.object as Stripe.PaymentIntent | Stripe.Charge | Stripe.Refund;
    const intentId = object.object === 'payment_intent' ? object.id : typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
    if (intentId) {
      const metadataOrderId = object.object === 'payment_intent' ? object.metadata?.order_id : undefined;
      const order = metadataOrderId ? await this.dependencies.store.getOrderById(metadataOrderId) : await this.dependencies.store.findOrderByPaymentIntent(intentId);
      if (order && order.stripePaymentIntentId === intentId) {
        if (event.type === 'payment_intent.amount_capturable_updated') {
          if (canTransitionPayment(order.paymentStatus, 'processing')) {
            if ((await payments.retrieve(intentId)).status === 'requires_capture') {
              // Commit the authorization and provider-work queue atomically,
              // then acknowledge Stripe. The scheduled worker owns all Lulu I/O.
              await this.dependencies.store.queueAuthorizedSubmission(order.id, event.id, this.dependencies.now());
            }
          }
        } else if (event.type === 'payment_intent.succeeded') {
          // Only refund.failed may reopen a refunded payment. A delayed
          // original succeeded event must never undo a later refund.
          if (['requires-payment', 'processing', 'paid'].includes(order.paymentStatus)
            && (await payments.retrieve(intentId)).status === 'succeeded') {
            await this.dependencies.store.updateOrder(order.id, {
              paymentStatus: 'paid', ...(await this.taxAssociationPatch(order, payments)),
            }, { id: `stripe-${event.id}`, type: 'payment.captured' });
          }
        } else if (event.type === 'payment_intent.payment_failed') {
          // Webhooks can arrive out of order after the same reusable intent has
          // already been authorized. Trust its current Stripe status, not the
          // historical event payload, before failing a live provider workflow.
          if (canTransitionPayment(order.paymentStatus, 'failed')
            && (await payments.retrieve(intentId)).status === 'requires_payment_method') {
            const providerMayExist = !!order.providerOrderId || !!order.submitAttempt || !!order.reprintAttempt
              || ['submitting', 'submission-unknown', 'submitted', 'in-production', 'shipped', 'delivered', 'reprinting'].includes(order.fulfillmentStatus);
            const fulfillmentStatus = !providerMayExist && canTransitionFulfillment(order.fulfillmentStatus, 'failed') ? 'failed' : order.fulfillmentStatus;
            const lastFailure = providerMayExist
              ? { code: 'PAYMENT_FAILED_AFTER_SUBMISSION', message: 'Payment failed after the print workflow may have started. Support must review this order while provider tracking continues.', retryable: true }
              : { code: 'PAYMENT_FAILED', message: 'Payment was not authorized. Try again with another payment method.', retryable: true };
            await this.dependencies.store.updateOrder(order.id, { paymentStatus: 'failed', fulfillmentStatus, lastFailure }, { id: `stripe-${event.id}`, type: 'payment.failed' });
          }
        } else if (event.type === 'payment_intent.canceled') {
          if (canTransitionPayment(order.paymentStatus, 'failed')
            && (await payments.retrieve(intentId)).status === 'canceled') {
            const providerMayExist = !!order.providerOrderId || !!order.submitAttempt || !!order.reprintAttempt
              || ['submitting', 'submission-unknown', 'submitted', 'in-production', 'shipped', 'delivered', 'reprinting'].includes(order.fulfillmentStatus);
            const fulfillmentStatus = !providerMayExist && canTransitionFulfillment(order.fulfillmentStatus, 'cancelled') ? 'cancelled' : order.fulfillmentStatus;
            await this.dependencies.store.updateOrder(order.id, {
              paymentStatus: 'failed', fulfillmentStatus,
              ...(providerMayExist ? { lastFailure: { code: 'PAYMENT_CANCELED_AFTER_SUBMISSION', message: 'Payment was canceled after the print workflow may have started. Support must review this order while provider tracking continues.', retryable: true } } : {}),
            }, { id: `stripe-${event.id}`, type: 'payment.cancelled' });
          }
        } else if (event.type === 'charge.refunded') {
          if (order.stripeRefundStatus !== 'failed' && canTransitionPayment(order.paymentStatus, 'refunded') && (object as Stripe.Charge).refunded === true) {
            await this.dependencies.store.updateOrder(order.id, { paymentStatus: 'refunded', stripeRefundStatus: 'succeeded' }, { id: `stripe-${event.id}`, type: 'payment.refunded' });
          }
        } else if (event.type === 'refund.failed') {
          if (canTransitionPayment(order.paymentStatus, 'paid')) {
            await this.dependencies.store.updateOrder(order.id, {
              paymentStatus: 'paid',
              stripeRefundId: (object as Stripe.Refund).id,
              stripeRefundStatus: 'failed',
              lastFailure: { code: 'REFUND_FAILED', message: 'The refund could not be completed. Contact support for help.', retryable: true },
            }, { id: `stripe-${event.id}`, type: 'payment.refund_failed' });
          }
        }
      }
    }
    // Mark only after durable local effects complete. If the process dies
    // first, Stripe's retry safely replays the idempotent transition.
    await this.dependencies.store.markWebhookOnce('stripe', event.id, payloadHash, this.dependencies.now());
  }

  async handleLuluWebhook(rawBody: string, signature: string | null): Promise<void> {
    if (!this.dependencies.provider.verifyWebhook(rawBody, signature)) throw new CookbookPrintError('INVALID_SIGNATURE', 'Invalid Lulu webhook signature.', 400);
    const payloadHash = cookbookPrintHash(rawBody);
    const eventId = payloadHash.slice(0, 48);
    if (await this.dependencies.store.webhookProcessed('lulu', eventId)) return;
    const envelope = JSON.parse(rawBody) as any;
    const payload = envelope?.data ?? envelope;
    const providerId = payload?.id ?? payload?.print_job_id ?? payload?.print_job?.id;
    const externalId = payload?.external_id ?? payload?.print_job?.external_id;
    let order = externalId ? await this.dependencies.store.getOrderById(String(externalId)) : null;
    if (!order && externalId) order = await this.dependencies.store.findOrderByReprintExternalId(String(externalId));
    if (!order && providerId !== undefined) order = await this.dependencies.store.findOrderByProviderId(String(providerId));
    if (order) {
      const activeExternalId = order.reprintExternalId ?? order.id;
      const incomingExternalId = externalId === undefined ? undefined : String(externalId);
      const incomingProviderId = providerId === undefined ? undefined : String(providerId);
      const isPriorProvider = !!incomingProviderId && (order.priorProviderOrderIds ?? []).includes(incomingProviderId);
      let verified: ProviderOrderResult | null = null;
      // A delayed original-job webhook must never take over an active reprint.
      // Require the webhook identity to agree with the active external id, and
      // never reattach a provider id already archived in reprint history.
      if ((incomingExternalId === undefined || incomingExternalId === activeExternalId) && !isPriorProvider && order.providerOrderId) {
        verified = await this.dependencies.provider.getOrder(order.providerOrderId);
      } else if ((incomingExternalId === undefined || incomingExternalId === activeExternalId) && !isPriorProvider) {
        // A timeout can leave Lulu holding a job while Fridgie has no provider
        // id. Recover it by exact external id before considering any retry.
        verified = await this.dependencies.provider.findByExternalId(activeExternalId);
        if (!verified && incomingProviderId) {
          const candidate = await this.dependencies.provider.getOrder(incomingProviderId);
          if (candidate.externalId === activeExternalId) verified = candidate;
        }
      }
      if (verified) await this.applyProviderStatus(order, verified, eventId);
    }
    await this.dependencies.store.markWebhookOnce('lulu', eventId, payloadHash, this.dependencies.now());
  }

  async reconcileOrder(orderId: string): Promise<void> {
    const order = await this.dependencies.store.getOrderById(orderId);
    if (!order) return;
    if (order.fulfillmentStatus === 'submission-failed') {
      await this.reverseTerminalProviderFailure(order);
      return;
    }
    if (order.providerOrderId) {
      await this.applyProviderStatus(order, await this.dependencies.provider.getOrder(order.providerOrderId), `reconcile-${Date.now()}`);
      return;
    }
    if (order.fulfillmentStatus === 'reprinting') {
      await this.submitApprovedReprint(order.id);
      return;
    }
    if (['submitting', 'submission-unknown'].includes(order.fulfillmentStatus)) {
      await this.submitAuthorizedOrder(order.id);
    }
  }

  private async applyProviderStatus(order: StoredOrder, provider: ProviderOrderResult, eventId: string): Promise<void> {
    const status = provider.status.toUpperCase();
    const patch: Partial<StoredOrder> = { providerOrderId: provider.providerOrderId, providerStatus: status };
    let desiredFulfillment: StoredOrder['fulfillmentStatus'] | undefined;
    if (['CREATED', 'UNPAID', 'PAYMENT_IN_PROGRESS', 'PRODUCTION_DELAYED', 'PRODUCTION_READY'].includes(status)) desiredFulfillment = 'submitted';
    else if (status === 'IN_PRODUCTION') desiredFulfillment = 'in-production';
    else if (status === 'SHIPPED') { desiredFulfillment = 'shipped'; patch.tracking = provider.tracking; }
    else if (status === 'DELIVERED') { desiredFulfillment = 'delivered'; patch.tracking = provider.tracking; }
    else if (status === 'CANCELED') desiredFulfillment = 'cancelled';
    else if (['REJECTED', 'ERROR'].includes(status)) {
      desiredFulfillment = 'failed';
      patch.lastFailure = { code: `LULU_${status}`, message: 'Lulu could not produce this order. The payment will be released or refunded.', retryable: status === 'ERROR' };
    }
    const fulfillmentChanged = !!desiredFulfillment && canTransitionFulfillment(order.fulfillmentStatus, desiredFulfillment);
    if (fulfillmentChanged) patch.fulfillmentStatus = desiredFulfillment;
    const accepted = ['PRODUCTION_DELAYED', 'PRODUCTION_READY', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'].includes(status);
    const isReplacement = !!order.reprintExternalId && !!order.reprintAttempt;
    if (accepted && order.paymentStatus !== 'paid' && !['cancelled', 'failed'].includes(order.fulfillmentStatus) && order.stripePaymentIntentId && canTransitionPayment(order.paymentStatus, 'paid')) {
      const payments = this.dependencies.payments();
      const captureStatus = await payments.capture(order.stripePaymentIntentId, `order:${order.id}:capture:v1`);
      if (captureStatus === 'succeeded') {
        patch.paymentStatus = 'paid';
        Object.assign(patch, await this.taxAssociationPatch(order, payments));
      } else if (captureStatus !== 'processing') {
        throw Object.assign(new Error(`Stripe capture did not complete (${captureStatus}).`), { code: 'PAYMENT_CAPTURE_INCOMPLETE', retryable: true });
      }
    }
    if (order.paymentStatus === 'paid' && order.stripeTaxCalculationId && order.stripeTaxStatus !== 'committed') {
      Object.assign(patch, await this.taxAssociationPatch(order, this.dependencies.payments()));
    }
    if (!isReplacement && fulfillmentChanged && ['REJECTED', 'ERROR', 'CANCELED'].includes(status) && order.stripePaymentIntentId && !['refund-pending', 'refunded', 'failed'].includes(order.paymentStatus)) {
      const reversal = await this.dependencies.payments().cancel(order.stripePaymentIntentId, `order:${order.id}:provider-${status.toLowerCase()}`);
      const paymentStatus = reversal.status === 'refund-pending' ? 'refund-pending' : 'failed';
      if (canTransitionPayment(order.paymentStatus, paymentStatus)) patch.paymentStatus = paymentStatus;
      if (reversal.refundId) {
        patch.stripeRefundId = reversal.refundId;
        patch.stripeRefundStatus = 'pending';
      }
    }
    await this.dependencies.store.updateOrder(order.id, patch, { id: `lulu-${eventId}`, type: `provider.${status.toLowerCase()}`, detail: { status, lineItemStatus: provider.lineItemStatus } });
  }
}
