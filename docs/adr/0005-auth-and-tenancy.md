# ADR 0005: OAuth2 client credentials, RS256 JWTs and row-level security

**Status:** accepted

## Context
API consumers are services (B2B, machine-to-machine), not browsers. Each client may only see
its own collections.

## Decision
- **Client-credentials grant** (RFC 6749 §4.4) at `POST /oauth/token`, accepting
  `client_secret_basic` and `client_secret_post`. Secrets are 256-bit random values stored as
  **argon2id** hashes; unknown client ids are verified against a dummy hash to equalize timing.
- **RS256 access tokens**, 15-minute TTL, `typ: at+jwt`, claims `iss aud sub exp iat jti scope`.
  Public keys at `/.well-known/jwks.json`, `kid` = RFC 7638 thumbprint. Verification pins
  `algorithms: ['RS256']`.
- **Scopes** per route: `documents:write`, `query`.
- **Tenancy in two layers:** the repository filters by tenant in every query, *and* Postgres
  row-level security enforces it. Tenant transactions `SET LOCAL ROLE rag_app` (a least-privilege
  role with no access to `clients`) and set `app.client_id`. The ml service does the same for writes.
- Another tenant's collection returns **404, not 403**, so its existence isn't revealed.

## Consequences
- Stateless verification: no database hit per request; any service with the JWKS can verify.
- Revocation is mostly "wait for expiry" (15 min); `jti` allows a denylist if needed.
- Every tenant query runs in a short transaction (three extra round trips) — the price of RLS
  with connection pooling. Session-level settings on pooled connections would leak across tenants.

## Alternatives considered
- **HS256:** every verifier would hold the signing secret.
- **Opaque tokens + introspection:** instant revocation, but a lookup on every request.
- **API keys sent on every request:** simpler, but the long-lived secret travels constantly
  and can't carry scopes or expiry.
- **Authorization code + PKCE:** for user-facing apps with a browser; there was no user when this
  was decided. Added later for people delegating access: see [ADR 0010](0010-authorization-code-pkce.md).
