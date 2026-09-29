import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../server/src/apiClient.js';
import { createSessionStore, memoryKV } from '../../server/src/sessions.js';
import { checkPassword, WeakPasswordError } from '../../server/src/users.js';

describe('API client', () => {
  it('requests a query-only token for chat users and a write-scoped one for admins, cached per scope', async () => {
    const scopes: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/oauth/token')) {
        const scope = new URLSearchParams(String(init?.body)).get('scope')!;
        scopes.push(scope);
        return Response.json({ access_token: `tok:${scope}`, expires_in: 900 });
      }
      return Response.json({ collections: [], auth: (init?.headers as Record<string, string>).authorization });
    });
    const client = createApiClient({ baseUrl: 'http://api', clientId: 'id', clientSecret: 's', fetchImpl: fetchImpl as never });
    expect(await client.forRole('user').listCollections()).toMatchObject({ auth: 'Bearer tok:query' });
    expect(await client.forRole('admin').listCollections()).toMatchObject({ auth: 'Bearer tok:documents:write query' });
    await client.forRole('user').listCollections();
    expect(scopes).toEqual(['query', 'documents:write query']);
  });
});

describe('session store', () => {
  it('stores only a hash of the session id', async () => {
    const kv = memoryKV();
    const setSpy = vi.spyOn(kv, 'set');
    const { sid } = await createSessionStore(kv, { idleSeconds: 60, absoluteSeconds: 600 }).create('u1', 'user');
    const key = setSpy.mock.calls[0]![0];
    expect(key).toMatch(/^sess:[0-9a-f]{64}$/);
    expect(key).not.toContain(sid);
  });

  it('expires a session after its absolute lifetime even if it is active', async () => {
    let clock = 0;
    const store = createSessionStore(memoryKV(), { idleSeconds: 60, absoluteSeconds: 600, now: () => clock });
    const { sid } = await store.create('u1', 'user');
    clock = 599_000;
    expect(await store.get(sid)).not.toBeNull();
    clock = 601_000;
    expect(await store.get(sid)).toBeNull();
  });
});

describe('password policy', () => {
  it('enforces length (NIST 800-63B), not composition rules', () => {
    expect(() => checkPassword('Short1!')).toThrow(WeakPasswordError);
    expect(() => checkPassword('all lowercase words are fine')).not.toThrow();
  });
});
