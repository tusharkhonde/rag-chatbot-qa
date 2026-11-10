# ADR 0010: Authorization code + PKCE for people, with rotating refresh tokens

**Status:** accepted (extends ADR 0005, which covered machine clients only)

## Context
ADR 0005 chose client credentials because every consumer was a service. Since then the web app
added people (`web_users`, ADR 0008), and there are applications that should act *for a person*:
a CLI, a desktop app, a remote MCP host. Client credentials can't do that. The application would
need a secret (which a CLI or desktop app can't keep), and it would act as itself with fixed
scopes, not as a user with that user's role.

## Decision
- **Authorization endpoint** (`GET /oauth/authorize`) with server-rendered sign-in and consent
  pages. People sign in with their web-app account. The API keeps no browser session, so each
  authorization signs in again. Pending requests (10 min) live in Redis with a CSRF token.
- **PKCE is mandatory, S256 only.** `plain` and requests without a challenge are refused.
- **Public clients** (`client_type = public`, no secret) authenticate at the token endpoint with
  `client_id` alone. Their proof is PKCE for codes and possession of the refresh token for refreshes.
  Confidential clients may use the flow too (with their secret).
- **Exact redirect URIs**, pre-registered. The one exception is the port of a loopback IP
  (RFC 8252 §7.3). Until the client and redirect URI are verified, errors are shown on our own
  page and never redirected (no open redirector). Redirects carry `iss` (RFC 9207).
- **Codes:** 256-bit, single use (`GETDEL`), 60 s, stored by hash, bound to client, redirect URI,
  challenge, user, scopes and resource.
- **Tokens for a person:** `sub` stays the **tenant** (the user's `web_users.tenant_id`), so
  row-level security, caching and every route work unchanged. A new `uid` claim names the person.
  Scopes = requested ∩ client's ∩ the user's role (admin: `documents:write query`, user: `query`).
  `resource` binds the audience exactly as for client credentials (REST API or `/mcp`).
- **Refresh tokens:** opaque, stored as SHA-256, rotated on every use, with an absolute 30-day
  family lifetime. Reusing a spent token revokes the whole family (RFC 9700 reuse detection).
  The user is re-checked on every refresh. `POST /oauth/revoke` (RFC 7009) revokes a family.
- **Web users get a tenant:** migration 006 adds `web_users.tenant_id`, and the web app links its
  users to the tenant of its own API client, so a person sees the same collections everywhere.

## Consequences
- An application can act as a specific person, limited by that person's role, without ever
  seeing their password, and the person can say no.
- Disabling a user stops delegated access at the next refresh; outstanding access tokens live
  out their 15 minutes (same trade-off as ADR 0005).
- The auth surface roughly doubles: login and consent pages, CSRF, rate limits, code and
  refresh-token state. This is exactly why ADR 0008 kept the web app's own login in the BFF.
- Clients must be registered by an operator (`create-client --public --redirect-uri …`).

## Alternatives considered
- **Dynamic client registration (RFC 7591):** lets apps register themselves, which interactive
  MCP hosts expect. It needs registration policy (who may register, rate limits, cleanup of
  abandoned clients). Deferred; this project registers clients with the CLI.
- **Implicit flow / tokens in the redirect:** deprecated (OAuth 2.1); tokens leak via history and referrers.
- **Resource owner password grant:** the app would see the user's password; removed in OAuth 2.1.
- **`sub` = the user:** more conventional, but every data access is scoped by `sub` today.
  Keeping `sub` as the tenant and adding `uid` changed no route, query or cache key.
- **A session at the authorization server (SSO):** skips the sign-in page on repeat
  authorizations, but needs a second cookie-based session system. Not worth it for this scope.
- **An external authorization server (Keycloak, Auth0, Okta):** the production answer. The
  resource side only depends on the JWKS and metadata, so it can be swapped later.
