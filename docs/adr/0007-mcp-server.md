# ADR 0007: Expose retrieval as an MCP server

**Status:** accepted

## Context
AI applications (Claude Code, Claude Desktop, agent frameworks) increasingly integrate tools
through the Model Context Protocol instead of bespoke API clients. The RAG service should be
usable from them, locally and remotely, without weakening authentication or tenant isolation.

## Decision
- **One server definition** (`services/api/src/mcp/server.ts`): tools `list_collections`,
  `list_documents`, `search_documents`, `ask_question`; resources `rag://collections` and the
  template `rag://chunks/{chunkId}`; prompt `answer_from_docs`. It depends only on a
  `RagBackend` port, with two adapters.
- **Streamable HTTP at `POST /mcp`** in the API process, **stateless** (fresh server per request,
  JSON responses), using the in-process backend bound to the token's tenant.
- **stdio entry point** (`dist/mcp/stdio.js`) for local hosts, using an HTTP backend that is an
  ordinary OAuth client of the REST API with its own credentials and `scope=query`.
- **Authorization per the MCP spec:** RFC 9728 protected-resource metadata, RFC 8414
  authorization-server metadata, `resource_metadata` in the 401 challenge, and RFC 8707
  resource indicators so MCP tokens carry `aud = <base>/mcp` and are rejected elsewhere
  (and REST tokens are rejected at `/mcp`).

## Consequences
- Tenancy, RLS, scopes and retrieval are reused unchanged; there is one enforcement point.
- No token passthrough: the HTTP endpoint never forwards the caller's token, and the stdio
  server never receives one from its host.
- Stateless HTTP scales horizontally with no session store, but can't push server-initiated
  messages (not needed for read-only tools).
- Interactive hosts that expect the authorization-code + PKCE flow can't log in remotely,
  because the authorization server supports client credentials only; they use stdio instead.

## Alternatives considered
- **Separate MCP service calling the REST API over HTTP:** an extra hop, and it would need either
  token passthrough (forbidden) or token exchange (RFC 8693) to act for the tenant.
- **Stateful Streamable HTTP sessions:** needed for server→client streaming or sampling, but
  requires sticky sessions or a shared session store.
- **stdio server talking to Postgres directly:** duplicates tenancy enforcement and gives a
  local process database credentials.
