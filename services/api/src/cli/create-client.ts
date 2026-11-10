/**
 * Register an API client and print its credentials (a confidential client's secret is shown only once).
 *
 *   # a service (client_credentials): acts as itself, and is its own tenant
 *   docker compose exec api node dist/cli/create-client.js --name demo --scopes "documents:write query"
 *
 *   # an app that people sign in to (authorization code + PKCE, no secret): acts for each user
 *   docker compose exec api node dist/cli/create-client.js --name "Docs CLI" --public \
 *     --redirect-uri http://127.0.0.1:8765/callback --scopes "documents:write query"
 */
import { parseArgs } from 'node:util';
import { createClientStore, type GrantType } from '../auth/clients.js';
import { SCOPES, type Scope } from '../auth/tokens.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const USAGE =
  'usage: create-client --name <name> [--scopes "documents:write query"] [--json]\n' +
  '                     [--public] [--redirect-uri <uri>]... [--grant-types authorization_code,refresh_token]';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scopes: { type: 'string', default: SCOPES.join(' ') },
    json: { type: 'boolean', default: false },
    public: { type: 'boolean', default: false },
    'redirect-uri': { type: 'string', multiple: true, default: [] },
    'grant-types': { type: 'string' },
  },
});
const fail = (message: string) => {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
};
if (!values.name) fail('--name is required');

const scopes = values.scopes!.split(' ').filter(Boolean);
const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
if (unknown.length) fail(`unknown scopes: ${unknown.join(', ')} (valid: ${SCOPES.join(', ')})`);

const type = values.public ? 'public' : 'confidential';
const redirectUris = values['redirect-uri']!;
const grantTypes = (values['grant-types']?.split(',').filter(Boolean) ??
  (redirectUris.length ? ['authorization_code', 'refresh_token'] : ['client_credentials'])) as GrantType[];
const VALID: GrantType[] = ['client_credentials', 'authorization_code', 'refresh_token'];
if (grantTypes.some((g) => !VALID.includes(g))) fail(`unknown grant type (valid: ${VALID.join(', ')})`);
if (type === 'public' && grantTypes.includes('client_credentials')) fail('a public client has no secret, so it cannot use client_credentials');
if (grantTypes.includes('authorization_code') && redirectUris.length === 0) fail('authorization_code needs at least one --redirect-uri');
for (const uri of redirectUris) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    fail(`invalid redirect URI: ${uri}`);
  }
  // Redirect URIs carry authorization codes: HTTPS, or plain HTTP only on the loopback interface (RFC 8252).
  if (url!.hash) fail(`redirect URIs can't have a #fragment: ${uri}`);
  if (url!.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url!.hostname)) fail(`use https for non-loopback redirect URIs: ${uri}`);
}

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool, config.MIGRATIONS_DIR);
const creds = await createClientStore(pool).create(values.name!, scopes as Scope[], { type, redirectUris, grantTypes });
await pool.end();

if (values.json) {
  console.log(JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, scopes, client_type: type, redirect_uris: redirectUris, grant_types: grantTypes }));
} else {
  console.log(`client_id:     ${creds.clientId}`);
  if (creds.clientSecret) console.log(`client_secret: ${creds.clientSecret}`);
  console.log(`client_type:   ${type}\ngrant_types:   ${grantTypes.join(' ')}\nscopes:        ${scopes.join(' ')}`);
  if (redirectUris.length) console.log(`redirect_uris: ${redirectUris.join(' ')}`);
  console.log(creds.clientSecret ? '\nStore the secret now: it is hashed and cannot be shown again.' : '\nPublic client: no secret. It must use PKCE.');
}
