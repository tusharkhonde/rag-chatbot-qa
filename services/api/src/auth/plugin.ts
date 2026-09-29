import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidTokenError, type Principal, type Scope } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Internal id (clients.id) of the authenticated tenant. Every data access is scoped by it. */
    clientId: string;
    scopes: Scope[];
  }
  interface FastifyContextConfig {
    /** Scope a route requires; enforced by requireScope. */
    scope?: Scope;
  }
}

const REALM = 'realm="rag-api"';

/**
 * onRequest hook: runs BEFORE the body is parsed, so an unauthenticated 20 MB upload is
 * rejected without reading it. Error responses follow RFC 6750 (Bearer token usage).
 */
export function authenticate(
  verify: (token: string) => Promise<Principal>,
  opts: { resourceMetadataUrl?: string } = {},
) {
  // RFC 9728 §5.1: point clients at the protected-resource metadata, which names the authorization
  // server to get a token from. This is how an MCP client discovers how to authenticate.
  const challenge = opts.resourceMetadataUrl ? `${REALM}, resource_metadata="${opts.resourceMetadataUrl}"` : REALM;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(req.headers.authorization ?? '');
    if (!match) {
      return reply.code(401).header('www-authenticate', `Bearer ${challenge}`).send({ error: 'Missing bearer token' });
    }
    try {
      const principal = await verify(match[1]!);
      req.clientId = principal.clientId;
      req.scopes = principal.scopes;
    } catch (err) {
      if (!(err instanceof InvalidTokenError)) throw err;
      req.log.info({ reason: err.message }, 'rejected access token');
      // Don't echo verification details to the caller; they're in the log.
      return reply
        .code(401)
        .header('www-authenticate', `Bearer ${challenge}, error="invalid_token"`)
        .send({ error: 'Invalid or expired token' });
    }
  };
}

/** preHandler hook: authorization, after authentication. 403 = "we know who you are; not allowed". */
export async function requireScope(req: FastifyRequest, reply: FastifyReply) {
  const required = req.routeOptions.config.scope;
  if (required && !req.scopes.includes(required)) {
    return reply
      .code(403)
      .header('www-authenticate', `Bearer ${REALM}, error="insufficient_scope", scope="${required}"`)
      .send({ error: `Requires scope "${required}"` });
  }
}
