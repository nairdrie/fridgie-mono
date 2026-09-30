import { beforeEach, describe, expect, mock, test } from 'bun:test';

type FakeFile = {
  name: string;
  metadata: { metadata: { deleteAfter: string } };
  delete: (options: { ignoreNotFound: boolean }) => Promise<void>;
};

type FakePage = { files: FakeFile[]; nextPageToken?: string };

let pages: Record<string, FakePage>;
let listQueries: Record<string, unknown>[];
let deletions: { name: string; ignoreNotFound: boolean }[];

const fakeBucket = {
  getFiles: async (query: Record<string, unknown>) => {
    listQueries.push(query);
    const page = pages[typeof query.pageToken === 'string' ? query.pageToken : 'first'];
    if (!page) throw new Error(`Unexpected page token: ${String(query.pageToken)}`);
    const nextQuery = page.nextPageToken ? { ...query, pageToken: page.nextPageToken } : {};
    return [page.files, nextQuery, {}];
  },
};

mock.module('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => fakeBucket }),
}));

const { cleanupExpiredPrintArtifacts } = await import('../utils/cookbookPrintStorage');

function file(name: string, deleteAfter: string): FakeFile {
  return {
    name,
    metadata: { metadata: { deleteAfter } },
    delete: async options => { deletions.push({ name, ignoreNotFound: options.ignoreNotFound }); },
  };
}

beforeEach(() => {
  process.env.PRINT_STORAGE_BUCKET = 'private-print-test';
  pages = {};
  listQueries = [];
  deletions = [];
});

describe('print artifact retention cleanup', () => {
  test('paginates past a fresh lexical page to delete later expired artifacts', async () => {
    pages = {
      first: {
        files: [file('private-print/a-fresh.pdf', '2026-10-02T00:00:00.000Z')],
        nextPageToken: 'page-2',
      },
      'page-2': {
        files: [file('private-print/z-expired.pdf', '2026-09-01T00:00:00.000Z')],
      },
    };

    const deleted = await cleanupExpiredPrintArtifacts(new Date('2026-09-29T00:00:00.000Z'), 500);

    expect(deleted).toBe(1);
    expect(deletions).toEqual([{ name: 'private-print/z-expired.pdf', ignoreNotFound: true }]);
    expect(listQueries).toEqual([
      { prefix: 'private-print/', autoPaginate: false, maxResults: 1_000 },
      { prefix: 'private-print/', autoPaginate: false, maxResults: 1_000, pageToken: 'page-2' },
    ]);
  });

  test('caps deletions while carrying the GCS page token between requests', async () => {
    pages = {
      first: {
        files: [file('private-print/a-expired.pdf', '2026-09-01T00:00:00.000Z')],
        nextPageToken: 'page-2',
      },
      'page-2': {
        files: [
          file('private-print/b-expired.pdf', '2026-09-02T00:00:00.000Z'),
          file('private-print/c-expired.pdf', '2026-09-03T00:00:00.000Z'),
        ],
        nextPageToken: 'page-3',
      },
      'page-3': {
        files: [file('private-print/d-expired.pdf', '2026-09-04T00:00:00.000Z')],
      },
    };

    const deleted = await cleanupExpiredPrintArtifacts(new Date('2026-09-29T00:00:00.000Z'), 2);

    expect(deleted).toBe(2);
    expect(deletions.map(entry => entry.name)).toEqual([
      'private-print/a-expired.pdf',
      'private-print/b-expired.pdf',
    ]);
    expect(listQueries.map(query => query.pageToken)).toEqual([undefined, 'page-2']);
  });
});
