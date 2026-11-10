import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMetrics } from '../../src/observability/metrics.js';
import type { Collection, Repo } from '../../src/db/repo.js';
import { MlClientError, type MlClient } from '../../src/ml/client.js';
import { auth, fakeAuth } from './helpers.js';

const CLIENT_A = 'client-a';
const OWNED = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222'; // exists, but belongs to another client
const DOC = '33333333-3333-4333-8333-333333333333';

function fakeRepo(): Repo {
  const collection: Collection = { id: OWNED, name: 'docs', version: 0, createdAt: 'now' };
  return {
    createCollection: vi.fn(async (_c, name) => (name === 'taken' ? null : { ...collection, name })),
    listCollections: vi.fn(async () => [collection]),
    // Tenant-scoped lookup: only returns the collection when the owner matches.
    getCollection: vi.fn(async (clientId, id) => (clientId === CLIENT_A && id === OWNED ? collection : null)),
    listDocuments: vi.fn(async () => []),
    getChunk: vi.fn(async () => null),
    getDocument: vi.fn(async (clientId, collectionId, documentId) =>
      clientId === CLIENT_A && collectionId === OWNED && documentId === DOC
        ? { id: DOC, filename: 'a.md', mimeType: 'text/markdown', status: 'failed' as const, error: 'No extractable text', chunkCount: 0, createdAt: 'now' }
        : null),
    deleteDocument: vi.fn(async (clientId, collectionId, documentId) =>
      clientId === CLIENT_A && collectionId === OWNED && documentId === DOC),
  };
}

function setup(ml: Partial<MlClient> = {}, scopes?: Parameters<typeof fakeAuth>[1]) {
  const repo = fakeRepo();
  const mlClient: MlClient = {
    ingest: vi.fn(async () => ({ document_id: 'doc-1', created: true, status: 'processing' as const, chunk_count: 0 })),
    embed: vi.fn(),
    info: vi.fn(),
    ...ml,
  };
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'fatal' }),
    repo,
    ml: mlClient,
    retriever: { retrieve: vi.fn() },
    answerer: { stream: vi.fn(), answer: vi.fn() },
    ...fakeAuth(CLIENT_A, scopes),
    metrics: createMetrics({ hitThreshold: 0.6 }),
    readinessChecks: {},
  });
  return { app, repo, ml: mlClient };
}

function upload(filename = 'notes.md', content = '# Hi\nThere.') {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  return form;
}

describe('collections routes', () => {
  it('creates a collection scoped to the calling client', async () => {
    const { app, repo } = setup();
    const res = await app.inject({ method: 'POST', url: '/collections', headers: auth, payload: { name: 'handbook' } });
    expect(res.statusCode).toBe(201);
    expect(repo.createCollection).toHaveBeenCalledWith(CLIENT_A, 'handbook');
  });

  it('returns 409 for a duplicate name and 400 for an invalid one', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/collections', headers: auth, payload: { name: 'taken' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/collections', headers: auth, payload: { name: '../etc' } })).statusCode).toBe(400);
  });

  it('forwards an upload for an owned collection to the ml service and answers 202 + Location', async () => {
    const { app, ml } = setup();
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/documents`, headers: auth, payload: upload() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ documentId: 'doc-1', created: true, status: 'processing', chunkCount: 0 });
    expect(res.headers.location).toBe(`/collections/${OWNED}/documents/doc-1`);
    const [clientId, collectionId, file] = vi.mocked(ml.ingest).mock.calls[0]!;
    expect(clientId).toBe(CLIENT_A);
    expect(collectionId).toBe(OWNED);
    expect(file.filename).toBe('notes.md');
    expect(file.data.toString()).toBe('# Hi\nThere.');
  });

  it("returns 404 (not 403) for another client's collection and never calls ml", async () => {
    const { app, ml } = setup();
    const res = await app.inject({ method: 'POST', url: `/collections/${FOREIGN}/documents`, headers: auth, payload: upload() });
    expect(res.statusCode).toBe(404);
    expect(ml.ingest).not.toHaveBeenCalled();
  });

  it('returns 200 when the same file was already ingested', async () => {
    const { app } = setup({ ingest: async () => ({ document_id: 'doc-1', created: false, status: 'ready' as const, chunk_count: 3 }) });
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/documents`, headers: auth, payload: upload() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false, status: 'ready', chunkCount: 3 });
  });

  it('passes ml validation errors (e.g. 415 unsupported type) through to the caller', async () => {
    const { app } = setup({
      ingest: async () => {
        throw new MlClientError(415, 'Unsupported file type');
      },
    });
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/documents`, headers: auth, payload: upload('a.png') });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('Unsupported file type');
  });

  it('rejects a non-uuid collection id before touching the database', async () => {
    const { app, repo } = setup();
    const res = await app.inject({ method: 'GET', url: '/collections/not-a-uuid/documents', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(repo.getCollection).not.toHaveBeenCalled();
  });

  it('401s without a token, before reading the upload body', async () => {
    const { app, repo } = setup();
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/documents`, payload: upload() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="rag-api"');
    expect(repo.getCollection).not.toHaveBeenCalled();
  });

  it('401s with an invalid token and says so in WWW-Authenticate', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/collections', headers: { authorization: 'Bearer forged' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('403s when the token lacks the route scope (query-only client uploading)', async () => {
    const { app, ml } = setup({}, ['query']);
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/documents`, headers: auth, payload: upload() });
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toContain('scope="documents:write"');
    expect(ml.ingest).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: '/collections', headers: auth })).statusCode).toBe(200);
  });

  it('GET /collections/:id/documents/:documentId returns status and error, 404 otherwise', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/collections/${OWNED}/documents/${DOC}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'failed', error: 'No extractable text' });
    expect((await app.inject({ method: 'GET', url: `/collections/${FOREIGN}/documents/${DOC}`, headers: auth })).statusCode).toBe(404);
  });

  describe('DELETE /collections/:id/documents/:documentId', () => {
    it('deletes an owned document with 204', async () => {
      const { app, repo } = setup();
      const res = await app.inject({ method: 'DELETE', url: `/collections/${OWNED}/documents/${DOC}`, headers: auth });
      expect(res.statusCode).toBe(204);
      expect(repo.deleteDocument).toHaveBeenCalledWith(CLIENT_A, OWNED, DOC);
    });

    it("404s for a missing document or another client's collection", async () => {
      const { app } = setup();
      const missing = '44444444-4444-4444-8444-444444444444';
      expect((await app.inject({ method: 'DELETE', url: `/collections/${OWNED}/documents/${missing}`, headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/collections/${FOREIGN}/documents/${DOC}`, headers: auth })).statusCode).toBe(404);
    });

    it('403s for a query-only token and 400s for a non-uuid id', async () => {
      const { app, repo } = setup({}, ['query']);
      expect((await app.inject({ method: 'DELETE', url: `/collections/${OWNED}/documents/${DOC}`, headers: auth })).statusCode).toBe(403);
      const full = setup();
      expect((await full.app.inject({ method: 'DELETE', url: `/collections/${OWNED}/documents/nope`, headers: auth })).statusCode).toBe(400);
      expect(repo.deleteDocument).not.toHaveBeenCalled();
      expect(full.repo.deleteDocument).not.toHaveBeenCalled();
    });
  });
});
