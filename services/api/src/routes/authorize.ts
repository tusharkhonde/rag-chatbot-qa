import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ClientStore } from '../auth/clients.js';
import type { AuthKV } from '../auth/kv.js';
import { consentPage, errorPage, loginPage, pageHeaders } from '../auth/pages.js';
import { isValidChallenge } from '../auth/pkce.js';
import { matchRedirectUri } from '../auth/redirect.js';
import { SCOPES, type Scope } from '../auth/tokens.js';
import { SCOPES_BY_ROLE, type UserDirectory } from '../auth/users.js';

/**
 * OAuth 2.0 authorization endpoint (RFC 6749 §4.1) with mandatory PKCE (RFC 7636): a person signs
 * in with their web app account and approves an application's access to the document service.
 *
 *   GET  /oauth/authorize            validate the request, show the sign-in page
 *   POST /oauth/authorize/login      check the password, show the consent page
 *   POST /oauth/authorize/decision   Allow → one-time code, Deny → access_denied; back to the client
 *
 * The API keeps no browser session: each authorization signs in again. The pending request lives
 * in Redis for 10 minutes under a random id, with a CSRF token the forms must echo back.
 */

interface Deps {
  clients: ClientStore;
  users: UserDirectory;
  kv: AuthKV;
  issuer: string;
  baseUrl: string;
  mcpResource: string;
}

/** What the browser's sign-in and consent steps carry forward (server-side, never in the page). */
export interface PendingAuthorization {
  clientId: string; // internal clients.id
  publicClientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: Scope[];
  resource: string | null;
  csrf: string;
  userId?: string;
  userEmail?: string;
  granted?: Scope[];
}

/** What an authorization code stands for, for 60 seconds, until the token endpoint redeems it. */
export interface CodeGrant {
  clientId: string;
  publicClientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scopes: Scope[];
  resource: string | null;
}

export const PENDING_TTL_SECONDS = 600;
export const CODE_TTL_SECONDS = 60;
export const pendingKey = (id: string) => `oauth:authreq:${id}`;
// Codes are stored by hash: a leaked Redis dump doesn't hand out redeemable codes.
export const codeKey = (code: string) => `oauth:code:${createHash('sha256').update(code).digest('hex')}`;

const random = (bytes: number) => randomBytes(bytes).toString('base64url');
const sameSecret = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};
const originOf = (uri: string) => new URL(uri).origin;

type Query = Partial<Record<
  'response_type' | 'client_id' | 'redirect_uri' | 'scope' | 'state' | 'code_challenge' | 'code_challenge_method' | 'resource',
  string
>>;

export const authorizeRoutes: FastifyPluginAsync<Deps> = async (app, { clients, users, kv, issuer, baseUrl, mcpResource }) => {
  const ownOrigin = originOf(baseUrl);

  const page = (reply: FastifyReply, status: number, html: string, formTargets: string[] = []) =>
    reply.code(status).headers(pageHeaders(formTargets)).send(html);

  /** Errors after the redirect URI is verified go back to the client (RFC 6749 §4.1.2.1). */
  function redirectWith(reply: FastifyReply, redirectUri: string, params: Record<string, string | undefined>) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', issuer); // RFC 9207: lets the client detect mix-up attacks
    // 303: the browser follows with a GET, even after the consent form's POST.
    return reply.code(303).header('location', url.toString()).header('cache-control', 'no-store').send();
  }

  // Login CSRF and cross-site form posts: the forms are only ever submitted from our own pages.
  // Browsers may send `Origin: null` (privacy settings, some referrer policies); then the
  // browser-set Sec-Fetch-Site header, which page scripts can't forge, must say same-origin.
  function sameOrigin(req: FastifyRequest) {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') return origin === ownOrigin;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  app.get<{ Querystring: Query }>(
    '/oauth/authorize',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query;
      // Until the client and redirect URI are verified, errors are shown here and NEVER redirected:
      // redirecting to an unverified URI would make this an open redirector that leaks codes.
      const client = q.client_id ? await clients.get(q.client_id) : null;
      if (!client || !client.grantTypes.includes('authorization_code')) {
        return page(reply, 400, errorPage('Unknown application (client_id), or it is not allowed to request user authorization.'));
      }
      const redirectUri = q.redirect_uri ? matchRedirectUri(q.redirect_uri, client.redirectUris) : null;
      if (!redirectUri) return page(reply, 400, errorPage('The redirect_uri is missing or not registered for this application.'));

      const fail = (error: string, description: string) =>
        redirectWith(reply, redirectUri, { error, error_description: description, state: q.state });
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
      if (!q.code_challenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
      if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
      if (!isValidChallenge(q.code_challenge)) return fail('invalid_request', 'Malformed code_challenge');

      const requested = q.scope ? q.scope.split(' ').filter(Boolean) : client.scopes;
      const invalid = requested.filter((s) => !(SCOPES as readonly string[]).includes(s) || !client.scopes.includes(s as Scope));
      if (invalid.length || requested.length === 0) return fail('invalid_scope', `Not allowed: ${invalid.join(' ') || '(none)'}`);
      // RFC 8707: the token's audience. Absent = the REST API; the MCP endpoint is its own resource.
      if (q.resource !== undefined && q.resource !== mcpResource) return fail('invalid_target', `Unknown resource: ${q.resource}`);

      const requestId = random(16);
      const pending: PendingAuthorization = {
        clientId: client.id,
        publicClientId: client.clientId,
        clientName: client.name,
        redirectUri,
        state: q.state,
        codeChallenge: q.code_challenge,
        scopes: requested as Scope[],
        resource: q.resource ?? null,
        csrf: random(32),
      };
      await kv.set(pendingKey(requestId), JSON.stringify(pending), PENDING_TTL_SECONDS);
      return page(reply, 200, loginPage({ requestId, csrf: pending.csrf, clientName: client.name }), [originOf(redirectUri)]);
    },
  );

  type FormBody = { request_id?: string; csrf?: string; email?: string; password?: string; decision?: string };

  async function loadPending(req: FastifyRequest<{ Body: FormBody }>, reply: FastifyReply, take: boolean) {
    if (!sameOrigin(req)) {
      page(reply, 403, errorPage('This form must be submitted from the sign-in page.'));
      return null;
    }
    const id = req.body?.request_id ?? '';
    const raw = id ? await (take ? kv.take(pendingKey(id)) : kv.get(pendingKey(id))) : null;
    if (!raw) {
      page(reply, 400, errorPage('This authorization request has expired or was already used.'));
      return null;
    }
    const pending = JSON.parse(raw) as PendingAuthorization;
    if (!sameSecret(req.body?.csrf ?? '', pending.csrf)) {
      page(reply, 403, errorPage('The form was tampered with or is out of date.'));
      return null;
    }
    return { id, pending };
  }

  app.post<{ Body: FormBody }>(
    '/oauth/authorize/login',
    // The second place passwords are checked (after the web app's own login): same rate limit.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const loaded = await loadPending(req, reply, false);
      if (!loaded) return reply;
      const { id, pending } = loaded;
      const formTargets = [originOf(pending.redirectUri)];

      const user = await users.authenticate(req.body.email ?? '', req.body.password ?? '');
      if (!user) {
        // One generic message for unknown email, wrong password and disabled account.
        req.log.info({ event: 'oauth_login_failed', clientId: pending.publicClientId }, 'authorization sign-in failed');
        return page(
          reply,
          401,
          loginPage({ requestId: id, csrf: pending.csrf, clientName: pending.clientName, email: req.body.email, error: 'Incorrect email or password.' }),
          formTargets,
        );
      }
      if (!user.tenantId) {
        return page(reply, 403, errorPage("Your account isn't linked to an organization yet. Ask an administrator."));
      }

      // A person can only delegate what their own role allows (and only what the client asked for).
      const granted = pending.scopes.filter((s) => SCOPES_BY_ROLE[user.role].includes(s));
      if (granted.length === 0) {
        await kv.take(pendingKey(id));
        return redirectWith(reply, pending.redirectUri, {
          error: 'access_denied',
          error_description: 'Your account cannot grant the requested access',
          state: pending.state,
        });
      }

      // New CSRF token for the consent step, and the request now belongs to this user.
      const next: PendingAuthorization = { ...pending, userId: user.id, userEmail: user.email, granted, csrf: random(32) };
      await kv.set(pendingKey(id), JSON.stringify(next), PENDING_TTL_SECONDS);
      return page(
        reply,
        200,
        consentPage({
          requestId: id,
          csrf: next.csrf,
          clientName: pending.clientName,
          userEmail: user.email,
          scopes: granted,
          resource: pending.resource ?? `${baseUrl} (REST API)`,
          redirectHost: new URL(pending.redirectUri).host,
        }),
        formTargets,
      );
    },
  );

  app.post<{ Body: FormBody }>(
    '/oauth/authorize/decision',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // take(): the pending request is single-use, so a replayed consent POST finds nothing.
      const loaded = await loadPending(req, reply, true);
      if (!loaded) return reply;
      const { pending } = loaded;
      if (!pending.userId || !pending.granted) return page(reply, 400, errorPage('Sign in first.'));

      if (req.body.decision !== 'allow') {
        req.log.info({ event: 'oauth_consent_denied', clientId: pending.publicClientId, userId: pending.userId }, 'consent denied');
        return redirectWith(reply, pending.redirectUri, { error: 'access_denied', error_description: 'The user denied access', state: pending.state });
      }

      const code = random(32); // 256 bits, single use, 60 seconds
      const grant: CodeGrant = {
        clientId: pending.clientId,
        publicClientId: pending.publicClientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        userId: pending.userId,
        scopes: pending.granted,
        resource: pending.resource,
      };
      await kv.set(codeKey(code), JSON.stringify(grant), CODE_TTL_SECONDS);
      req.log.info({ event: 'oauth_consent_granted', clientId: pending.publicClientId, userId: pending.userId, scopes: pending.granted }, 'consent granted');
      return redirectWith(reply, pending.redirectUri, { code, state: pending.state });
    },
  );
};
