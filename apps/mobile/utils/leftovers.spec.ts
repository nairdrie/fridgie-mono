import { describe, expect, test } from 'bun:test';
import {
  MAX_LEFTOVERS_PHOTO_BYTES,
  MAX_LEFTOVERS_PHOTOS,
  MAX_LEFTOVERS_UPLOAD_BYTES,
} from '@fridgie/shared/leftovers';
import {
  cleanupOwnedLeftoversUris,
  isOwnedLeftoversCacheUri,
  LEFTOVERS_MAX_IMAGE_EDGE,
  LeftoversOperationTracker,
  leftoversAttemptRateMessage,
  leftoversResizeActions,
  leftoversScanNotice,
  leftoversScanUsageFromBody,
  moveLeftoversPhoto,
  photoRejectionMessage,
  prepareLeftoversPhotos,
} from './leftovers';

const asset = (bytes: number, name = 'photo.jpg') => {
  const uri = `file:///app-cache/${name}`;
  return {
    uri,
    ownedUri: uri,
    // Four base64 chars decode to three bytes. Exact content is irrelevant to
    // this boundary test; it never leaves the pure helper.
    base64: 'A'.repeat(Math.ceil(bytes / 3) * 4),
  };
};

describe('Leftovers Mode image preparation', () => {
  test('bounds the long edge while preserving the other dimension', () => {
    expect(leftoversResizeActions(4032, 3024)).toEqual([
      { resize: { width: LEFTOVERS_MAX_IMAGE_EDGE } },
    ]);
    expect(leftoversResizeActions(1200, 2400)).toEqual([
      { resize: { height: LEFTOVERS_MAX_IMAGE_EDGE } },
    ]);
    expect(leftoversResizeActions(1200, 900)).toEqual([]);
    expect(leftoversResizeActions(0, 900)).toBeNull();
  });

  test('only treats a distinct Expo cache result as app-owned', () => {
    const cache = 'file:///app/cache/';
    expect(isOwnedLeftoversCacheUri(
      'ph://user-library-original',
      'file:///app/cache/ImageManipulator/result.jpg',
      cache,
    )).toBe(true);
    expect(isOwnedLeftoversCacheUri(
      'file:///app/cache/source.jpg',
      'file:///app/cache/source.jpg',
      cache,
    )).toBe(false);
    expect(isOwnedLeftoversCacheUri(
      'ph://user-library-original',
      'file:///user/photos/original.jpg',
      cache,
    )).toBe(false);
    expect(isOwnedLeftoversCacheUri('source', 'file:///app/cache/result.jpg', null)).toBe(false);
  });

  test('keeps selection order and produces transient JPEG data URLs', () => {
    let id = 0;
    const result = prepareLeftoversPhotos([asset(9, 'one.jpg'), asset(12, 'two.jpg')], [], () => `${++id}`);
    expect(result.accepted.map(photo => photo.uri)).toEqual([
      'file:///app-cache/one.jpg',
      'file:///app-cache/two.jpg',
    ]);
    expect(result.accepted.every(photo => photo.uri === photo.ownedUri)).toBe(true);
    expect(result.accepted.every(photo => photo.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
    expect(result.rejected).toEqual({ missingData: 0, tooLarge: 0, overLimit: 0 });
    expect(result.discardedOwnedUris).toEqual([]);
  });

  test('partially accepts a batch and reports unreadable, oversized and excess photos', () => {
    const existing = prepareLeftoversPhotos(
      Array.from({ length: MAX_LEFTOVERS_PHOTOS - 1 }, (_, index) => asset(3, `${index}.jpg`)),
      [],
      () => crypto.randomUUID(),
    ).accepted;
    const result = prepareLeftoversPhotos([
      // No ownedUri: this represents a picker/library original and must never
      // be included in the deletion list.
      { uri: 'ph://user-library-original', base64: null },
      asset(MAX_LEFTOVERS_PHOTO_BYTES + 3, 'huge.jpg'),
      asset(3, 'fits.jpg'),
      asset(3, 'extra.jpg'),
    ], existing, () => crypto.randomUUID());

    expect(result.accepted.map(photo => photo.uri)).toEqual(['file:///app-cache/fits.jpg']);
    expect(result.rejected).toEqual({ missingData: 1, tooLarge: 1, overLimit: 1 });
    expect(result.discardedOwnedUris).toEqual([
      'file:///app-cache/huge.jpg',
      'file:///app-cache/extra.jpg',
    ]);
    expect(result.discardedOwnedUris).not.toContain('ph://user-library-original');
    expect(photoRejectionMessage(result.rejected)).toContain('3 photos were skipped');
  });

  test('enforces the lower per-photo and aggregate memory ceilings', () => {
    expect(MAX_LEFTOVERS_PHOTO_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_LEFTOVERS_UPLOAD_BYTES).toBe(6 * 1024 * 1024);

    const nearTwoMiB = MAX_LEFTOVERS_PHOTO_BYTES - 2;
    const existing = prepareLeftoversPhotos(
      [asset(nearTwoMiB, 'one.jpg'), asset(nearTwoMiB, 'two.jpg'), asset(nearTwoMiB, 'three.jpg')],
      [],
      () => crypto.randomUUID(),
    ).accepted;
    const result = prepareLeftoversPhotos([asset(9, 'over-total.jpg')], existing, () => crypto.randomUUID());
    expect(result.accepted).toEqual([]);
    expect(result.rejected.overLimit).toBe(1);
    expect(result.discardedOwnedUris).toEqual(['file:///app-cache/over-total.jpg']);
  });

  test('reorders only within bounds without mutating the source', () => {
    const photos = prepareLeftoversPhotos([asset(3, 'a.jpg'), asset(3, 'b.jpg')], [], () => crypto.randomUUID()).accepted;
    const moved = moveLeftoversPhoto(photos, 1, -1);
    expect(moved.map(photo => photo.uri)).toEqual(['file:///app-cache/b.jpg', 'file:///app-cache/a.jpg']);
    expect(photos.map(photo => photo.uri)).toEqual(['file:///app-cache/a.jpg', 'file:///app-cache/b.jpg']);
    expect(moveLeftoversPhoto(photos, 0, -1)).toBe(photos);
  });
});

describe('Leftovers Mode lifecycle guards', () => {
  test('invalidates stale work without allowing a replacement to overlap it', () => {
    const operations = new LeftoversOperationTracker();
    const first = operations.start();
    expect(first).not.toBeNull();
    expect(operations.start()).toBeNull();

    operations.invalidate();
    expect(operations.isCurrent(first!)).toBe(false);
    expect(operations.start()).toBeNull();
    expect(operations.finish(first!)).toBe(false);

    const next = operations.start();
    expect(next).not.toBeNull();
    expect(operations.isCurrent(next!)).toBe(true);
    expect(operations.finish(next!)).toBe(true);
  });

  test('de-duplicates owned cleanup and continues after a deletion failure', async () => {
    const deleted: string[] = [];
    const failures = await cleanupOwnedLeftoversUris(
      ['file:///app-cache/a.jpg', 'file:///app-cache/a.jpg', undefined, 'file:///app-cache/b.jpg'],
      async uri => {
        deleted.push(uri);
        if (uri.endsWith('/a.jpg')) throw new Error('already removed');
      },
    );

    expect(deleted).toEqual(['file:///app-cache/a.jpg', 'file:///app-cache/b.jpg']);
    expect(failures).toBe(1);
  });
});

describe('Leftovers Mode scan allowance', () => {
  const usage = (remaining: number) => ({
    used: 50 - remaining,
    limit: 50,
    remaining,
    windowStartsAt: '2026-09-28T00:00:00Z',
    windowEndsAt: '2026-10-05T00:00:00Z',
  });

  test('escalates visible warnings at three, one and zero scans', () => {
    const now = new Date('2026-09-29T18:00:00Z');
    expect(leftoversScanNotice(usage(3), now)).toMatchObject({
      level: 'low',
      title: '3 Leftovers Mode scans remaining this week',
    });
    expect(leftoversScanNotice(usage(1), now)).toMatchObject({
      level: 'critical',
      title: '1 Leftovers Mode scan remaining this week',
    });
    expect(leftoversScanNotice(usage(0), now)).toMatchObject({
      level: 'exhausted',
      title: '0 Leftovers Mode scans remaining this week',
    });
    expect(leftoversScanNotice(usage(0), now).reset).toContain('Resets');
  });

  test('reads only complete server scanUsage snapshots', () => {
    expect(leftoversScanUsageFromBody({ scanUsage: usage(3) })).toEqual(usage(3));
    expect(leftoversScanUsageFromBody({ scanUsage: { ...usage(3), remaining: '3' } })).toBeNull();
    expect(leftoversScanUsageFromBody({ scanUsage: { ...usage(3), windowEndsAt: 'later' } })).toBeNull();
    expect(leftoversScanUsageFromBody({ other: usage(3) })).toBeNull();
  });

  test('formats the hourly attempt cooldown without presenting it as weekly usage', () => {
    const attemptUsage = {
      used: 8,
      limit: 8,
      remaining: 0,
      windowStartsAt: '2026-09-29T18:00:00Z',
      windowEndsAt: '2026-09-29T19:00:00Z',
    };
    const message = leftoversAttemptRateMessage(
      { attemptUsage },
      new Date('2026-09-29T18:30:00Z'),
    );
    expect(message).toContain('in a short time');
    expect(message).toContain('Resets today at');
    expect(message).not.toContain('weekly');

    // A weekly scanUsage field must not be mistaken for the short cooldown.
    expect(leftoversAttemptRateMessage({ scanUsage: attemptUsage })).toContain('Wait a little');
  });
});
