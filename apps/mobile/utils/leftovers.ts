import {
  base64ByteLength,
  MAX_LEFTOVERS_PHOTO_BYTES,
  MAX_LEFTOVERS_PHOTOS,
  MAX_LEFTOVERS_UPLOAD_BYTES,
} from '@fridgie/shared/leftovers';
import { formatResetLabel, type AiUsage } from './pro';

export interface LeftoversPhoto {
  id: string;
  /** Fridgie-owned, resized cache file used only for the on-device preview. */
  uri: string;
  /** Kept separately so cleanup can never target a picker/library source URI. */
  ownedUri: string;
  /** The resized cache file is always re-encoded as JPEG. */
  dataUrl: string;
  byteSize: number;
}

interface ProcessedAssetLike {
  uri?: string;
  /** Must be the URI returned by ImageManipulator, never the picker source. */
  ownedUri?: string;
  base64?: string | null;
}

/** 1568px is ample for ingredient recognition without shipping camera originals. */
export const LEFTOVERS_MAX_IMAGE_EDGE = 1568;

export type LeftoversResizeAction =
  | { resize: { width: number } }
  | { resize: { height: number } };

/**
 * ImageManipulator normally writes under Expo's cache directory. Verify that
 * ownership boundary at runtime so a platform regression can never make later
 * cleanup target the picker/library source.
 */
export function isOwnedLeftoversCacheUri(
  sourceUri: string,
  processedUri: string,
  cacheDirectory: string | null,
): boolean {
  if (!sourceUri || !processedUri || !cacheDirectory || sourceUri === processedUri) return false;
  const cachePrefix = cacheDirectory.endsWith('/') ? cacheDirectory : `${cacheDirectory}/`;
  return processedUri.startsWith(cachePrefix);
}

/**
 * Returns the one-axis resize ImageManipulator needs to preserve aspect ratio.
 * An empty list means a small image only needs JPEG re-encoding; null means the
 * picker did not provide trustworthy dimensions and the source should be skipped.
 */
export function leftoversResizeActions(
  width: unknown,
  height: unknown,
  maxEdge = LEFTOVERS_MAX_IMAGE_EDGE,
): LeftoversResizeAction[] | null {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(maxEdge) || maxEdge <= 0) return null;

  if (Math.max(width, height) <= maxEdge) return [];
  return width >= height
    ? [{ resize: { width: Math.round(maxEdge) } }]
    : [{ resize: { height: Math.round(maxEdge) } }];
}

/**
 * Generation guard shared by picker and scan work. `invalidate()` makes every
 * prior completion stale immediately but retains the in-flight exclusion until
 * that operation finishes; `start()` therefore prevents overlaps even before
 * React state has re-rendered or while a closing request is winding down.
 */
export class LeftoversOperationTracker {
  private revision = 0;
  private active: number | null = null;

  start(): number | null {
    if (this.active !== null) return null;
    this.revision += 1;
    this.active = this.revision;
    return this.active;
  }

  isCurrent(token: number): boolean {
    return this.active === token && this.revision === token;
  }

  finish(token: number): boolean {
    if (this.active !== token) return false;
    this.active = null;
    return this.revision === token;
  }

  invalidate(): void {
    this.revision += 1;
  }
}

export interface PhotoRejections {
  missingData: number;
  tooLarge: number;
  overLimit: number;
}

export interface PreparedPhotos {
  accepted: LeftoversPhoto[];
  rejected: PhotoRejections;
  /** Manipulator outputs rejected by byte/count limits; safe for the caller to delete. */
  discardedOwnedUris: string[];
}

/**
 * Accepts as many picked photos as fit. A bad photo does not throw away the
 * good photos selected alongside it; the caller can explain the partial result
 * using the rejection counts.
 */
export function prepareLeftoversPhotos(
  assets: ProcessedAssetLike[],
  existing: LeftoversPhoto[],
  makeId: () => string,
): PreparedPhotos {
  const accepted: LeftoversPhoto[] = [];
  const rejected: PhotoRejections = { missingData: 0, tooLarge: 0, overLimit: 0 };
  const discardedOwnedUris: string[] = [];
  let count = existing.length;
  let totalBytes = existing.reduce((sum, photo) => sum + photo.byteSize, 0);

  for (const asset of assets) {
    // Only ImageManipulator outputs carry ownedUri. Refusing an arbitrary picker
    // URI here is what prevents later cleanup from deleting a library original.
    if (!asset.base64 || !asset.uri || !asset.ownedUri || asset.uri !== asset.ownedUri) {
      rejected.missingData += 1;
      if (asset.ownedUri) discardedOwnedUris.push(asset.ownedUri);
      continue;
    }

    const byteSize = base64ByteLength(asset.base64);
    if (byteSize === 0) {
      rejected.missingData += 1;
      discardedOwnedUris.push(asset.ownedUri);
      continue;
    }
    if (byteSize > MAX_LEFTOVERS_PHOTO_BYTES) {
      rejected.tooLarge += 1;
      discardedOwnedUris.push(asset.ownedUri);
      continue;
    }
    if (count >= MAX_LEFTOVERS_PHOTOS || totalBytes + byteSize > MAX_LEFTOVERS_UPLOAD_BYTES) {
      rejected.overLimit += 1;
      discardedOwnedUris.push(asset.ownedUri);
      continue;
    }

    accepted.push({
      id: makeId(),
      uri: asset.uri,
      ownedUri: asset.ownedUri,
      dataUrl: `data:image/jpeg;base64,${asset.base64}`,
      byteSize,
    });
    count += 1;
    totalBytes += byteSize;
  }

  return { accepted, rejected, discardedOwnedUris };
}

/** Delete only explicit ImageManipulator outputs, de-duplicated and best-effort. */
export async function cleanupOwnedLeftoversUris(
  ownedUris: (string | null | undefined)[],
  deleteFile: (uri: string) => Promise<void>,
): Promise<number> {
  const unique = [...new Set(ownedUris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0))];
  const results = await Promise.allSettled(unique.map((uri) => deleteFile(uri)));
  return results.filter((result) => result.status === 'rejected').length;
}

export function moveLeftoversPhoto(
  photos: LeftoversPhoto[],
  index: number,
  direction: -1 | 1,
): LeftoversPhoto[] {
  const destination = index + direction;
  if (index < 0 || index >= photos.length || destination < 0 || destination >= photos.length) return photos;
  const next = [...photos];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

export function photoRejectionMessage(rejected: PhotoRejections): string | null {
  const count = rejected.missingData + rejected.tooLarge + rejected.overLimit;
  if (!count) return null;
  const reasons: string[] = [];
  if (rejected.missingData) reasons.push(`${rejected.missingData} could not be read`);
  if (rejected.tooLarge) reasons.push(`${rejected.tooLarge} was too large after compression`);
  if (rejected.overLimit) reasons.push(`${rejected.overLimit} did not fit the combined upload limits`);
  return `${count === 1 ? 'One photo was' : `${count} photos were`} skipped: ${reasons.join('; ')}.`;
}

export type LeftoversScanNoticeLevel = 'normal' | 'low' | 'critical' | 'exhausted';

/** User-facing scan allowance copy driven by the server's weekly window. */
export function leftoversScanNotice(
  usage: AiUsage,
  now = new Date(),
): { level: LeftoversScanNoticeLevel; title: string; reset: string } {
  const remaining = Math.max(0, Math.floor(usage.remaining));
  const reset = formatResetLabel(usage.windowEndsAt, now);
  if (remaining === 0) {
    return { level: 'exhausted', title: '0 Leftovers Mode scans remaining this week', reset };
  }
  if (remaining === 1) {
    return { level: 'critical', title: '1 Leftovers Mode scan remaining this week', reset };
  }
  if (remaining <= 3) {
    return { level: 'low', title: `${remaining} Leftovers Mode scans remaining this week`, reset };
  }
  return {
    level: 'normal',
    title: `${remaining} of ${usage.limit} weekly Leftovers Mode scans remaining`,
    reset,
  };
}

function usageFromBodyField(value: unknown, field: 'scanUsage' | 'attemptUsage'): AiUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = (value as Record<string, unknown>)[field];
  if (!usage || typeof usage !== 'object') return null;
  const candidate = usage as Partial<Record<keyof AiUsage, unknown>>;
  const validCount = (count: unknown) => typeof count === 'number'
    && Number.isInteger(count)
    && count >= 0;
  if (!validCount(candidate.used)
    || !validCount(candidate.limit)
    || !validCount(candidate.remaining)
    || typeof candidate.windowStartsAt !== 'string'
    || typeof candidate.windowEndsAt !== 'string'
    || Number.isNaN(new Date(candidate.windowStartsAt).getTime())
    || Number.isNaN(new Date(candidate.windowEndsAt).getTime())) return null;

  return {
    used: candidate.used,
    limit: candidate.limit,
    remaining: candidate.remaining,
    windowStartsAt: candidate.windowStartsAt,
    windowEndsAt: candidate.windowEndsAt,
  } as AiUsage;
}

/** Safely reads the optional weekly quota snapshot in success/429 bodies. */
export function leftoversScanUsageFromBody(value: unknown): AiUsage | null {
  return usageFromBodyField(value, 'scanUsage');
}

/**
 * The attempt limiter is an hourly abuse/cost guard, not the user's weekly
 * allowance. Its response gets standalone cooldown copy and never feeds the
 * weekly scan card.
 */
export function leftoversAttemptRateMessage(value: unknown, now = new Date()): string {
  const usage = usageFromBodyField(value, 'attemptUsage');
  if (!usage) {
    return 'Too many Leftovers Mode scans were started in a short time. Wait a little and try again.';
  }
  return `Too many Leftovers Mode scans were started in a short time. ${formatResetLabel(usage.windowEndsAt, now)}.`;
}
