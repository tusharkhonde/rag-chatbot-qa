import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createClientStore } from '../../src/auth/clients.js';
import { loadSigningKey } from '../../src/auth/keys.js';
import { memoryAuthKV } from '../../src/auth/kv.js';
import { s256 } from '../../src/auth/pkce.js';
import { createRefreshTokenStore } from '../../src/auth/refreshTokens.js';
import { createTokenService } from '../../src/auth/tokens.js';
import { createUserDirectory } from '../../src/auth/users.js';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { createRepo } from '../../src/db/repo.js';
import { createMetrics } from '../../src/observability/metrics.js';

/** The authorization code flow end to end against real Postgres (Redis replaced by an in-memory KV). */

const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5432/rag');
const clients = createClientStore(pool);
const refreshTokens = createRefreshTokenStore(pool);
const ORIGIN = 'http://localhost:3000';
const REDIRECT = 'http://127.0.0.1:8765/callback';
const VERIFIER = 'it-verifier-' + 'x'.repeat(40);
const stamp = Date.now();
const email = `it-oauth-${stamp}@example.com`;
let tenantId: string;
let tenantPublicId: string;
let cliClientId: string;
let userId: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await migrate(pool, new URL('../../../../db/migrations', import.meta.url).pathname);
  // The tenant (e.g. the web app's own API client) and a person who belongs to it.
  const tenant = await clients.create(`it-oauth-tenant-${stamp}`, ['documents:write', 'query']);
  tenantPublicId = tenant.clientId;
  tenantId = (await pool.query('SELECT id FROM clients WHERE client_id = $1', [tenant.clientId])).rows[0].id;
  userId = (
    await pool.query(
      `INSERT INTO web_users (email, name, password_hash, role, tenant_id) VALUES ($1, 'IT', $2, 'user', $3) RETURNING id`,
      [email, await hash('a long enough password'), tenantId],
    )
  ).rows[0].id;
  await createRepo(pool).createCollection(tenantId, `it-oauth-${stamp}`);
  // The application people sign in to: public, PKCE, loopback redirect.
  cliClientId = (await clients.create(`it-oauth-cli-${stamp}`, ['documents:write', 'query'], { type: 'public', redirectUris: [REDIRECT] })).clientId;

  const key = await loadSigningKey(await mkdtemp(path.join(tmpdir(), 'rag-keys-')));
  const config = loadConfig({ DATABASE_URL: 'unused', LOG_LEVEL: 'fatal' });
  app = buildApp({
    config, repo: createRepo(pool), ml: {} as never, retriever: {} as never, answerer: {} as never,
    clients, tokens: createTokenService(key, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, ttlSeconds: 900 }),
    users: createUserDirectory(pool), authKv: memoryAuthKV(), refreshTokens,
    metrics: createMetrics({ hitThreshold: 0.6 }), readinessChecks: {},
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM web_users WHERE id = $1', [userId]);
  await pool.query('DELETE FROM clients WHERE client_id = ANY($1)', [[tenantPublicId, cliClientId]]);
  await pool.end();
});

const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
const form = (url: string, body: Record<string, string>) =>
  app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });

async function signIn() {
  const q = new URLSearchParams({
    response_type: 'code', client_id: cliClientId, redirect_uri: REDIRECT, state: 's',
    code_challenge: s256(VERIFIER), code_challenge_method: 'S256',
  });
  const start = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
  const request_id = field(start.body, 'request_id');
  const login = await form('/oauth/authorize/login', { request_id, csrf: field(start.body, 'csrf'), email, password: 'a long enough password' });
  const decision = await form('/oauth/authorize/decision', { request_id, csrf: field(login.body, 'csrf'), decision: 'allow' });
  const code = new URL(String(decision.headers.location)).searchParams.get('code')!;
  const res = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: cliClientId });
  expect(res.statusCode).toBe(200);
  return res.json() as { access_token: string; refresh_token: string; scope: string };
}

const refresh = (token: string) => form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: cliClientId });

describe('authorization code + PKCE (Postgres)', () => {
  it("issues a token that reads the user's tenant data, limited to the user's role", async () => {
    const tokens = await signIn();
    expect(tokens.scope).toBe('query'); // client allows write, but the user's role doesn't
    const res = await app.inject({ method: 'GET', url: '/collections', headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().collections.map((c: { name: string }) => c.name)).toEqual([`it-oauth-${stamp}`]);
    const write = await app.inject({ method: 'POST', url: '/collections', headers: { authorization: `Bearer ${tokens.access_token}` }, payload: { name: 'nope' } });
    expect(write.statusCode).toBe(403);
  });

  it('stores refresh tokens only as hashes, rotates them, and revokes the family on reuse', async () => {
    const first = await signIn();
    const { rows } = await pool.query('SELECT token_hash FROM oauth_refresh_tokens WHERE user_id = $1', [userId]);
    expect(rows.every((r) => r.token_hash !== first.refresh_token && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);

    const second = (await refresh(first.refresh_token)).json().refresh_token as string;
    expect(second).toBeTruthy();
    expect((await refresh(first.refresh_token)).json().error).toBe('invalid_grant'); // reuse
    expect((await refresh(second)).json().error).toBe('invalid_grant'); // family revoked
  });

  it('two concurrent refreshes with the same token: exactly one wins', async () => {
    const { refresh_token } = await signIn();
    const results = await Promise.all([refresh(refresh_token), refresh(refresh_token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it("rotation keeps the family's absolute expiry", async () => {
    const { refresh_token } = await signIn();
    await refresh(refresh_token);
    const { rows } = await pool.query(
      `SELECT count(DISTINCT expires_at)::int AS n, count(*)::int AS tokens FROM oauth_refresh_tokens
        WHERE family_id = (SELECT family_id FROM oauth_refresh_tokens ORDER BY created_at DESC LIMIT 1)`,
    );
    expect(rows[0]).toEqual({ n: 1, tokens: 2 });
  });

  it('disabling the user ends delegated access at the next refresh', async () => {
    const { refresh_token } = await signIn();
    await pool.query('UPDATE web_users SET disabled = true WHERE id = $1', [userId]);
    try {
      expect((await refresh(refresh_token)).json().error).toBe('invalid_grant');
    } finally {
      await pool.query('UPDATE web_users SET disabled = false WHERE id = $1', [userId]);
    }
  });

  it('a public client has no secret and cannot use client_credentials (enforced by the schema too)', async () => {
    const { rows } = await pool.query('SELECT secret_hash, client_type FROM clients WHERE client_id = $1', [cliClientId]);
    expect(rows[0]).toEqual({ secret_hash: null, client_type: 'public' });
    await expect(
      pool.query(`UPDATE clients SET grant_types = '{client_credentials}' WHERE client_id = $1`, [cliClientId]),
    ).rejects.toThrow(/clients_public_no_client_credentials|check constraint/);
    const res = await form('/oauth/token', { grant_type: 'client_credentials', client_id: cliClientId });
    expect(res.statusCode).toBe(401);
  });
});
