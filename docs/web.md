# Web app: chat UI and admin console

A browser front end for the RAG service with two kinds of users:

- **Admins** create collections, upload documents and manage user accounts.
- **Chat users** ask questions and get streamed, cited answers.

![Chat](images/chat.png)

| Admin: documents | Admin: users |
|---|---|
| ![Admin documents](images/admin-documents.png) | ![Admin users](images/admin-users.png) |

> **"Uploading documents to train the model."** In RAG nothing is trained. Uploading *indexes* a
> document: it's split into chunks, each chunk is embedded, and both are stored for retrieval.
> The model's weights never change; at question time the relevant chunks are put in the prompt.
> That's why a new document is usable within seconds and why every answer can cite its source.

- [Run it](#run-it)
- [Architecture: backend-for-frontend](#architecture-backend-for-frontend)
- [Authentication and sessions](#authentication-and-sessions)
- [CSRF protection](#csrf-protection)
- [Roles and least privilege](#roles-and-least-privilege)
- [Streaming chat](#streaming-chat)
- [Rendering untrusted model output](#rendering-untrusted-model-output)
- [Security headers](#security-headers)
- [Code map](#code-map)
- [Testing](#testing)
- [Bugs found while building it](#bugs-found-while-building-it)
- [Limitations and next steps](#limitations-and-next-steps)

## Run it

```bash
docker compose up --build -d
docker compose logs web | grep -A1 'Initial admin'   # first run: generated admin password, shown once
open http://localhost:8080
```

As the admin: **Admin → Documents** → create a collection → drop PDF, Markdown or text files.
Then **Admin → Users** → create a chat user. Sign in as that user and ask questions in **Chat**.

A fixed admin password can be set with `ADMIN_PASSWORD` (≥ 12 characters) before the first start.

**Lost the admin password?** The generated one is printed only on the first start, and container
logs are discarded whenever the `web` container is recreated (e.g. `docker compose up --build`).
Reset it with the break-glass CLI. It prints a new password and signs the user out of every session:

```bash
docker compose exec web node dist/server/cli/reset-password.js --email admin@example.com
# options: --password <chosen password>   --enable (re-enable a disabled account)
```

It's a CLI rather than an HTTP endpoint on purpose: it requires shell access to the container,
the same trust level as reading the logs the original password was printed to.

More users can also be created from the command line:

```bash
docker compose exec web node dist/server/cli/create-user.js --email ana@example.com --name Ana --role user
```

Development with hot reload, against the running stack:

```bash
cd services/web
RAG_API_URL=http://localhost:3000 RAG_CLIENT_ID=… RAG_CLIENT_SECRET=… \
  DATABASE_URL=postgresql://rag:rag@localhost:5432/rag PUBLIC_ORIGIN=http://localhost:5173 \
  npm run dev:server        # BFF on :8080
npm run dev:client          # Vite on :5173, proxies /api to the BFF
```

## Architecture: backend-for-frontend

```
browser: React SPA ──── cookie session ────► web (Fastify BFF) :8080 ─── client-credentials JWT ───► api :3000 ──► RAG
         (no tokens, no secrets)              │ web_users (Postgres, argon2id)     (scope per role)
                                              │ sessions  (Redis)
```

The **BFF (backend-for-frontend)** pattern: the SPA talks only to its own server, which handles
authentication and calls the API on the user's behalf. It's the approach the current OAuth
browser-app guidance recommends, and the reasons are concrete:

- **No tokens in the browser.** Access tokens in `localStorage` or JavaScript memory can be stolen
  by any XSS bug. Here the browser only holds an **HttpOnly** cookie, which JavaScript can't read.
- **Secrets stay server-side.** The API client credentials live in the BFF's environment (written by
  a one-shot compose job, `web-bootstrap`), never in the JavaScript bundle.
- **Instant revocation.** Sessions are server-side, so logout or disabling a user takes effect on the
  next request. A JWT held by the browser would stay valid until it expired.
- **One origin.** The SPA and `/api` are served from the same origin, so there's no CORS configuration
  and cookies stay same-site.

Alternative considered: the SPA as a **public OAuth client** using authorization code + PKCE, with
the API as a full authorization server. It's more standards to learn and it would also let
interactive MCP clients log in, but it puts tokens in the browser and roughly doubles the auth
surface. The BFF was chosen first; code + PKCE is a natural follow-up to compare against.

## Authentication and sessions

**Users** (`web_users`, migration 004; code in [`server/src/users.ts`](../services/web/server/src/users.ts)):
- Passwords are hashed with **argon2id** (memory-hard, 19 MiB, 2 iterations).
- Emails are normalized to lower case, and a database `CHECK` constraint forbids case-variant duplicates.
- **Password policy per NIST SP 800-63B:** at least 12 characters and no composition rules. "One
  digit, one symbol" rules push people toward predictable patterns (`Password1!`); length is what
  actually resists guessing.
- An unknown email still runs an argon2 verification against a dummy hash, so response time doesn't
  reveal which emails have accounts. The error message is identical in both cases.
- The least-privilege database role used for tenant data (`rag_app`) has no access to `web_users`.

**Login** (`POST /api/auth/login`, [`routes/auth.ts`](../services/web/server/src/routes/auth.ts)):
- **Rate limited** to 10 attempts/minute per IP. (A per-account lockout was not used, because it
  lets anyone lock a victim out by guessing wrong on purpose.)
- **Origin checked** (see login CSRF below).
- **Session fixation defense:** any existing session id is destroyed and a fresh one is always issued
  at login, so an attacker can't plant a known session id before the victim signs in.

**Sessions** ([`server/src/sessions.ts`](../services/web/server/src/sessions.ts)):
- The cookie holds an opaque **256-bit random id**. Redis stores the session under **the SHA-256 of
  that id**, so a Redis dump or `MONITOR` output contains no usable ids.
- **Idle timeout** (2 h, sliding: each request extends it) and **absolute timeout** (12 h, however active).
- A per-user index lets an admin **disable an account and revoke all of its sessions** at once.

**Cookie attributes:**

| Attribute | Why |
|---|---|
| `HttpOnly` | JavaScript can't read it, so an XSS bug can't exfiltrate the session |
| `SameSite=Lax` | Not sent on cross-site POSTs (a baseline CSRF defense); still sent when following a link to the app |
| `Secure` (`COOKIE_SECURE=true` behind HTTPS) | Never sent over plain HTTP |
| `__Host-` prefix (with Secure) | The browser rejects the cookie unless it's Secure, `Path=/` and has no `Domain`, so a subdomain can't plant or overwrite it |
| `Path=/`, `Max-Age` = absolute timeout | Scope and lifetime |

## CSRF protection

Cookies are sent automatically, so a malicious site could try to make a signed-in user's browser
send requests to this app (**cross-site request forgery**). There are three layers
([`server/src/auth.ts`](../services/web/server/src/auth.ts)):

1. **SameSite=Lax** cookies: browsers don't attach them to cross-site POSTs.
2. **Origin check:** every state-changing request with an `Origin` header must come from `PUBLIC_ORIGIN`.
3. **Synchronizer token:** each session has a random CSRF token. The SPA receives it from `/api/auth/me`
   or `/login`, keeps it **in memory** (never `localStorage`), and sends it as `X-CSRF-Token` on every
   write. The server compares it in constant time. A cross-site attacker can make the browser send
   the cookie, but can't read the token.

**Login CSRF** is also handled. Without an Origin check on `/login`, a malicious page could sign
the victim into the *attacker's* account, and the victim would then type confidential questions
into it.

## Roles and least privilege

| | Chat user (`user`) | Admin (`admin`) |
|---|---|---|
| List collections, chat | ✓ | ✓ |
| Create collections, upload documents | ✗ 403 | ✓ |
| Manage users | ✗ 403 | ✓ (can't disable themselves) |
| RAG API token scope used | `query` | `documents:write query` |

Roles are enforced in two independent places:

1. **BFF routes** check the session's role (`requireRole('admin')`).
2. **The token the BFF uses depends on the role**
   ([`server/src/apiClient.ts`](../services/web/server/src/apiClient.ts)). A chat user's requests
   carry a `query`-only token, so if a BFF route ever forgot its role check, the RAG API would still
   refuse the write with 403.

Hiding the Admin tab in the UI is only a convenience: every rule is enforced on the server.

**Tenancy:** one web deployment = one organization = one API client, so all of its users share
that tenant's collections (and the API's row-level security isolates it from other tenants).
Multi-organization support would add an organization id to users and map each organization to its
own API client.

## Streaming chat

```
SPA ── POST /api/chat (cookie + CSRF) ──► BFF ── POST /collections/:id/query {stream:true} (JWT) ──► API
    ◄──────────── text/event-stream ──────── piped through unchanged ◄──────────── SSE ─────────────
```

- The BFF passes the API's **Server-Sent Events** through byte for byte (`for await (chunk of
  upstream.body) res.write(chunk)`): it adds authentication, not buffering.
- The browser can't use `EventSource`: it only supports GET, without a body or custom headers, and
  the chat is a POST with a CSRF header. So the SPA reads the `fetch` response stream and parses SSE
  itself ([`client/src/lib/sse.ts`](../services/web/client/src/lib/sse.ts)).
  - Network chunks don't align with messages, so it buffers until a blank line ends each message.
  - It uses a streaming `TextDecoder`, so a multi-byte character split between two chunks isn't
    corrupted (there's a test for exactly that).
- **Stop** aborts the browser's fetch. The BFF sees the connection close and aborts its upstream
  request, and the API aborts the LLM call, so no tokens are generated for nobody.
- The UI shows each phase: "Searching the documents…", then "Found N sources, writing the answer…",
  then the streaming text. On a CPU-only model the first token can take a minute, and a visible
  status keeps the wait understandable.
- Each question is answered on its own; earlier turns aren't sent as context (see limitations).

## Rendering untrusted model output

An answer is shaped by the model **and** by document content, and both are untrusted. A document
containing `<img src=x onerror=…>` could lead the model to repeat it. So answers are **never** passed
to `dangerouslySetInnerHTML`.
[`client/src/lib/renderAnswer.tsx`](../services/web/client/src/lib/renderAnswer.tsx) tokenizes a
small Markdown subset (paragraphs, lists, `code`, **bold**) and the citation markers `[1]` / `[1, 2]`
into React elements. React escapes every string, so any HTML shows up as text (there's a test for this).
Citation markers become buttons that expand the matching source excerpt.

## Security headers

Set with `@fastify/helmet` ([`server/src/app.ts`](../services/web/server/src/app.ts)):
- **Content-Security-Policy:** `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; …`.
  - Scripts and styles may only come from this origin: no inline scripts, no CDNs. Even if an XSS
    payload reached the page, the browser would refuse to run it.
  - This works because the Vite build emits only external `.js` and `.css` files.
- **frame-ancestors 'none'** (and `X-Frame-Options`) prevent clickjacking.
- Plus `nosniff`, `Referrer-Policy`, and cross-origin isolation headers.

## Code map

```
services/web/
  server/src/
    main.ts            wiring; first-run admin bootstrap
    app.ts             Fastify app: helmet/CSP, cookies, rate limit, routes, SPA fallback, error mapping
    config.ts          env (zod); API credentials from env or the bootstrap file
    users.ts           web_users store: argon2id, normalization, password policy
    sessions.ts        server-side sessions in Redis (hashed ids, idle + absolute expiry)
    auth.ts            hooks: load session, require session, Origin + CSRF checks, require role
    apiClient.ts       OAuth client of the RAG API; token per role scope; 401 retry
    routes/auth.ts     login / logout / me
    routes/app.ts      collections, uploads, chat stream, user management
    cli/create-user.ts
  client/src/
    App.tsx            session check, top bar, role-based navigation
    pages/Login.tsx · Chat.tsx · Admin.tsx
    lib/api.ts         fetch wrapper (cookie + CSRF header)
    lib/sse.ts         SSE parser for fetch streams
    lib/renderAnswer.tsx  safe answer rendering with citation buttons
```

## Testing

- **BFF** ([`test/server/app.test.ts`](../services/web/test/server/app.test.ts)):
  - cookie flags
  - identical error for unknown email and wrong password
  - login CSRF (foreign origin)
  - session fixation
  - logout revocation
  - writes without or with a wrong CSRF token, and from a foreign origin
  - chat user blocked from admin routes, and every API call they trigger uses the user role
  - admin upload routed through the admin client
  - disabling a user kills their sessions
  - admins can't disable themselves
  - SSE passthrough
  - the CSP header
- **Units:** per-role token scopes and caching, hashed session keys, absolute expiry, password policy.
- **Client:** the SSE parser (split chunks, CRLF, comments, multi-line data, split UTF-8) and the renderer
  (citations, code, lists, **HTML stays inert**).
- **Integration** (Postgres): argon2id storage, case-insensitive login, duplicate emails, disabled accounts.
- **Manual end to end:** headless Chrome driven through the DevTools protocol, signed in with a real
  session cookie, clicking through chat and admin. That is how the two bugs below were found.

## Bugs found while building it

1. **An effect returning a Promise crashed React.** `useEffect(() => ref.current?.scrollIntoView(...), [...])`
   has an expression body, so it *returns* `scrollIntoView`'s result. Current Chrome's scroll methods
   return a Promise, React treated it as the cleanup function, and the tree crashed on the next render
   ("l is not a function"). Unit tests couldn't see it, because Node has no `scrollIntoView`; only
   a real browser did. Fix: block-bodied effects everywhere.
2. **CSS class collision.** The role badge used class `admin`, which also named the admin page
   container (16 px padding), so the badge rendered as a tall oval. Fix: namespaced `role-admin`.
   It's a small bug, and a good argument for CSS modules or scoped styles in a larger app.

## Limitations and next steps

- **Single-turn chat.** Follow-ups like "and for Nimbus?" aren't resolved against earlier turns.
  The standard fix is **query condensation**: ask the LLM to rewrite the follow-up plus recent
  history into a standalone question, then retrieve with that. It costs one more LLM call per
  turn, which is slow on CPU.
- **No password reset or self-service password change** (admins create accounts with an initial
  password); no MFA. Next steps: change-password, then TOTP or WebAuthn passkeys.
- **Uploads are synchronous and sequential** (the browser waits while each file is embedded);
  async ingestion with progress events would suit large PDFs.
- **One organization per deployment** (see Tenancy).
- **No document deletion** yet (the API doesn't expose it).
