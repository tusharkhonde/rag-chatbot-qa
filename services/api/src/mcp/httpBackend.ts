import type { Citation } from '../generation/citations.js';
import type { RetrievalMode, RetrievedChunk } from '../retrieval/types.js';
import { NotFoundError, type RagBackend } from './backend.js';

export interface HttpBackendOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Least privilege: the MCP server only reads, so it asks for a query-only token. */
  scope?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * RagBackend over the public REST API. The stdio MCP server is just another OAuth client:
 * it authenticates with ITS OWN client credentials (never a token handed to it by the MCP host),
 * caches the access token, and refreshes it shortly before expiry or after a 401.
 */
export function httpBackend(opts: HttpBackendOptions): RagBackend {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/$/, '');
  let cached: { token: string; expiresAt: number } | undefined;

  async function token(force = false): Promise<string> {
    if (!force && cached && now() < cached.expiresAt - 60_000) return cached.token; // refresh 60 s early
    const res = await fetchImpl(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: opts.scope ?? 'query' }).toString(),
    });
    if (!res.ok) throw new Error(`Token request failed (${res.status}): check RAG_CLIENT_ID / RAG_CLIENT_SECRET`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }

  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token(retried)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return call(method, path, body, true); // e.g. key rotated
    if (res.status === 404) throw new NotFoundError('Not found');
    if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    listCollections: async () => (await call<{ collections: never[] }>('GET', '/collections')).collections,
    listDocuments: async (id) => (await call<{ documents: never[] }>('GET', `/collections/${id}/documents`)).documents,
    search: (id, query, { topK, mode }) =>
      call<{ mode: RetrievalMode; chunks: RetrievedChunk[] }>('POST', `/collections/${id}/search`, { query, topK, mode }),
    ask: (id, question) =>
      call<{ answer: string; refused: boolean; citations: Citation[] }>('POST', `/collections/${id}/query`, { question }),
    getChunk: async (chunkId) => {
      try {
        return await call('GET', `/chunks/${chunkId}`);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
  };
}
