import { FieldValue } from 'firebase-admin/firestore';
import type { CookbookPrintDraft, CookbookPrintDraftInput, CookbookPrintOrder, CookbookPrintQuote } from '@fridgie/shared/types';
import { fs } from './firebase';
import type { CookbookPrintSnapshot } from './cookbookPrint';
import { canTransitionFulfillment, canTransitionPayment } from './cookbookPrint';
import type { StoredPrintArtifacts } from './cookbookPrintStorage';

const DRAFTS = 'cookbookPrintDrafts';
const SNAPSHOTS = 'cookbookPrintSnapshots';
const QUOTES = 'cookbookPrintQuotes';
const ORDERS = 'cookbookPrintOrders';
const WEBHOOKS = 'cookbookPrintWebhookEvents';

export interface StoredDraft extends CookbookPrintDraft {
  ownerUid: string;
  render?: {
    revision: number;
    layoutVersion: string;
    snapshotId: string;
    contentHash: string;
    artifacts: StoredPrintArtifacts;
    issues: unknown[];
    spineWidthInches: number;
    pages: Array<{ pageNumber: number; kind: string; label: string; recipeId?: string; section?: string }>;
    createdAt: string;
  };
}

export interface StoredSnapshotMetadata extends Omit<CookbookPrintSnapshot, 'recipes'> {
  recipeCount: number;
  artifacts?: StoredPrintArtifacts;
  ready?: boolean;
}

export interface StoredQuote extends CookbookPrintQuote {
  ownerUid: string;
  snapshotId: string;
  snapshotHash: string;
  addressHash: string;
  address: unknown;
  providerQuoteId?: string;
  providerRaw?: unknown;
  taxCalculationId?: string;
}

export interface StoredOrder extends CookbookPrintOrder {
  ownerUid: string;
  checkoutKey: string;
  quoteBinding: string;
  address: unknown;
  contactEmail?: string;
  shippingLevel: string;
  stripePaymentIntentId?: string;
  stripeRefundId?: string;
  stripeRefundStatus?: 'pending' | 'succeeded' | 'failed';
  stripeTaxCalculationId?: string;
  stripeTaxTransactionId?: string;
  stripeTaxStatus?: 'pending' | 'committed' | 'failed';
  stripeTaxError?: string;
  providerOrderId?: string;
  cancellationRequestedAt?: string;
  artifacts: StoredPrintArtifacts;
  acknowledgements: {
    rightsConfirmedAt: string;
    reviewedEveryPageAt: string;
    providerConsentAt: string;
    policyVersion: number;
  };
  submitAttempt?: number;
  submitLeaseUntil?: string;
  reprintAttempt?: number;
  reprintExternalId?: string;
  reprintLeaseUntil?: string;
  priorProviderOrderIds?: string[];
  lastReconciledAt?: string;
}

function plain<T>(snapshot: { id: string; data(): any }): T {
  return { id: snapshot.id, ...snapshot.data() } as T;
}

const RECONCILIATION_PRIORITY: Record<string, number> = {
  submitting: 0,
  'submission-unknown': 1,
  'submission-failed': 2,
  reprinting: 3,
  submitted: 4,
  'in-production': 5,
  shipped: 6,
};

export function selectOrdersForReconciliation(orders: StoredOrder[], limit: number): StoredOrder[] {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 100));
  const time = (value?: string) => {
    const parsed = value ? Date.parse(value) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...orders].sort((a, b) =>
    (RECONCILIATION_PRIORITY[a.fulfillmentStatus] ?? 99) - (RECONCILIATION_PRIORITY[b.fulfillmentStatus] ?? 99)
    || time(a.lastReconciledAt) - time(b.lastReconciledAt)
    || time(a.updatedAt) - time(b.updatedAt)
    || a.id.localeCompare(b.id)).slice(0, cap);
}

export class CookbookPrintStore {
  async getDraft(ownerUid: string, draftId = ownerUid): Promise<StoredDraft | null> {
    const snapshot = await fs.collection(DRAFTS).doc(draftId).get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) return null;
    return plain<StoredDraft>(snapshot);
  }

  async createDraft(ownerUid: string, input: CookbookPrintDraftInput, now = new Date()): Promise<StoredDraft> {
    const id = ownerUid;
    const reference = fs.collection(DRAFTS).doc(id);
    const timestamp = now.toISOString();
    const result = await fs.runTransaction(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists && existing.data()?.ownerUid === ownerUid) return plain<StoredDraft>(existing);
      const draft: StoredDraft = { id, ownerUid, ...input, revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp };
      const { id: _id, ...stored } = draft;
      transaction.create(reference, stored);
      return draft;
    });
    return result;
  }

  async updateDraft(ownerUid: string, draftId: string, expectedRevision: number, input: CookbookPrintDraftInput, now = new Date()): Promise<StoredDraft> {
    const reference = fs.collection(DRAFTS).doc(draftId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) throw Object.assign(new Error('Draft not found.'), { status: 404, code: 'NOT_FOUND' });
      const current = plain<StoredDraft>(snapshot);
      if (current.revision !== expectedRevision) throw Object.assign(new Error('This draft changed on another device.'), { status: 409, code: 'REVISION_CONFLICT', draft: current });
      const draft: StoredDraft = {
        ...current,
        ...input,
        id: draftId,
        ownerUid,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        render: undefined,
      };
      // Replacing the document already removes the stale render. Do not use a
      // delete sentinel in a non-merge set: Firestore rejects that combination
      // at runtime even though its TypeScript surface accepts it.
      const { id: _id, render: _render, ...stored } = draft;
      transaction.set(reference, stored);
      return draft;
    });
  }

  async saveDraftRender(ownerUid: string, draftId: string, render: NonNullable<StoredDraft['render']>): Promise<void> {
    const reference = fs.collection(DRAFTS).doc(draftId);
    await fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) throw Object.assign(new Error('Draft not found.'), { status: 404 });
      if (snapshot.data()?.revision !== render.revision) throw Object.assign(new Error('Draft changed while preview was rendering.'), { status: 409, code: 'REVISION_CONFLICT' });
      transaction.update(reference, { render, lastPreviewRevision: render.revision });
    });
  }

  async saveSnapshot(snapshot: CookbookPrintSnapshot, artifacts?: StoredPrintArtifacts): Promise<void> {
    const { recipes, ...metadata } = snapshot;
    const reference = fs.collection(SNAPSHOTS).doc(snapshot.id);
    const { id: _id, ...storedMetadata } = metadata;
    const ready = await fs.runTransaction(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists) {
        if (existing.data()?.ownerUid !== snapshot.ownerUid || existing.data()?.contentHash !== snapshot.contentHash) throw new Error('SNAPSHOT_ID_COLLISION');
        return existing.data()?.ready === true;
      }
      transaction.create(reference, { ...storedMetadata, recipeCount: recipes.length, ready: false, ...(artifacts ? { artifacts } : {}) });
      return false;
    });
    if (ready) return;
    for (let start = 0; start < recipes.length; start += 400) {
      const batch = fs.batch();
      recipes.slice(start, start + 400).forEach((recipe, index) => {
        batch.set(reference.collection('recipes').doc(String(start + index).padStart(4, '0')), recipe);
      });
      await batch.commit();
    }
    await reference.update({ ready: true, recipeCount: recipes.length, ...(artifacts ? { artifacts } : {}) });
  }

  async getSnapshot(ownerUid: string, snapshotId: string): Promise<{ metadata: StoredSnapshotMetadata; recipes: CookbookPrintSnapshot['recipes'] } | null> {
    const reference = fs.collection(SNAPSHOTS).doc(snapshotId);
    const snapshot = await reference.get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid || snapshot.data()?.ready !== true) return null;
    const recipeSnapshot = await reference.collection('recipes').orderBy('position').get();
    return { metadata: plain<StoredSnapshotMetadata>(snapshot), recipes: recipeSnapshot.docs.map(doc => doc.data() as CookbookPrintSnapshot['recipes'][number]) };
  }

  async saveQuote(quote: StoredQuote): Promise<void> {
    const { id: _id, ...stored } = quote;
    await fs.collection(QUOTES).doc(quote.id).create({ ...stored, expireAt: new Date(quote.expiresAt) });
  }

  async getQuote(ownerUid: string, quoteId: string): Promise<StoredQuote | null> {
    const snapshot = await fs.collection(QUOTES).doc(quoteId).get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) return null;
    return plain<StoredQuote>(snapshot);
  }

  async createOrderIfAbsent(order: StoredOrder): Promise<{ order: StoredOrder; created: boolean }> {
    const reference = fs.collection(ORDERS).doc(order.id);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const current = plain<StoredOrder>(snapshot);
        if (current.ownerUid !== order.ownerUid || current.checkoutKey !== order.checkoutKey || current.quoteBinding !== order.quoteBinding) {
          throw Object.assign(new Error('This checkout key was already used for a different order.'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
        }
        return { order: current, created: false };
      }
      const { id: _id, ...stored } = order;
      transaction.create(reference, stored);
      transaction.create(reference.collection('events').doc('created'), {
        type: 'order.created', at: order.createdAt, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus,
      });
      return { order, created: true };
    });
  }

  async getOrder(ownerUid: string, orderId: string): Promise<StoredOrder | null> {
    const snapshot = await fs.collection(ORDERS).doc(orderId).get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) return null;
    return plain<StoredOrder>(snapshot);
  }

  async getOrderById(orderId: string): Promise<StoredOrder | null> {
    const snapshot = await fs.collection(ORDERS).doc(orderId).get();
    return snapshot.exists ? plain<StoredOrder>(snapshot) : null;
  }

  async findOrderByPaymentIntent(intentId: string): Promise<StoredOrder | null> {
    const snapshot = await fs.collection(ORDERS).where('stripePaymentIntentId', '==', intentId).limit(1).get();
    return snapshot.empty ? null : plain<StoredOrder>(snapshot.docs[0]!);
  }

  async findOrderByProviderId(providerOrderId: string): Promise<StoredOrder | null> {
    const snapshot = await fs.collection(ORDERS).where('providerOrderId', '==', providerOrderId).limit(1).get();
    return snapshot.empty ? null : plain<StoredOrder>(snapshot.docs[0]!);
  }

  async findOrderByReprintExternalId(externalId: string): Promise<StoredOrder | null> {
    const snapshot = await fs.collection(ORDERS).where('reprintExternalId', '==', externalId).limit(1).get();
    return snapshot.empty ? null : plain<StoredOrder>(snapshot.docs[0]!);
  }

  async listOrders(ownerUid: string): Promise<StoredOrder[]> {
    const snapshot = await fs.collection(ORDERS).where('ownerUid', '==', ownerUid).limit(100).get();
    return snapshot.docs.map(doc => plain<StoredOrder>(doc)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listOrdersForReconciliation(limit = 100): Promise<StoredOrder[]> {
    const snapshot = await fs.collection(ORDERS).where('fulfillmentStatus', 'in', [
      'submitting', 'submission-unknown', 'submission-failed', 'submitted', 'in-production', 'shipped', 'reprinting',
    ]).get();
    // Read the complete eligible set, then use a persisted per-order cursor.
    // This avoids an unordered fixed Firestore page permanently hiding newer
    // authorizations behind long-lived production or shipped orders.
    return selectOrdersForReconciliation(snapshot.docs.map(doc => plain<StoredOrder>(doc)), limit);
  }

  async markReconciled(orderId: string, now = new Date()): Promise<void> {
    await fs.collection(ORDERS).doc(orderId).update({ lastReconciledAt: now.toISOString() });
  }

  async updateOrder(orderId: string, patch: Partial<StoredOrder>, event: { id: string; type: string; at?: string; detail?: unknown }): Promise<StoredOrder> {
    const reference = fs.collection(ORDERS).doc(orderId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw Object.assign(new Error('Order not found.'), { status: 404 });
      const current = plain<StoredOrder>(snapshot);
      if (patch.paymentStatus && !canTransitionPayment(current.paymentStatus, patch.paymentStatus)) {
        throw Object.assign(new Error(`Invalid payment transition ${current.paymentStatus} -> ${patch.paymentStatus}.`), { code: 'INVALID_PAYMENT_TRANSITION' });
      }
      if (patch.fulfillmentStatus && !canTransitionFulfillment(current.fulfillmentStatus, patch.fulfillmentStatus)) {
        throw Object.assign(new Error(`Invalid fulfillment transition ${current.fulfillmentStatus} -> ${patch.fulfillmentStatus}.`), { code: 'INVALID_FULFILLMENT_TRANSITION' });
      }
      const updatedAt = event.at ?? new Date().toISOString();
      const firestorePatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? FieldValue.delete() : value]));
      transaction.update(reference, { ...firestorePatch, updatedAt });
      transaction.set(reference.collection('events').doc(event.id), { type: event.type, at: updatedAt, ...(event.detail === undefined ? {} : { detail: event.detail }) }, { merge: false });
      return { ...current, ...patch, updatedAt };
    });
  }

  /** Durably hands an authorized payment to the reconciliation worker without
   * holding Stripe's webhook request open during provider network I/O. The
   * cancellation fence and queue transition are checked in one transaction. */
  async queueAuthorizedSubmission(orderId: string, eventId: string, now = new Date()): Promise<StoredOrder | null> {
    const reference = fs.collection(ORDERS).doc(orderId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const order = plain<StoredOrder>(snapshot);
      if (order.cancellationRequestedAt || order.providerOrderId) return null;
      if (order.paymentStatus === 'processing' && order.fulfillmentStatus === 'submitting') return order;
      if (!['requires-payment', 'processing'].includes(order.paymentStatus)
        || !['awaiting-payment', 'submitting'].includes(order.fulfillmentStatus)) return null;
      const updatedAt = now.toISOString();
      transaction.update(reference, {
        paymentStatus: 'processing', fulfillmentStatus: 'submitting',
        submitLeaseUntil: FieldValue.delete(), updatedAt,
      });
      transaction.set(reference.collection('events').doc(`stripe-${eventId}`), {
        type: 'payment.authorized_submission_queued', at: updatedAt,
      }, { merge: false });
      return {
        ...order, paymentStatus: 'processing', fulfillmentStatus: 'submitting',
        submitLeaseUntil: undefined, updatedAt,
      };
    });
  }

  async claimSubmission(orderId: string, now = new Date()): Promise<StoredOrder | null> {
    const reference = fs.collection(ORDERS).doc(orderId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const order = plain<StoredOrder>(snapshot);
      const leaseUntil = order.submitLeaseUntil ? Date.parse(order.submitLeaseUntil) : 0;
      if (leaseUntil > now.getTime() || order.providerOrderId || order.cancellationRequestedAt) return null;
      if (!['processing', 'paid'].includes(order.paymentStatus)) return null;
      if (order.fulfillmentStatus === 'submitting' && order.submitLeaseUntil) {
        // The worker vanished after taking its lease. Treat the old POST as
        // ambiguous and wait through the same recovery window used for a
        // network timeout before another POST can ever be attempted.
        const updatedAt = now.toISOString();
        transaction.update(reference, { fulfillmentStatus: 'submission-unknown', submitLeaseUntil: FieldValue.delete(), updatedAt });
        transaction.create(reference.collection('events').doc(`submit-lease-expired-${order.submitAttempt ?? 0}`), {
          type: 'provider.submission_unknown', at: updatedAt, reason: 'lease_expired',
        });
        return null;
      }
      if (!['submitting', 'submission-unknown', 'awaiting-payment'].includes(order.fulfillmentStatus)) return null;
      const ambiguousRetryMs = Math.max(1, Number(process.env.PRINT_AMBIGUOUS_RETRY_MINUTES || 15)) * 60_000;
      if (order.fulfillmentStatus === 'submission-unknown' && Date.parse(order.updatedAt) + ambiguousRetryMs > now.getTime()) return null;
      const submitLeaseUntil = new Date(now.getTime() + 90_000).toISOString();
      const submitAttempt = (order.submitAttempt ?? 0) + 1;
      transaction.update(reference, { fulfillmentStatus: 'submitting', submitLeaseUntil, submitAttempt, updatedAt: now.toISOString() });
      transaction.create(reference.collection('events').doc(`submit-${submitAttempt}`), { type: 'provider.submission_started', at: now.toISOString(), submitAttempt });
      return { ...order, fulfillmentStatus: 'submitting', submitLeaseUntil, submitAttempt, updatedAt: now.toISOString() };
    });
  }

  /** Atomically fences provider submission before touching Stripe. Once this
   * marker exists, claimSubmission can never start a print job for the order. */
  async claimCancellation(ownerUid: string, orderId: string, now = new Date()): Promise<StoredOrder | null> {
    const reference = fs.collection(ORDERS).doc(orderId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.data()?.ownerUid !== ownerUid) return null;
      const order = plain<StoredOrder>(snapshot);
      if (order.providerOrderId || order.fulfillmentStatus !== 'awaiting-payment') return null;
      if (order.cancellationRequestedAt) return order;
      const cancellationRequestedAt = now.toISOString();
      transaction.update(reference, { cancellationRequestedAt, updatedAt: cancellationRequestedAt });
      transaction.create(reference.collection('events').doc('cancellation-requested'), {
        type: 'order.cancellation_requested', at: cancellationRequestedAt,
      });
      return { ...order, cancellationRequestedAt, updatedAt: cancellationRequestedAt };
    });
  }

  /** Claims an operator-approved replacement without ever mutating the frozen
   * snapshot or purchased PDFs. The prior Lulu id stays in audit history while
   * reconciliation follows the replacement job after it is accepted. */
  async claimReprint(orderId: string, now = new Date()): Promise<StoredOrder | null> {
    const reference = fs.collection(ORDERS).doc(orderId);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const order = plain<StoredOrder>(snapshot);
      const leaseUntil = order.reprintLeaseUntil ? Date.parse(order.reprintLeaseUntil) : 0;
      if (leaseUntil > now.getTime() || order.providerOrderId) return null;
      if (order.fulfillmentStatus === 'reprinting') {
        if (!order.reprintExternalId || !order.reprintAttempt) return null;
        const ambiguousRetryMs = Math.max(1, Number(process.env.PRINT_AMBIGUOUS_RETRY_MINUTES || 15)) * 60_000;
        if (Date.parse(order.updatedAt) + ambiguousRetryMs > now.getTime()) return null;
        const reprintLeaseUntil = new Date(now.getTime() + 90_000).toISOString();
        transaction.update(reference, { reprintLeaseUntil, updatedAt: now.toISOString() });
        transaction.create(reference.collection('events').doc(`reprint-resume-${order.reprintAttempt}-${now.getTime()}`), {
          type: 'reprint.submission_resumed', at: now.toISOString(), reprintAttempt: order.reprintAttempt, reprintExternalId: order.reprintExternalId,
        });
        return { ...order, reprintLeaseUntil, updatedAt: now.toISOString() };
      }
      if (order.fulfillmentStatus !== 'reprint-requested') return null;
      const reprintAttempt = (order.reprintAttempt ?? 0) + 1;
      const reprintExternalId = `${order.id}-reprint-${reprintAttempt}`;
      const reprintLeaseUntil = new Date(now.getTime() + 90_000).toISOString();
      const priorProviderOrderIds = order.providerOrderId
        ? [...new Set([...(order.priorProviderOrderIds ?? []), order.providerOrderId])]
        : order.priorProviderOrderIds ?? [];
      transaction.update(reference, {
        fulfillmentStatus: 'reprinting', reprintAttempt, reprintExternalId, reprintLeaseUntil,
        priorProviderOrderIds, providerOrderId: FieldValue.delete(), providerStatus: FieldValue.delete(),
        tracking: FieldValue.delete(), updatedAt: now.toISOString(),
      });
      transaction.create(reference.collection('events').doc(`reprint-submit-${reprintAttempt}`), {
        type: 'reprint.submission_started', at: now.toISOString(), reprintAttempt, reprintExternalId,
      });
      return {
        ...order, fulfillmentStatus: 'reprinting', reprintAttempt, reprintExternalId,
        reprintLeaseUntil, priorProviderOrderIds, providerOrderId: undefined,
        providerStatus: undefined, tracking: undefined, updatedAt: now.toISOString(),
      };
    });
  }

  async markWebhookOnce(provider: 'stripe' | 'lulu', eventId: string, payloadHash: string, now = new Date()): Promise<boolean> {
    const reference = fs.collection(WEBHOOKS).doc(`${provider}:${eventId}`);
    return fs.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) return false;
      transaction.create(reference, { provider, eventId, payloadHash, processedAt: now.toISOString(), expireAt: new Date(now.getTime() + 30 * 86_400_000) });
      return true;
    });
  }

  async webhookProcessed(provider: 'stripe' | 'lulu', eventId: string): Promise<boolean> {
    return (await fs.collection(WEBHOOKS).doc(`${provider}:${eventId}`).get()).exists;
  }

  async releaseWebhook(provider: 'stripe' | 'lulu', eventId: string): Promise<void> {
    await fs.collection(WEBHOOKS).doc(`${provider}:${eventId}`).delete();
  }
}
