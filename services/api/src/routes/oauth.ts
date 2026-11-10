import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ClientRegistration, ClientStore, GrantType } from '../auth/clients.js';
import type { AuthKV } from '../auth/kv.js';
import { verifyPkce } from '../auth/pkce.js';
import type { RefreshTokenStore } from '../auth/refreshTokens.js';
import { SCOPES, type Scope, type TokenService } from '../auth/tokens.js';
import { SCOPES_BY_ROLE, type UserDirectory } from '../auth/users.js';
import { codeKey, type CodeGrant } from './authorize.js';

interface Deps {
  clients: ClientStore;
  tokens: TokenService;
  issuer: string;
  baseUrl: string;
  mcpResource: string;
  /** The authorization code and refresh token grants need these; without them only client_credentials works. */
  users?: UserDirectory;
  kv?: AuthKV;
  refreshTokens?: RefreshTokenStore;
  refreshTokenTtlSeconds?: number;
}

interface TokenRequest {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  resource?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  token?: string;
}

// RFC 6749 §5.2 error format.
const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });

/** client_secret_basic: Authorization: Basic base64(urlencode(id) ":" urlencode(secret)) — RFC 6749 §2.3.1 */
function parseBasic(header: string | undefined): { id: string; secret: string } | null {
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  try {
    return { id: decodeURIComponent(decoded.slice(0, sep)), secret: decodeURIComponent(decoded.slice(sep + 1)) };
  } catch {
    return null;
  }
}

export const oauthRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { clients, tokens, issuer, baseUrl, mcpResource } = deps;
  const userGrants = deps.users && deps.kv && deps.refreshTokens;
  const refreshTtl = deps.refreshTokenTtlSeconds ?? 30 * 24 * 3600;

  /**
   * Client authentication for the authorization code, refresh and revocation requests.
   * Confidential clients send their secret (Basic or form); public clients only name themselves
   * with client_id. Their proof is PKCE for codes, and possession of the refresh token for refreshes.
   */
  async function authenticateClient(req: FastifyRequest, body: TokenRequest, reply: FastifyReply): Promise<ClientRegistration | null> {
    const basic = parseBasic(req.headers.authorization);
    const id = basic?.id ?? body.client_id;
    const secret = basic?.secret ?? body.client_secret;
    if (!id) {
      oauthError(reply, 401, 'invalid_client', 'Client authentication required');
      return null;
    }
    const client = secret ? await clients.authenticateRegistration(id, secret) : await clients.get(id);
    if (!client || (!secret && client.type !== 'public')) {
      if (basic) reply.header('www-authenticate', 'Basic realm="rag-api"');
      oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
      return null;
    }
    return client;
  }

  const requireGrant = (client: ClientRegistration, grant: GrantType, reply: FastifyReply) => {
    if (client.grantTypes.includes(grant)) return true;
    oauthError(reply, 400, 'unauthorized_client', `This client may not use ${grant}`);
    return false;
  };

  const sendToken = (reply: FastifyReply, token: object) =>
    // Tokens are credentials: no caching by browsers or proxies (RFC 6749 §5.1).
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(token);

  /** RFC 6749 §4.1.3: redeem a one-time authorization code, proving PKCE. */
  async function authorizationCodeGrant(req: FastifyRequest, body: TokenRequest, reply: FastifyReply) {
    const client = await authenticateClient(req, body, reply);
    if (!client || !requireGrant(client, 'authorization_code', reply)) return reply;
    if (!body.code || !body.redirect_uri || !body.code_verifier) {
      return oauthError(reply, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
    }
    // take(): atomic read-and-delete, so a code works exactly once even under concurrent requests.
    const raw = await deps.kv!.take(codeKey(body.code));
    const grant = raw ? (JSON.parse(raw) as CodeGrant) : null;
    // One generic error for every mismatch: don't tell an attacker which check failed.
    if (
      !grant ||
      grant.publicClientId !== client.clientId ||
      grant.redirectUri !== body.redirect_uri ||
      !verifyPkce(body.code_verifier, grant.codeChallenge)
    ) {
      req.log.info({ event: 'oauth_code_rejected', clientId: client.clientId }, 'authorization code rejected');
      return oauthError(reply, 400, 'invalid_grant', 'Invalid, expired or already used authorization code');
    }
    const user = await deps.users!.get(grant.userId);
    if (!user || user.disabled || !user.tenantId) return oauthError(reply, 400, 'invalid_grant', 'The user can no longer authorize access');
    const scopes = grant.scopes.filter((s) => SCOPES_BY_ROLE[user.role].includes(s));

    const access = await tokens.issue(
      { clientId: user.tenantId, publicClientId: client.clientId, scopes, userId: user.id },
      { audience: grant.resource ?? undefined },
    );
    const refresh = client.grantTypes.includes('refresh_token')
      ? await deps.refreshTokens!.issue(
          { clientId: client.id, userId: user.id, scope: scopes.join(' '), resource: grant.resource },
          refreshTtl,
        )
      : undefined;
    req.log.info({ event: 'oauth_token_issued', grant: 'authorization_code', clientId: client.clientId, userId: user.id }, 'token issued');
    return sendToken(reply, { ...access, ...(refresh ? { refresh_token: refresh } : {}) });
  }

  /** RFC 6749 §6 with rotation: each refresh token works once; reuse revokes its family. */
  async function refreshTokenGrant(req: FastifyRequest, body: TokenRequest, reply: FastifyReply) {
    const client = await authenticateClient(req, body, reply);
    if (!client || !requireGrant(client, 'refresh_token', reply)) return reply;
    if (!body.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');

    const rotated = await deps.refreshTokens!.rotate(body.refresh_token, client.id);
    if (!rotated.ok) {
      const level = rotated.reason === 'reused' ? 'warn' : 'info';
      req.log[level]({ event: 'oauth_refresh_rejected', reason: rotated.reason, clientId: client.clientId }, 'refresh token rejected');
      return oauthError(reply, 400, 'invalid_grant', 'Invalid, expired or revoked refresh token');
    }
    const { grant, refreshToken } = rotated;
    // The user is re-checked on every refresh: disabling an account ends delegated access within
    // one access-token lifetime, and the refresh chain is cut now.
    const user = await deps.users!.get(grant.userId);
    if (!user || user.disabled || !user.tenantId) {
      await deps.refreshTokens!.revokeFamilyOf(refreshToken);
      return oauthError(reply, 400, 'invalid_grant', 'The user can no longer authorize access');
    }
    let scopes = grant.scope.split(' ').filter((s): s is Scope => SCOPES_BY_ROLE[user.role].includes(s as Scope));
    if (body.scope) {
      // A refresh may narrow the access token's scope, never widen it (RFC 6749 §6).
      const requested = body.scope.split(' ').filter(Boolean);
      if (requested.some((s) => !scopes.includes(s as Scope))) return oauthError(reply, 400, 'invalid_scope', 'Cannot widen scope on refresh');
      scopes = requested as Scope[];
    }
    const access = await tokens.issue(
      { clientId: user.tenantId, publicClientId: client.clientId, scopes, userId: user.id },
      { audience: grant.resource ?? undefined },
    );
    return sendToken(reply, { ...access, refresh_token: refreshToken });
  }

  app.post<{ Body: TokenRequest }>(
    '/oauth/token',
    // Brute-force protection on the endpoint that checks secrets, codes and refresh tokens.
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body ?? {};
      if (userGrants && body.grant_type === 'authorization_code') return authorizationCodeGrant(req, body, reply);
      if (userGrants && body.grant_type === 'refresh_token') return refreshTokenGrant(req, body, reply);
      if (body.grant_type !== 'client_credentials') {
        return oauthError(reply, 400, 'unsupported_grant_type', `Unsupported grant_type: ${body.grant_type ?? '(missing)'}`);
      }

      /*
       * OAuth 2.0 client-credentials grant (RFC 6749 §4.4): machine-to-machine auth, no user involved.
       * The client proves possession of its secret once and gets a short-lived bearer token; the
       * secret itself is never sent on data requests.
       */

      const basic = parseBasic(req.headers.authorization);
      const id = basic?.id ?? body.client_id;
      const secret = basic?.secret ?? body.client_secret;
      if (!id || !secret) return oauthError(reply, 401, 'invalid_client', 'Client authentication required');

      const principal = await clients.authenticate(id, secret);
      if (!principal) {
        if (basic) reply.header('www-authenticate', 'Basic realm="rag-api"');
        return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
      }

      // Optional down-scoping: a client may ask for fewer scopes than it holds (least privilege
      // for a particular job), never more.
      let scopes = principal.scopes;
      if (body.scope) {
        const requested = body.scope.split(' ').filter(Boolean);
        const invalid = requested.filter((s) => !principal.scopes.includes(s as Scope) || !SCOPES.includes(s as Scope));
        if (invalid.length) return oauthError(reply, 400, 'invalid_scope', `Not allowed: ${invalid.join(' ')}`);
        scopes = requested as Scope[];
      }

      // RFC 8707 resource indicators: the client names the resource it wants to call, and the token's
      // audience is bound to it. A token for /mcp is rejected by the REST API and vice versa, so a
      // token leaked from one can't be replayed against the other. No resource = the REST API.
      if (body.resource !== undefined && body.resource !== mcpResource) {
        return oauthError(reply, 400, 'invalid_target', `Unknown resource: ${body.resource}`);
      }

      return sendToken(reply, await tokens.issue({ ...principal, scopes }, { audience: body.resource }));
    },
  );

  if (userGrants) {
    // RFC 7009 token revocation, for refresh tokens ("sign out" in a client). Always 200, even for
    // unknown tokens, so the endpoint can't be used to test whether a token exists.
    app.post<{ Body: TokenRequest }>(
      '/oauth/revoke',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const body = req.body ?? {};
        const client = await authenticateClient(req, body, reply);
        if (!client) return reply;
        if (body.token) await deps.refreshTokens!.revoke(body.token, client.id);
        return reply.header('cache-control', 'no-store').send({});
      },
    );
  }

  // RFC 8414 authorization-server metadata: how clients discover the endpoints, keys and features.
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send({
      issuer,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      scopes_supported: SCOPES,
      ...(userGrants
        ? {
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            revocation_endpoint: `${baseUrl}/oauth/revoke`,
            grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'], // PKCE is mandatory; plain is not offered
            // 'none' = public clients (no secret), which must use PKCE.
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            authorization_response_iss_parameter_supported: true, // RFC 9207
          }
        : {
            grant_types_supported: ['client_credentials'],
            response_types_supported: [], // no authorization endpoint: machine-to-machine only
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          }),
    }),
  );

  // RFC 9728 protected-resource metadata for the MCP endpoint. MCP clients fetch it (the URL comes
  // from the 401's WWW-Authenticate header) to learn which authorization server issues tokens for it.
  const protectedResource = {
    resource: mcpResource,
    authorization_servers: [issuer],
    scopes_supported: ['query'],
    bearer_methods_supported: ['header'],
    resource_name: 'RAG document Q&A (MCP)',
  };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(protectedResource));
  }

  // Public keys for verifying our tokens. Other services can verify tokens with just this.
  app.get('/.well-known/jwks.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(tokens.jwks()),
  );
};
