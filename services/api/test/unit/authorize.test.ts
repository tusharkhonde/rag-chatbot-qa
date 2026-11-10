import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ClientRegistration, ClientStore } from '../../src/auth/clients.js';
import { loadSigningKey } from '../../src/auth/keys.js';
import { memoryAuthKV } from '../../src/auth/kv.js';
import { s256, verifyPkce } from '../../src/auth/pkce.js';
import { matchRedirectUri } from '../../src/auth/redirect.js';
import type { RefreshTokenStore } from '../../src/auth/refreshTokens.js';
import { createTokenService, type TokenService } from '../../src/auth/tokens.js';
import type { DirectoryUser, UserDirectory } from '../../src/auth/users.js';
import { loadConfig } from '../../src/config.js';
import { createMetrics } from '../../src/observability/metrics.js';

const ORIGIN = 'http://localhost:3000';
const REDIRECT = 'http://127.0.0.1:8765/callback';
const TENANT = '0b9f1c2e-0000-4000-8000-0000000000aa';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('PKCE (RFC 7636)', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    expect(s256(VERIFIER)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(verifyPkce(VERIFIER, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
  });

  it('rejects a wrong, missing or malformed verifier', () => {
    const challenge = s256(VERIFIER);
    expect(verifyPkce(`${VERIFIER.slice(0, -1)}x`, challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce('too-short', s256('too-short'))).toBe(false);
    expect(verifyPkce(`${VERIFIER} `, s256(`${VERIFIER} `))).toBe(false); // outside the allowed alphabet
  });
});

describe('redirect URI matching', () => {
  const registered = ['http://127.0.0.1:8765/callback', 'https://app.example.com/cb'];
  it('requires an exact match, except the port of a loopback IP (RFC 8252)', () => {
    expect(matchRedirectUri('https://app.example.com/cb', registered)).toBe('https://app.example.com/cb');
    expect(matchRedirectUri('http://127.0.0.1:51234/callback', registered)).toBe('http://127.0.0.1:51234/callback');
    expect(matchRedirectUri('https://app.example.com/cb/../evil', registered)).toBeNull();
    expect(matchRedirectUri('https://app.example.com/cb?x=1', registered)).toBeNull();
    expect(matchRedirectUri('https://evil.example.com/cb', registered)).toBeNull();
    expect(matchRedirectUri('http://127.0.0.1:51234/other', registered)).toBeNull();
    expect(matchRedirectUri('http://localhost:8765/callback', registered)).toBeNull(); // localhost isn't loopback-by-IP
  });
});

// ---------------------------------------------------------------------------- the browser flow

const publicClient: ClientRegistration = {
  id: 'c-public', clientId: 'rag_cli', name: 'Docs CLI', type: 'public',
  redirectUris: [REDIRECT], grantTypes: ['authorization_code', 'refresh_token'], scopes: ['documents:write', 'query'],
};
const serviceClient: ClientRegistration = {
  id: 'c-service', clientId: 'rag_svc', name: 'Service', type: 'confidential',
  redirectUris: [], grantTypes: ['client_credentials'], scopes: ['query'],
};

const people: Record<string, DirectoryUser & { password: string }> = {
  'ada@example.com': { id: 'u-admin', email: 'ada@example.com', name: 'Ada', role: 'admin', disabled: false, tenantId: TENANT, password: 'correct horse battery' },
  'uma@example.com': { id: 'u-user', email: 'uma@example.com', name: 'Uma', role: 'user', disabled: false, tenantId: TENANT, password: 'another long password' },
  'nobody@example.com': { id: 'u-orphan', email: 'nobody@example.com', name: 'No', role: 'user', disabled: false, tenantId: null, password: 'another long password' },
};

function fakeRefreshStore(): RefreshTokenStore & { families: Map<string, { family: string; used: boolean; revoked: boolean }> } {
  const tokens = new Map<string, { family: string; used: boolean; revoked: boolean; grant: Parameters<RefreshTokenStore['issue']>[0] }>();
  let n = 0;
  const families = tokens as never;
  return {
    families,
    async issue(grant) {
      const token = `rt-${++n}`;
      tokens.set(token, { family: token, used: false, revoked: false, grant });
      return token;
    },
    async rotate(token, clientId) {
      const t = tokens.get(token);
      if (!t) return { ok: false, reason: 'unknown' };
      if (t.grant.clientId !== clientId) return { ok: false, reason: 'wrong_client' };
      if (t.revoked) return { ok: false, reason: 'revoked' };
      if (t.used) {
        for (const x of tokens.values()) if (x.family === t.family) x.revoked = true;
        return { ok: false, reason: 'reused' };
      }
      t.used = true;
      const next = `rt-${++n}`;
      tokens.set(next, { family: t.family, used: false, revoked: false, grant: t.grant });
      return { ok: true, grant: t.grant, refreshToken: next };
    },
    async revoke(token) {
      const t = tokens.get(token);
      if (t) for (const x of tokens.values()) if (x.family === t.family) x.revoked = true;
    },
    async revokeFamilyOf(token) {
      const t = tokens.get(token);
      if (t) for (const x of tokens.values()) if (x.family === t.family) x.revoked = true;
    },
  };
}

let tokens: TokenService;
beforeAll(async () => {
  const key = await loadSigningKey(await mkdtemp(path.join(tmpdir(), 'rag-keys-')));
  tokens = createTokenService(key, { issuer: ORIGIN, audience: 'rag-api', ttlSeconds: 900 });
});

function setup() {
  const clients: ClientStore = {
    create: vi.fn(),
    authenticate: vi.fn(async () => null),
    authenticateRegistration: vi.fn(async (id, secret) => (id === 'rag_svc' && secret === 's3cret' ? serviceClient : null)),
    get: vi.fn(async (id) => [publicClient, serviceClient].find((c) => c.clientId === id) ?? null),
  };
  const users: UserDirectory = {
    authenticate: vi.fn(async (email, password) => {
      const u = people[email];
      if (!u || u.password !== password || u.disabled) return null;
      const { password: _p, ...user } = u;
      return user;
    }),
    get: vi.fn(async (id) => {
      const u = Object.values(people).find((p) => p.id === id);
      if (!u) return null;
      const { password: _p, ...user } = u;
      return user;
    }),
  };
  const kv = memoryAuthKV();
  const refreshTokens = fakeRefreshStore();
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'fatal' }),
    repo: {} as never, ml: {} as never, retriever: {} as never, answerer: {} as never,
    clients, tokens, users, authKv: kv, refreshTokens,
    metrics: createMetrics({ hitThreshold: 0.6 }),
    readinessChecks: {},
  });
  return { app, kv, refreshTokens, users };
}
type App = ReturnType<typeof setup>['app'];

const authorizeUrl = (params: Record<string, string | undefined> = {}) => {
  const defaults: Record<string, string> = {
    response_type: 'code', client_id: 'rag_cli', redirect_uri: REDIRECT, state: 'st-123',
    code_challenge: s256(VERIFIER), code_challenge_method: 'S256', scope: 'documents:write query',
  };
  const merged = { ...defaults, ...params };
  const q = new URLSearchParams(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined));
  return `/oauth/authorize?${q}`;
};
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
const form = (app: App, url: string, body: Record<string, string>, origin = ORIGIN) =>
  app.inject({ method: 'POST', url, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });

/** Drive the browser part: authorize → sign in → consent. Returns the redirect Location. */
async function authorize(app: App, opts: { email?: string; password?: string; decision?: string; params?: Record<string, string | undefined> } = {}) {
  const start = await app.inject({ method: 'GET', url: authorizeUrl(opts.params) });
  expect(start.statusCode).toBe(200);
  const requestId = field(start.body, 'request_id');
  const login = await form(app, '/oauth/authorize/login', {
    request_id: requestId, csrf: field(start.body, 'csrf'),
    email: opts.email ?? 'ada@example.com', password: opts.password ?? 'correct horse battery',
  });
  if (login.statusCode !== 200) return { login };
  const decision = await form(app, '/oauth/authorize/decision', { request_id: requestId, csrf: field(login.body, 'csrf'), decision: opts.decision ?? 'allow' });
  return { login, decision, location: new URL(String(decision.headers.location)) };
}

async function exchange(app: App, code: string, extra: Record<string, string> = {}) {
  return form(app, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: 'rag_cli', ...extra });
}

describe('authorization code flow', () => {
  it('signs a user in, asks consent, and redirects back with a code, the state and the issuer', async () => {
    const { app } = setup();
    const { login, location } = await authorize(app);
    expect(login.body).toContain('Authorize Docs CLI?');
    expect(login.body).toContain('Create collections and upload or delete documents');
    expect(location!.origin + location!.pathname).toBe(REDIRECT);
    expect(location!.searchParams.get('state')).toBe('st-123');
    expect(location!.searchParams.get('iss')).toBe(ORIGIN);
    expect(location!.searchParams.get('code')).toMatch(/^[\w-]{43}$/);
  });

  it('exchanges the code (with the PKCE verifier) for a user-bound access token and a refresh token', async () => {
    const { app } = setup();
    const { location } = await authorize(app);
    const res = await exchange(app, location!.searchParams.get('code')!);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'documents:write query', refresh_token: expect.any(String) });
    // sub = the user's tenant (RLS unchanged), uid = the person, client_id = the app.
    expect(await tokens.verify(body.access_token)).toEqual({ clientId: TENANT, publicClientId: 'rag_cli', scopes: ['documents:write', 'query'], userId: 'u-admin' });
  });

  it('a chat user can only delegate what their role allows', async () => {
    const { app } = setup();
    const { location } = await authorize(app, { email: 'uma@example.com', password: 'another long password' });
    const body = (await exchange(app, location!.searchParams.get('code')!)).json();
    expect(body.scope).toBe('query');
  });

  it('a code works once, only for its client, redirect URI and verifier', async () => {
    const { app } = setup();
    const code = (await authorize(app)).location!.searchParams.get('code')!;
    expect((await exchange(app, code, { code_verifier: s256('x'.repeat(43)).padEnd(43, 'a') })).json().error).toBe('invalid_grant');
    // The failed attempt consumed it: codes are single-use even when redemption fails.
    expect((await exchange(app, code)).json().error).toBe('invalid_grant');

    const code2 = (await authorize(app)).location!.searchParams.get('code')!;
    expect((await exchange(app, code2, { redirect_uri: 'http://127.0.0.1:9999/other' })).json().error).toBe('invalid_grant');
    const code3 = (await authorize(app)).location!.searchParams.get('code')!;
    expect((await exchange(app, code3)).statusCode).toBe(200);
    expect((await exchange(app, code3)).json().error).toBe('invalid_grant'); // replay
  });

  it('a confidential client must authenticate, and may not use a grant it was not registered for', async () => {
    const { app } = setup();
    const code = (await authorize(app)).location!.searchParams.get('code')!;
    // client_id of a confidential client without its secret: invalid_client
    expect((await exchange(app, code, { client_id: 'rag_svc' })).statusCode).toBe(401);
    const res = await form(app, '/oauth/token', { grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: 'rag_svc', client_secret: 's3cret' });
    expect(res.json().error).toBe('unauthorized_client');
  });

  it('Deny redirects back with access_denied and no code', async () => {
    const { app } = setup();
    const { location } = await authorize(app, { decision: 'deny' });
    expect(location!.searchParams.get('error')).toBe('access_denied');
    expect(location!.searchParams.get('code')).toBeNull();
    expect(location!.searchParams.get('state')).toBe('st-123');
  });

  it('a wrong password re-shows the sign-in page with one generic message', async () => {
    const { app } = setup();
    const { login } = await authorize(app, { password: 'wrong password!!' });
    expect(login.statusCode).toBe(401);
    expect(login.body).toContain('Incorrect email or password.');
    const unknown = await authorize(app, { email: 'who@example.com' });
    expect(unknown.login.body).toContain('Incorrect email or password.');
  });

  it("a user who isn't linked to a tenant can't authorize", async () => {
    const { app } = setup();
    const { login } = await authorize(app, { email: 'nobody@example.com', password: 'another long password' });
    expect(login.statusCode).toBe(403);
  });
});

describe('authorization request validation', () => {
  it('never redirects to an unregistered redirect URI or for an unknown client (open-redirect defence)', async () => {
    const { app } = setup();
    for (const params of [{ redirect_uri: 'https://evil.example.com/cb' }, { client_id: 'nope' }, { client_id: 'rag_svc' }, { redirect_uri: undefined }]) {
      const res = await app.inject({ method: 'GET', url: authorizeUrl(params) });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it('requires PKCE with S256, and returns other errors to the (verified) redirect URI', async () => {
    const { app } = setup();
    const errorOf = async (params: Record<string, string | undefined>) => {
      const res = await app.inject({ method: 'GET', url: authorizeUrl(params) });
      expect(res.statusCode).toBe(303);
      const url = new URL(String(res.headers.location));
      expect(url.searchParams.get('state')).toBe('st-123');
      return url.searchParams.get('error');
    };
    expect(await errorOf({ code_challenge: undefined })).toBe('invalid_request');
    expect(await errorOf({ code_challenge_method: 'plain' })).toBe('invalid_request');
    expect(await errorOf({ code_challenge_method: undefined })).toBe('invalid_request');
    expect(await errorOf({ response_type: 'token' })).toBe('unsupported_response_type'); // no implicit flow
    expect(await errorOf({ scope: 'admin' })).toBe('invalid_scope');
    expect(await errorOf({ resource: 'https://elsewhere.example.com' })).toBe('invalid_target');
  });

  it('serves the pages with a strict CSP that allows posting back to the client only', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: authorizeUrl() });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' http://127.0.0.1:8765");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.body).not.toContain('<script');
  });

  it('rejects cross-site form posts, bad CSRF tokens and replayed consent', async () => {
    const { app } = setup();
    const start = await app.inject({ method: 'GET', url: authorizeUrl() });
    const base = { request_id: field(start.body, 'request_id'), email: 'ada@example.com', password: 'correct horse battery' };
    expect((await form(app, '/oauth/authorize/login', { ...base, csrf: field(start.body, 'csrf') }, 'https://evil.example.com')).statusCode).toBe(403);
    expect((await form(app, '/oauth/authorize/login', { ...base, csrf: 'forged' })).statusCode).toBe(403);
    const login = await form(app, '/oauth/authorize/login', { ...base, csrf: field(start.body, 'csrf') });
    const consent = { request_id: base.request_id, csrf: field(login.body, 'csrf'), decision: 'allow' };
    expect((await form(app, '/oauth/authorize/decision', consent)).statusCode).toBe(303);
    expect((await form(app, '/oauth/authorize/decision', consent)).statusCode).toBe(400); // single use
  });

  it('accepts a same-origin post that carries Origin: null only when Sec-Fetch-Site says same-origin', async () => {
    const { app } = setup();
    const post = async (headers: Record<string, string>) => {
      const start = await app.inject({ method: 'GET', url: authorizeUrl() });
      return app.inject({
        method: 'POST', url: '/oauth/authorize/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        payload: new URLSearchParams({ request_id: field(start.body, 'request_id'), csrf: field(start.body, 'csrf'), email: 'ada@example.com', password: 'correct horse battery' }).toString(),
      });
    };
    expect((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(403);
  });

  it('can skip straight to consent? No: the decision endpoint requires a signed-in request', async () => {
    const { app } = setup();
    const start = await app.inject({ method: 'GET', url: authorizeUrl() });
    const res = await form(app, '/oauth/authorize/decision', { request_id: field(start.body, 'request_id'), csrf: field(start.body, 'csrf'), decision: 'allow' });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('refresh tokens', () => {
  async function signedIn(app: App) {
    const { location } = await authorize(app);
    return (await exchange(app, location!.searchParams.get('code')!)).json() as { access_token: string; refresh_token: string };
  }
  const refresh = (app: App, token: string, extra: Record<string, string> = {}) =>
    form(app, '/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: 'rag_cli', ...extra });

  it('rotates: each refresh returns a new access token and a new refresh token', async () => {
    const { app } = setup();
    const first = await signedIn(app);
    const res = await refresh(app, first.refresh_token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refresh_token).not.toBe(first.refresh_token);
    expect((await tokens.verify(body.access_token)).userId).toBe('u-admin');
  });

  it('reusing a spent refresh token is refused, and kills the newer one too', async () => {
    const { app } = setup();
    const first = await signedIn(app);
    const second = (await refresh(app, first.refresh_token)).json().refresh_token;
    expect((await refresh(app, first.refresh_token)).json().error).toBe('invalid_grant'); // reuse detected
    expect((await refresh(app, second)).json().error).toBe('invalid_grant'); // family revoked
  });

  it('may narrow scope but never widen it', async () => {
    const { app } = setup();
    const { location } = await authorize(app, { email: 'uma@example.com', password: 'another long password' });
    const rt = (await exchange(app, location!.searchParams.get('code')!)).json().refresh_token;
    expect((await refresh(app, rt, { scope: 'documents:write query' })).json().error).toBe('invalid_scope');
  });

  it('stops working once the user is disabled', async () => {
    const { app } = setup();
    const first = await signedIn(app);
    people['ada@example.com']!.disabled = true;
    try {
      expect((await refresh(app, first.refresh_token)).json().error).toBe('invalid_grant');
    } finally {
      people['ada@example.com']!.disabled = false;
    }
  });

  it('can be revoked (RFC 7009), and revocation answers 200 even for unknown tokens', async () => {
    const { app } = setup();
    const first = await signedIn(app);
    expect((await form(app, '/oauth/revoke', { token: first.refresh_token, client_id: 'rag_cli' })).statusCode).toBe(200);
    expect((await refresh(app, first.refresh_token)).json().error).toBe('invalid_grant');
    expect((await form(app, '/oauth/revoke', { token: 'unknown', client_id: 'rag_cli' })).statusCode).toBe(200);
  });
});

describe('discovery metadata', () => {
  it('advertises the authorization endpoint, PKCE S256 only, and public clients', async () => {
    const { app } = setup();
    const meta = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(meta).toMatchObject({
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(meta.grant_types_supported).toEqual(['client_credentials', 'authorization_code', 'refresh_token']);
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });
});
