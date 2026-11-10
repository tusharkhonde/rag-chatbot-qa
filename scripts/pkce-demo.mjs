#!/usr/bin/env node
// Authorization code + PKCE, end to end, as a native app would do it (RFC 8252). No dependencies.
//
// 1. Register a public client once (no secret; the redirect is a loopback listener):
//      docker compose exec api node dist/cli/create-client.js --name "PKCE demo" --public \
//        --redirect-uri http://127.0.0.1:8765/callback
// 2. Run:  node scripts/pkce-demo.mjs --client-id rag_...   (opens your browser to sign in)
//
// It then: exchanges the code, calls the API as you, refreshes the token, and shows that reusing
// a spent refresh token is refused and revokes the whole sign-in.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'client-id': { type: 'string' },
    api: { type: 'string', default: 'http://localhost:3000' },
    port: { type: 'string', default: '8765' },
    scope: { type: 'string' },
    resource: { type: 'string' },
    open: { type: 'boolean', default: true },
    'no-open': { type: 'boolean', default: false },
    'url-file': { type: 'string' }, // write the authorization URL here (for automated runs)
    timeout: { type: 'string', default: '300' },
  },
});
if (!args['client-id']) {
  console.error('usage: node scripts/pkce-demo.mjs --client-id <public client id> [--api URL] [--port 8765] [--scope "query"] [--no-open]');
  process.exit(2);
}

const api = args.api.replace(/\/$/, '');
const b64url = (buf) => buf.toString('base64url');
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

async function postForm(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

step('Discover the authorization server (RFC 8414)');
const meta = await (await fetch(`${api}/.well-known/oauth-authorization-server`)).json();
if (!meta.authorization_endpoint || !meta.code_challenge_methods_supported?.includes('S256')) fail('server does not support authorization code + PKCE (S256)');
console.log(`  authorization_endpoint: ${meta.authorization_endpoint}\n  token_endpoint:         ${meta.token_endpoint}`);

step('Create the PKCE verifier and challenge, and a state value');
const verifier = b64url(randomBytes(32)); // stays in this process; only its hash goes to the browser
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16)); // ties the callback to this request (CSRF protection for the client)
console.log(`  code_verifier  (secret, kept here): ${verifier.slice(0, 12)}…\n  code_challenge (sent):              ${challenge}`);

const redirectUri = `http://127.0.0.1:${args.port}/callback`;
const authorizeUrl = new URL(meta.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: 'code', client_id: args['client-id'], redirect_uri: redirectUri, state,
  code_challenge: challenge, code_challenge_method: 'S256', scope: args.scope, resource: args.resource,
})) if (v) authorizeUrl.searchParams.set(k, v);

step('Wait for the browser to come back to the loopback redirect');
const callback = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== '/callback') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Signed in</title><p style="font:16px system-ui;margin:40px">Done. You can close this tab and return to the terminal.</p>');
    server.close();
    resolve(url.searchParams);
  });
  server.listen(Number(args.port), '127.0.0.1', () => {
    console.log(`  listening on ${redirectUri}\n  open this URL to sign in:\n\n  ${authorizeUrl}\n`);
    if (args['url-file']) writeFileSync(args['url-file'], authorizeUrl.toString());
    if (args.open && !args['no-open'] && process.platform === 'darwin') spawn('open', [authorizeUrl.toString()], { stdio: 'ignore' });
  });
  setTimeout(() => reject(new Error('timed out waiting for the browser')), Number(args.timeout) * 1000).unref();
}).catch((e) => fail(e.message));

if (callback.get('error')) fail(`authorization failed: ${callback.get('error')} (${callback.get('error_description') ?? ''})`);
if (callback.get('state') !== state) fail('state mismatch: this callback is not for our request');
if (callback.get('iss') !== meta.issuer) fail(`issuer mismatch (RFC 9207): ${callback.get('iss')}`);
console.log(`  code received, state and iss match`);

step('Exchange the code + verifier for tokens');
const exchange = await postForm(meta.token_endpoint, {
  grant_type: 'authorization_code', code: callback.get('code'), redirect_uri: redirectUri,
  code_verifier: verifier, client_id: args['client-id'],
});
if (exchange.status !== 200) fail(`token exchange failed: ${JSON.stringify(exchange.body)}`);
const first = exchange.body;
const c = claims(first.access_token);
console.log(`  access token: sub (tenant) ${c.sub}, uid (you) ${c.uid}, scope "${c.scope}", aud ${c.aud}, expires in ${first.expires_in}s`);
console.log(`  refresh token: ${first.refresh_token.slice(0, 10)}… (opaque, single use)`);

step('Call the API as you');
const res = await fetch(`${api}/collections`, { headers: { authorization: `Bearer ${first.access_token}` } });
const listing = await res.json();
if (res.status !== 200) fail(`GET /collections → ${res.status} ${JSON.stringify(listing)}`);
console.log(`  GET /collections → 200: ${listing.collections.map((x) => x.name).join(', ') || '(none)'}`);

step('Refresh: a new access token AND a new refresh token (rotation)');
const refreshed = await postForm(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: args['client-id'] });
if (refreshed.status !== 200) fail(`refresh failed: ${JSON.stringify(refreshed.body)}`);
console.log(`  new refresh token: ${refreshed.body.refresh_token.slice(0, 10)}… (the old one is now spent)`);

step('Replay the spent refresh token, as an attacker who copied it would');
const replay = await postForm(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: args['client-id'] });
console.log(`  → ${replay.status} ${replay.body.error}: reuse detected, the whole sign-in is revoked`);
const after = await postForm(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: args['client-id'] });
console.log(`  the newest refresh token now → ${after.status} ${after.body.error}`);
if (replay.status !== 400 || after.status !== 400) fail('expected both refreshes to be refused');

console.log('\n✓ authorization code + PKCE, refresh rotation and reuse detection all behaved as expected');
