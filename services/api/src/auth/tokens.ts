import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import type { SigningKey } from './keys.js';

export const SCOPES = ['documents:write', 'query'] as const;
export type Scope = (typeof SCOPES)[number];

/** The authenticated caller, as established by a verified access token. */
export interface Principal {
  clientId: string; // internal tenant id (clients.id): what every data access is scoped by
  publicClientId: string; // the client_id the caller authenticated with
  scopes: Scope[];
}

export class InvalidTokenError extends Error {}

export interface TokenService {
  /** audience defaults to the REST API; pass a resource (e.g. the MCP endpoint) to bind the token to it. */
  issue(
    principal: Principal,
    opts?: { audience?: string },
  ): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; scope: string }>;
  /** Verifies for one audience only: a token issued for another resource is rejected. */
  verify(token: string, audience?: string): Promise<Principal>;
  jwks(): JSONWebKeySet;
}

export function createTokenService(
  key: SigningKey,
  opts: { issuer: string; audience: string; ttlSeconds: number },
): TokenService {
  const jwks: JSONWebKeySet = { keys: [key.publicJwk] };
  const keySet = createLocalJWKSet(jwks);

  return {
    async issue(principal, issueOpts = {}) {
      const scope = principal.scopes.join(' ');
      const token = await new SignJWT({ scope, client_id: principal.publicClientId })
        .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' }) // RFC 9068 access-token type
        .setIssuer(opts.issuer)
        .setAudience(issueOpts.audience ?? opts.audience)
        .setSubject(principal.clientId)
        .setIssuedAt()
        .setExpirationTime(`${opts.ttlSeconds}s`)
        .setJti(randomUUID()) // unique id: enables a denylist if revocation is ever needed
        .sign(key.privateKey);
      return { access_token: token, token_type: 'Bearer', expires_in: opts.ttlSeconds, scope };
    },

    async verify(token, audience = opts.audience) {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer: opts.issuer,
          audience,
          // Pin the algorithm. Never let the token's own header decide how it's verified:
          // that's the classic "alg: none" / RS256→HS256 key-confusion attack.
          algorithms: ['RS256'],
          typ: 'at+jwt',
          clockTolerance: 30,
          requiredClaims: ['sub', 'exp', 'iat', 'jti'],
        });
        const scopes = String(payload.scope ?? '')
          .split(' ')
          .filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
        return { clientId: payload.sub!, publicClientId: String(payload.client_id ?? ''), scopes };
      } catch (err) {
        throw new InvalidTokenError((err as Error).message);
      }
    },

    jwks: () => jwks,
  };
}
