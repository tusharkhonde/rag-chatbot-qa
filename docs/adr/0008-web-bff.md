# ADR 0008: Web app authentication with a backend-for-frontend

**Status:** accepted

## Context
The system needs a browser UI for two kinds of people: admins who manage documents and users, and
chat users who only ask questions. The API authenticates machine clients (client credentials);
it has no concept of human users, passwords or browser sessions.

## Decision
- A **backend-for-frontend** (`services/web`, Fastify) serves the React SPA and owns human
  authentication:
  - users in `web_users` (argon2id, NIST-style length-based password policy)
  - login with rate limiting and session-id rotation
  - server-side sessions in Redis (hashed ids, idle and absolute expiry)
  - HttpOnly + SameSite=Lax cookies (`__Host-` prefix and Secure behind HTTPS)
  - CSRF defense: Origin check + a per-session synchronizer token
- The BFF is **one OAuth client of the API** (credentials written by a one-shot compose job) and
  requests **tokens scoped by role**: `query` for chat users, `documents:write query` for admins.
- The SPA and `/api` share one origin (no CORS); chat streams SSE through the BFF.

## Consequences
- No access tokens or client secrets ever reach the browser; XSS can't steal a bearer token.
- Logout and account disabling take effect immediately (server-side sessions).
- Roles are enforced twice: by BFF route guards and by the scope of the API token.
- The BFF is stateful through Redis. Scaling out needs shared Redis, which already exists.
- One organization per deployment. Multi-organization support would map users to per-organization API clients.

## Alternatives considered
- **SPA as a public OAuth client (authorization code + PKCE):**
  - Standards-based, and interactive MCP clients could reuse the same login.
  - But tokens live in the browser, and it needs a full authorization server with a login UI
    and consent: about twice the auth surface.
  - A good follow-up to compare.
- **JWT in localStorage:** readable by any injected script, and can't be revoked before expiry.
- **Stateless signed-cookie sessions:** no Redis needed, but no server-side revocation.
