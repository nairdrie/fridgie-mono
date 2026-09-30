export interface AiUsage {
  used: number;
  limit: number;
  remaining: number;
  windowStartsAt: string;
  windowEndsAt: string;
}

export interface AccountStatus {
  plan: 'free' | 'pro';
  isPro: boolean;
  entitlement: {
    status: 'active' | 'inactive' | 'unavailable';
    provider: 'revenuecat' | 'none';
    expiresAt: string | null;
    verifiedAt: string | null;
    productIdentifier: string | null;
  };
  aiUsage: AiUsage;
  leftoversScanUsage: AiUsage | null;
}

/** Return a server snapshot only to the Firebase account it was fetched for. */
export function accountStatusForUid(
  accountUid: string | null,
  ownerUid: string | null,
  status: AccountStatus | null,
): AccountStatus | null {
  return accountUid !== null && ownerUid === accountUid ? status : null;
}

/** Runtime boundary for quota snapshots arriving in response headers/errors. */
export function aiUsageFromUnknown(value: unknown): AiUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AiUsage>;
  const numeric = [candidate.used, candidate.limit, candidate.remaining];
  if (numeric.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
    return null;
  }
  if (
    !Number.isInteger(candidate.used)
    || !Number.isInteger(candidate.limit)
    || !Number.isInteger(candidate.remaining)
    || candidate.remaining !== Math.max(0, candidate.limit! - candidate.used!)
    || typeof candidate.windowStartsAt !== 'string'
    || typeof candidate.windowEndsAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.windowStartsAt))
    || !Number.isFinite(Date.parse(candidate.windowEndsAt))
    || Date.parse(candidate.windowStartsAt) >= Date.parse(candidate.windowEndsAt)
  ) return null;
  return candidate as AiUsage;
}

function nullableServerDate(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

/** Runtime boundary for a complete account snapshot included with quota
 * rejections. Applying the whole snapshot prevents warning/paywall copy from
 * using a stale Free-vs-Pro plan while the counter itself is already fresh. */
export function accountStatusFromUnknown(value: unknown): AccountStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AccountStatus>;
  const entitlement = candidate.entitlement;
  const aiUsage = aiUsageFromUnknown(candidate.aiUsage);
  const leftoversScanUsage = candidate.leftoversScanUsage === null
    ? null
    : aiUsageFromUnknown(candidate.leftoversScanUsage);

  if (
    (candidate.plan !== 'free' && candidate.plan !== 'pro')
    || typeof candidate.isPro !== 'boolean'
    || candidate.isPro !== (candidate.plan === 'pro')
    || !entitlement
    || typeof entitlement !== 'object'
    || Array.isArray(entitlement)
    || !['active', 'inactive', 'unavailable'].includes(entitlement.status)
    || !['revenuecat', 'none'].includes(entitlement.provider)
    || candidate.isPro !== (entitlement.status === 'active')
    || (entitlement.provider === 'none' && entitlement.status !== 'unavailable')
    || !nullableServerDate(entitlement.expiresAt)
    || !nullableServerDate(entitlement.verifiedAt)
    || (entitlement.status === 'unavailable' && entitlement.verifiedAt !== null)
    || (entitlement.status !== 'unavailable' && entitlement.verifiedAt === null)
    || (entitlement.productIdentifier !== null
      && (typeof entitlement.productIdentifier !== 'string'
        || entitlement.productIdentifier.length > 200))
    || !aiUsage
    || (candidate.leftoversScanUsage !== null && !leftoversScanUsage)
  ) return null;

  return {
    plan: candidate.plan,
    isPro: candidate.isPro,
    entitlement: {
      status: entitlement.status,
      provider: entitlement.provider,
      expiresAt: entitlement.expiresAt,
      verifiedAt: entitlement.verifiedAt,
      productIdentifier: entitlement.productIdentifier,
    },
    aiUsage,
    leftoversScanUsage,
  };
}

export type QuotaBucket = 'suggestions' | 'leftovers';
export type QuotaGateDecision =
  | { kind: 'allow' }
  | { kind: 'quota-exhausted'; usage: AiUsage; isPro: boolean }
  | { kind: 'pro-required' };

/** Interpret only a successful, freshly fetched status. `null` means the
 * refresh failed, so the feature endpoint must remain the final authority
 * instead of a stale cached zero falsely trapping the user. */
export function quotaGateAfterRefresh(
  refreshed: AccountStatus | null,
  bucket: QuotaBucket,
  now = new Date(),
): QuotaGateDecision {
  if (!refreshed || refreshed.entitlement.status === 'unavailable') return { kind: 'allow' };
  if (bucket === 'leftovers' && !refreshed.isPro) return { kind: 'pro-required' };
  const quota = bucket === 'suggestions'
    ? refreshed.aiUsage
    : refreshed.leftoversScanUsage;
  return quota && isCurrentUsageWindowExhausted(quota, now)
    ? { kind: 'quota-exhausted', usage: quota, isPro: refreshed.isPro }
    : { kind: 'allow' };
}

type DateParts = { year: number; month: number; day: number };

function dateParts(date: Date, locale: string, timeZone?: string): DateParts {
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);

  const value = (type: 'year' | 'month' | 'day') =>
    Number(parts.find(part => part.type === type)?.value);

  return { year: value('year'), month: value('month'), day: value('day') };
}

function calendarDay(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

/** Human copy for the server-owned window boundary, in the device time zone. */
export function formatResetLabel(
  windowEndsAt: string,
  now = new Date(),
  locale = 'en-US',
  timeZone?: string,
): string {
  const reset = new Date(windowEndsAt);
  if (Number.isNaN(reset.getTime())) return 'Reset time unavailable';
  if (reset.getTime() <= now.getTime()) return 'Resetting now';

  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = calendarDay(dateParts(reset, locale, zone)) -
    calendarDay(dateParts(now, locale, zone));
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(zone ? { timeZone: zone } : {}),
  }).format(reset);

  if (days === 0) return `Resets today at ${time}`;
  if (days === 1) return `Resets tomorrow at ${time}`;
  if (days < 7) {
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      ...(zone ? { timeZone: zone } : {}),
    }).format(reset);
    return `Resets ${weekday} at ${time}`;
  }

  const date = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(reset.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    ...(zone ? { timeZone: zone } : {}),
  }).format(reset);
  return `Resets ${date} at ${time}`;
}

export function formatUsageSummary(usage: AiUsage): string {
  return `${usage.remaining} of ${usage.limit} AI meal suggestions left`;
}

/** A cached zero only blocks locally while its server-owned window is still
 * current. At or after the boundary, let the server refresh/decide instead of
 * trapping an open screen on a stale exhausted snapshot. */
export function isCurrentUsageWindowExhausted(
  usage: AiUsage | null | undefined,
  now = new Date(),
): boolean {
  if (!usage || usage.remaining > 0) return false;
  const endsAt = new Date(usage.windowEndsAt).getTime();
  return Number.isFinite(endsAt) && endsAt > now.getTime();
}

export type UsageNoticeLevel = 'normal' | 'low' | 'critical' | 'exhausted';

export type CheckoutState =
  | 'ready'
  | 'sign-in-required'
  | 'billing-unconfigured'
  | 'legal-unconfigured'
  | 'verification-unavailable'
  | 'status-error'
  | 'status-pending'
  | 'offer-unavailable';

/** Store-review legal links must be real HTTPS web destinations. */
export function isSecureWebUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

/** Pure paywall state machine, shared by rendering and focused tests. */
export function checkoutState(input: {
  requiresAccount: boolean;
  billingConfigured: boolean;
  legalConfigured: boolean;
  entitlementStatus?: AccountStatus['entitlement']['status'];
  hasStatusError: boolean;
  hasSelectedOffer: boolean;
}): CheckoutState {
  if (input.requiresAccount) return 'sign-in-required';
  if (!input.billingConfigured) return 'billing-unconfigured';
  if (!input.legalConfigured) return 'legal-unconfigured';
  if (input.entitlementStatus === 'unavailable') return 'verification-unavailable';
  if (input.hasStatusError) return 'status-error';
  if (input.entitlementStatus === undefined) return 'status-pending';
  if (!input.hasSelectedOffer) return 'offer-unavailable';
  return 'ready';
}

export function usageNotice(
  usage: AiUsage,
  isPro: boolean,
  now = new Date(),
): { level: UsageNoticeLevel; title: string; reset: string } {
  const reset = formatResetLabel(usage.windowEndsAt, now);
  // A fixed "three left" threshold works for Free's ten suggestions, but it
  // gives a 100-use Pro plan almost no notice. Warn at the last 10% while
  // preserving three as the useful minimum for ordinary-sized allowances.
  const lowBalanceThreshold = Math.min(
    usage.limit,
    Math.max(3, Math.ceil(usage.limit * 0.1)),
  );
  if (usage.remaining <= 0) {
    return {
      level: 'exhausted',
      title: isPro
        ? 'No AI suggestions remaining this week'
        : 'No free suggestions remaining this week',
      reset,
    };
  }
  if (usage.remaining === 1) {
    return {
      level: 'critical',
      title: isPro
        ? '1 AI suggestion remaining this week'
        : '1 free suggestion remaining this week',
      reset,
    };
  }
  if (usage.remaining <= lowBalanceThreshold) {
    return {
      level: 'low',
      title: isPro
        ? `${usage.remaining} AI suggestions remaining this week`
        : `${usage.remaining} free suggestions remaining this week`,
      reset,
    };
  }
  return { level: 'normal', title: formatUsageSummary(usage), reset };
}
