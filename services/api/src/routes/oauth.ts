import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ClientStore } from '../auth/clients.js';
import { SCOPES, type Scope, type TokenService } from '../auth/tokens.js';

interface Deps {
  clients: ClientStore;
  tokens: TokenService;
  issuer: string;
  baseUrl: string;
  mcpResource: string;
}

interface TokenRequest {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  resource?: string;
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

export const oauthRoutes: FastifyPluginAsync<Deps> = async (app, { clients, tokens, issuer, baseUrl, mcpResource }) => {
  /**
   * OAuth 2.0 client-credentials grant (RFC 6749 §4.4): machine-to-machine auth, no user involved.
   * The client proves possession of its secret once and gets a short-lived bearer token; the
   * secret itself is never sent on data requests.
   */
  app.post<{ Body: TokenRequest }>(
    '/oauth/token',
    // Brute-force protection on the one endpoint that checks secrets.
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.grant_type !== 'client_credentials') {
        return oauthError(reply, 400, 'unsupported_grant_type', 'Only client_credentials is supported');
      }

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

      const token = await tokens.issue({ ...principal, scopes }, { audience: body.resource });
      // Tokens are credentials: no caching by browsers or proxies (RFC 6749 §5.1).
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(token);
    },
  );

  // RFC 8414 authorization-server metadata: how clients discover the token endpoint and keys.
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send({
      issuer,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: SCOPES,
      response_types_supported: [], // no authorization endpoint: machine-to-machine only
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
