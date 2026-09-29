import { describe, expect, it, vi } from 'vitest';
import { httpBackend } from '../../src/mcp/httpBackend.js';

function fakeApi() {
  let tokenCount = 0;
  let rejectNext = false;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === '/oauth/token') {
      tokenCount++;
      expect(String(init?.body)).toContain('scope=query'); // least privilege
      return Response.json({ access_token: `t${tokenCount}`, expires_in: 900 });
    }
    if (rejectNext) {
      rejectNext = false;
      return new Response('{}', { status: 401 });
    }
    if (path === '/chunks/missing') return new Response('{}', { status: 404 });
    return Response.json({ collections: [{ id: 'c1', name: 'docs' }], auth: (init?.headers as Record<string, string>).authorization });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, tokens: () => tokenCount, rejectNextCall: () => (rejectNext = true) };
}

describe('httpBackend (stdio MCP server → REST API)', () => {
  it('fetches a token once and reuses it until shortly before expiry', async () => {
    const api = fakeApi();
    let clock = 0;
    const backend = httpBackend({ baseUrl: 'http://api', clientId: 'id', clientSecret: 's', fetchImpl: api.fetchImpl, now: () => clock });
    await backend.listCollections();
    await backend.listCollections();
    expect(api.tokens()).toBe(1);
    clock = 850_000; // within 60 s of the 900 s expiry
    await backend.listCollections();
    expect(api.tokens()).toBe(2);
  });

  it('refreshes the token and retries once after a 401', async () => {
    const api = fakeApi();
    const backend = httpBackend({ baseUrl: 'http://api', clientId: 'id', clientSecret: 's', fetchImpl: api.fetchImpl });
    await backend.listCollections();
    api.rejectNextCall();
    await expect(backend.listCollections()).resolves.toEqual([{ id: 'c1', name: 'docs' }]);
    expect(api.calls).toEqual(['POST /oauth/token', 'GET /collections', 'GET /collections', 'POST /oauth/token', 'GET /collections']);
  });

  it('maps a missing chunk to null', async () => {
    const api = fakeApi();
    const backend = httpBackend({ baseUrl: 'http://api', clientId: 'id', clientSecret: 's', fetchImpl: api.fetchImpl });
    expect(await backend.getChunk('missing')).toBeNull();
  });
});
