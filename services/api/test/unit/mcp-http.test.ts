import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ClientStore } from '../../src/auth/clients.js';
import { loadSigningKey } from '../../src/auth/keys.js';
import { createTokenService, type TokenService } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import type { Repo } from '../../src/db/repo.js';
import { createMetrics } from '../../src/observability/metrics.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'fatal', PUBLIC_BASE_URL: 'http://rag.test' });
const MCP = 'http://rag.test/mcp';
let tokens: TokenService;

beforeAll(async () => {
  tokens = createTokenService(await loadSigningKey(await mkdtemp(path.join(tmpdir(), 'rag-keys-'))), {
    issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, ttlSeconds: 900,
  });
});

function setup() {
  const repo = {
    listCollections: vi.fn(async () => [{ id: '11111111-1111-4111-8111-111111111111', name: 'handbook', version: 1, createdAt: '' }]),
  } as unknown as Repo;
  const clients: ClientStore = {
    create: vi.fn(),
    authenticate: vi.fn(async (id, secret) => (secret === 'secret' ? { clientId: 'tenant-1', publicClientId: id, scopes: ['query'] } : null)),
  };
  const app = buildApp({
    config, repo, ml: {} as never, retriever: {} as never, answerer: {} as never, clients, tokens,
    metrics: createMetrics({ hitThreshold: 0.6 }), readinessChecks: {},
  });
  return { app, repo };
}

const principal = { clientId: 'tenant-1', publicClientId: 'rag_x', scopes: ['query' as const] };
const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const mcpHeaders = (token?: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream', // required by the Streamable HTTP spec
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

describe('MCP over Streamable HTTP (/mcp)', () => {
  it('401s without a token and points at the protected-resource metadata (RFC 9728)', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders(), payload: rpc('tools/list') });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer realm="rag-api", resource_metadata="http://rag.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('rejects a REST-API token: tokens are audience-bound to one resource', async () => {
    const { app } = setup();
    const { access_token } = await tokens.issue(principal); // audience = rag-api
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders(access_token), payload: rpc('tools/list') });
    expect(res.statusCode).toBe(401);
  });

  it('and the REST API rejects an MCP token', async () => {
    const { app } = setup();
    const { access_token } = await tokens.issue(principal, { audience: MCP });
    const res = await app.inject({ method: 'GET', url: '/collections', headers: { authorization: `Bearer ${access_token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('speaks JSON-RPC with an MCP-audience token: initialize, tools/list, tools/call', async () => {
    const { app } = setup();
    const { access_token } = await tokens.issue(principal, { audience: MCP });
    const headers = mcpHeaders(access_token);

    const init = await app.inject({
      method: 'POST', url: '/mcp', headers,
      payload: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('rag-docs');

    const list = await app.inject({ method: 'POST', url: '/mcp', headers, payload: rpc('tools/list', {}, 2) });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toContain('search_documents');

    const call = await app.inject({ method: 'POST', url: '/mcp', headers, payload: rpc('tools/call', { name: 'list_collections', arguments: {} }, 3) });
    expect(call.json().result.structuredContent.collections).toEqual([{ id: '11111111-1111-4111-8111-111111111111', name: 'handbook' }]);
  });

  it('is stateless: GET (server stream) and DELETE (session end) are 405', async () => {
    const { app } = setup();
    const { access_token } = await tokens.issue(principal, { audience: MCP });
    const headers = { authorization: `Bearer ${access_token}`, accept: 'text/event-stream' }; // bodiless, as clients send them
    expect((await app.inject({ method: 'GET', url: '/mcp', headers })).statusCode).toBe(405);
    expect((await app.inject({ method: 'DELETE', url: '/mcp', headers })).statusCode).toBe(405);
  });
});

describe('OAuth discovery for MCP clients', () => {
  it('serves protected-resource metadata naming the authorization server', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(res.json()).toMatchObject({ resource: MCP, authorization_servers: ['http://rag.test'], scopes_supported: ['query'] });
  });

  it('serves authorization-server metadata (RFC 8414)', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.json()).toMatchObject({
      issuer: 'http://rag.test',
      token_endpoint: 'http://rag.test/oauth/token',
      jwks_uri: 'http://rag.test/.well-known/jwks.json',
      grant_types_supported: ['client_credentials'],
    });
  });

  it('issues MCP-audience tokens for resource=<mcp url> and rejects unknown resources (RFC 8707)', async () => {
    const { app } = setup();
    const form = (resource: string) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'rag_x', client_secret: 'secret', resource }).toString(),
    });
    const ok = await app.inject({ method: 'POST', url: '/oauth/token', ...form(MCP) });
    const claims = JSON.parse(Buffer.from(ok.json().access_token.split('.')[1], 'base64url').toString());
    expect(claims.aud).toBe(MCP);

    const bad = await app.inject({ method: 'POST', url: '/oauth/token', ...form('https://evil.example/api') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_target');
  });
});
