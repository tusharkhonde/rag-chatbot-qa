import type { Role } from './users.js';

/**
 * The RAG API scope each role's requests are made with. Roles are enforced in the BFF's routes,
 * AND a chat user's requests carry a token that can't write: if a BFF route check were ever wrong,
 * the API would still refuse the upload (403). Defense in depth via least privilege.
 */
export const SCOPES_BY_ROLE: Record<Role, string> = { admin: 'documents:write query', user: 'query' };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`RAG API responded ${status}`);
  }
}

export interface RagApi {
  listCollections(): Promise<unknown>;
  createCollection(name: string): Promise<unknown>;
  listDocuments(collectionId: string): Promise<unknown>;
  upload(collectionId: string, file: { filename: string; mimeType: string; data: Buffer }): Promise<{ status: number; body: unknown }>;
  /** Starts a streamed answer; the caller pipes the SSE body through. */
  queryStream(collectionId: string, question: string, signal: AbortSignal): Promise<Response>;
}

/** The BFF is one OAuth client of the API; it keeps one cached token per scope set. */
export function createApiClient(opts: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/$/, '');
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`).toString('base64')}`;

  async function token(scope: string, force = false) {
    const cached = tokens.get(scope);
    if (!force && cached && now() < cached.expiresAt - 60_000) return cached.token;
    const res = await fetchImpl(`${base}/oauth/token`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(scope, { token: body.access_token, expiresAt: now() + body.expires_in * 1000 });
    return body.access_token;
  }

  function forRole(role: Role): RagApi {
    const scope = SCOPES_BY_ROLE[role];

    async function send(path: string, init: RequestInit, retried = false): Promise<Response> {
      const res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await token(scope, retried)}` },
      });
      if (res.status === 401 && !retried) return send(path, init, true);
      return res;
    }
    async function json(path: string, init: RequestInit = {}) {
      const res = await send(path, init);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body);
      return body;
    }
    const post = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return {
      listCollections: () => json('/collections'),
      createCollection: (name) => json('/collections', post({ name })),
      listDocuments: (id) => json(`/collections/${encodeURIComponent(id)}/documents`),
      async upload(id, file) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename);
        const res = await send(`/collections/${encodeURIComponent(id)}/documents`, { method: 'POST', body: form });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      queryStream: (id, question, signal) =>
        send(`/collections/${encodeURIComponent(id)}/query`, { ...post({ question, stream: true }), signal }),
    };
  }

  return { forRole };
}

export type ApiClient = ReturnType<typeof createApiClient>;
