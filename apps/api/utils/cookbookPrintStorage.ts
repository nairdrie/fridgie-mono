import { getStorage } from 'firebase-admin/storage';
import type { Bucket } from '@google-cloud/storage';
import type { CookbookPrintArtifacts } from './cookbookPrintPdf';

export interface StoredPrintArtifacts {
  interiorPath: string;
  coverPath: string;
  previewPagePaths: string[];
  coverPreviewPath?: string;
  interiorSha256: string;
  coverSha256: string;
  interiorMd5: string;
  coverMd5: string;
  pageCount: number;
  deleteAfter: string;
}

export interface SignedStoredPrintArtifacts {
  interiorUrl: string;
  coverUrl: string;
  previewPageUrls: string[];
  coverPreviewUrl?: string;
  expiresAt: string;
}

function storageBucket(): Bucket {
  const name = process.env.PRINT_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET;
  if (!name) throw Object.assign(new Error('Private print storage is not configured.'), { code: 'PRINT_STORAGE_NOT_CONFIGURED' });
  return getStorage().bucket(name);
}

async function writePrivate(path: string, bytes: Buffer, contentType: string, metadata: Record<string, string>) {
  const file = storageBucket().file(path);
  const [exists] = await file.exists();
  if (exists) return;
  await file.save(bytes, {
    resumable: false,
    validation: 'md5',
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType,
      cacheControl: 'private,no-store,max-age=0',
      metadata,
    },
  });
}

export async function storePrintArtifacts(options: {
  ownerUid: string;
  scope: 'preview' | 'order';
  scopeId: string;
  version: string;
  artifacts: CookbookPrintArtifacts;
  previewPages?: Buffer[];
  coverPreview?: Buffer;
  now?: Date;
}): Promise<StoredPrintArtifacts> {
  const createdAt = options.now ?? new Date();
  const retentionDays = options.scope === 'preview' ? 2 : Number(process.env.PRINT_ORDER_ARTIFACT_RETENTION_DAYS || 120);
  const deleteAfter = new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString();
  const prefix = `private-print/${options.scope}s/${options.ownerUid}/${options.scopeId}/${options.version}`;
  const interiorPath = `${prefix}/interior-${options.artifacts.interiorSha256.slice(0, 16)}.pdf`;
  const coverPath = `${prefix}/cover-${options.artifacts.coverSha256.slice(0, 16)}.pdf`;
  const common = { ownerUid: options.ownerUid, scope: options.scope, scopeId: options.scopeId, deleteAfter };
  const uploads: Promise<unknown>[] = [
    writePrivate(interiorPath, options.artifacts.interior, 'application/pdf', { ...common, sha256: options.artifacts.interiorSha256, md5: options.artifacts.interiorMd5, artifactKind: 'interior' }),
    writePrivate(coverPath, options.artifacts.cover, 'application/pdf', { ...common, sha256: options.artifacts.coverSha256, md5: options.artifacts.coverMd5, artifactKind: 'cover' }),
  ];
  const previewPagePaths = (options.previewPages ?? []).map((_, index) => `${prefix}/preview/page-${String(index + 1).padStart(4, '0')}.jpg`);
  for (const [index, bytes] of (options.previewPages ?? []).entries()) {
    uploads.push(writePrivate(previewPagePaths[index]!, bytes, 'image/jpeg', { ...common, artifactKind: 'preview-page', pageNumber: String(index + 1) }));
  }
  const coverPreviewPath = options.coverPreview ? `${prefix}/preview/cover.jpg` : undefined;
  if (options.coverPreview && coverPreviewPath) uploads.push(writePrivate(coverPreviewPath, options.coverPreview, 'image/jpeg', { ...common, artifactKind: 'cover-preview' }));
  await Promise.all(uploads);
  return {
    interiorPath,
    coverPath,
    previewPagePaths,
    coverPreviewPath,
    interiorSha256: options.artifacts.interiorSha256,
    coverSha256: options.artifacts.coverSha256,
    interiorMd5: options.artifacts.interiorMd5,
    coverMd5: options.artifacts.coverMd5,
    pageCount: options.artifacts.pageCount,
    deleteAfter,
  };
}

export async function signPrintArtifacts(artifacts: StoredPrintArtifacts, ttlMinutes: number): Promise<SignedStoredPrintArtifacts> {
  const expires = new Date(Date.now() + Math.max(1, ttlMinutes) * 60_000);
  const sign = async (path: string) => (await storageBucket().file(path).getSignedUrl({ version: 'v4', action: 'read', expires }))[0];
  const [interiorUrl, coverUrl, previewPageUrls, coverPreviewUrl] = await Promise.all([
    sign(artifacts.interiorPath),
    sign(artifacts.coverPath),
    Promise.all(artifacts.previewPagePaths.map(sign)),
    artifacts.coverPreviewPath ? sign(artifacts.coverPreviewPath) : Promise.resolve(undefined),
  ]);
  return { interiorUrl, coverUrl, previewPageUrls, coverPreviewUrl, expiresAt: expires.toISOString() };
}

/** Copies the already-reviewed PDFs into the immutable order retention scope.
 * This is deliberately a storage-side copy: re-rendering could re-download a
 * mutable recipe image and make the purchased artifact differ from preview. */
export async function promotePrintArtifacts(options: {
  ownerUid: string;
  orderId: string;
  snapshotHash: string;
  source: StoredPrintArtifacts;
  now?: Date;
}): Promise<StoredPrintArtifacts> {
  const now = options.now ?? new Date();
  const retentionDays = Number(process.env.PRINT_ORDER_ARTIFACT_RETENTION_DAYS || 120);
  const deleteAfter = new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
  const prefix = `private-print/orders/${options.ownerUid}/${options.orderId}/${options.snapshotHash.slice(0, 16)}`;
  const interiorPath = `${prefix}/interior-${options.source.interiorSha256.slice(0, 16)}.pdf`;
  const coverPath = `${prefix}/cover-${options.source.coverSha256.slice(0, 16)}.pdf`;
  const copy = async (source: string, destination: string, kind: string, sha256: string, md5: string) => {
    const target = storageBucket().file(destination);
    const [exists] = await target.exists();
    if (exists) return;
    await storageBucket().file(source).copy(target, {
      preconditionOpts: { ifGenerationMatch: 0 },
      contentType: 'application/pdf',
      cacheControl: 'private,no-store,max-age=0',
      metadata: { ownerUid: options.ownerUid, scope: 'order', scopeId: options.orderId, deleteAfter, artifactKind: kind, sha256, md5 },
    });
  };
  await Promise.all([
    copy(options.source.interiorPath, interiorPath, 'interior', options.source.interiorSha256, options.source.interiorMd5),
    copy(options.source.coverPath, coverPath, 'cover', options.source.coverSha256, options.source.coverMd5),
  ]);
  return {
    ...options.source,
    interiorPath,
    coverPath,
    previewPagePaths: [],
    coverPreviewPath: undefined,
    deleteAfter,
  };
}

export async function deleteStoredPrintArtifacts(artifacts: Pick<StoredPrintArtifacts, 'interiorPath' | 'coverPath' | 'previewPagePaths' | 'coverPreviewPath'>): Promise<void> {
  const paths = [artifacts.interiorPath, artifacts.coverPath, ...artifacts.previewPagePaths, artifacts.coverPreviewPath].filter((path): path is string => !!path);
  await Promise.all(paths.map(path => storageBucket().file(path).delete({ ignoreNotFound: true })));
}

export async function cleanupExpiredPrintArtifacts(now = new Date(), limit = 500): Promise<number> {
  const deletionLimit = Math.max(1, Math.min(1_000, Number.isFinite(limit) ? Math.trunc(limit) : 500));
  const bucket = storageBucket();
  const expired = [];
  let pageToken: string | undefined;

  do {
    const [files, nextQuery] = await bucket.getFiles({
      prefix: 'private-print/',
      autoPaginate: false,
      maxResults: 1_000,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const file of files) {
      const value = file.metadata?.metadata?.deleteAfter;
      if (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime()) {
        expired.push(file);
        if (expired.length >= deletionLimit) break;
      }
    }
    pageToken = typeof nextQuery?.pageToken === 'string' ? nextQuery.pageToken : undefined;
  } while (expired.length < deletionLimit && pageToken);

  await Promise.all(expired.map(file => file.delete({ ignoreNotFound: true })));
  return expired.length;
}
