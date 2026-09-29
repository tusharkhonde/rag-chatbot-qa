# MCP integration

The RAG service is also a **Model Context Protocol (MCP) server**. That means any MCP-capable AI application, such as Claude Code, Claude Desktop, MCP Inspector or an agent framework, can discover and use it: list collections, search documents, read chunks and get grounded answers, with no custom integration code.

- [What MCP is](#what-mcp-is)
- [What this server exposes](#what-this-server-exposes)
- [Architecture: one server, two transports](#architecture-one-server-two-transports)
- [Authorization for remote MCP](#authorization-for-remote-mcp)
- [Connecting clients](#connecting-clients)
- [Security considerations](#security-considerations)
- [Design choices and alternatives](#design-choices-and-alternatives)
- [Testing](#testing)

## What MCP is

Before MCP, connecting an AI app to a tool meant writing a custom integration for each pair (N apps × M tools). MCP standardizes that interface, much as LSP did for editors and language tooling.

- **Host:** the AI application the user interacts with (e.g. Claude Code).
- **Client:** the host's connection to one server (one client per server).
- **Server:** exposes capabilities. That's this project.
- **Messages:** JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `resources/read`, `prompts/get`, …).
- **Lifecycle:** the client sends `initialize` with its protocol version and capabilities. The server answers with its own capabilities and optional `instructions`. Then normal requests follow.

A server can offer three kinds of capabilities. The difference is **who decides to use them**:

| Primitive | Controlled by | Here |
|---|---|---|
| **Tools** | The **model**: it reads the tool descriptions and decides when to call one | `list_collections`, `list_documents`, `search_documents`, `ask_question` |
| **Resources** | The **application**: data addressed by URI, which the host loads as context | `rag://collections`, `rag://chunks/{chunkId}` (a URI *template*) |
| **Prompts** | The **user**: reusable templates, typically shown as slash commands | `answer_from_docs` |

## What this server exposes

Implementation: [`services/api/src/mcp/server.ts`](../services/api/src/mcp/server.ts).

**Tools** (all annotated `readOnlyHint: true`, so hosts may auto-approve them):

- **`list_collections`**: the collections the caller can access.
- **`list_documents {collection}`**: files and chunk counts.
- **`search_documents {collection, query, top_k=5, mode=hybrid}`**: hybrid retrieval. It returns:
  - the excerpts as text, wrapped in `<excerpt>` delimiters with an "untrusted content" note;
  - `resource_link` items pointing at each chunk (`rag://chunks/{id}`);
  - `structuredContent` (typed results, validated by the declared `outputSchema`) for programmatic clients.
- **`ask_question {collection, question}`**: the full RAG pipeline (local LLM) returns an answer with citations. It's slow on CPU. The server `instructions` tell the host model to prefer `search_documents` and write the answer itself.

**Tool design for LLMs**, which differs from API design for programmers:
- Tools accept a collection **name** as well as an id: models are good with names and bad with UUIDs.
- Descriptions say *when* to use each tool, not just what it does.
- Outputs are bounded (`top_k` ≤ 10) so a tool can't flood the context window.
- A bad argument (e.g. an unknown collection) is returned as a **tool result with `isError: true`** and a message listing the valid names, so the model can correct itself. Protocol errors are reserved for malformed requests.
- Arguments are validated by the input schema before any backend call.

**Resources:**
- `rag://collections`: JSON list.
- `rag://chunks/{chunkId}`: the full text of a chunk with its source label. This is how a host follows a `resource_link` from a search result.

**Prompt:** `answer_from_docs {collection, question}` produces instructions to search, answer only from the excerpts, cite, and admit when the answer isn't there.

## Architecture: one server, two transports

```
                        ┌──────────────── createRagMcpServer(backend) ────────────────┐
                        │ tools · resources · prompts (src/mcp/server.ts)              │
                        └───────────────▲──────────────────────────────▲──────────────┘
                                        │ RagBackend (port)            │
              inProcessBackend(clientId)│                              │httpBackend(credentials)
            repo · retriever · answerer │                              │REST API over HTTP
                                        │                              │
Remote:  MCP client ──HTTP POST /mcp──► api (Fastify)        Local: host ──spawns──► node dist/mcp/stdio.js
         Bearer token (aud = …/mcp)     auth hook + scope            stdin/stdout JSON-RPC   own client credentials
```

The server definition depends only on the `RagBackend` interface ([`src/mcp/backend.ts`](../services/api/src/mcp/backend.ts)), a *ports and adapters* design. Two adapters:

| | Streamable HTTP (remote) | stdio (local) |
|---|---|---|
| Entry point | `POST /mcp` in the API ([`routes/mcp.ts`](../services/api/src/routes/mcp.ts)) | `dist/mcp/stdio.js` ([`mcp/stdio.ts`](../services/api/src/mcp/stdio.ts)) |
| Who starts it | Always running; clients connect over the network | The host launches it as a subprocess |
| Backend | `inProcessBackend`: calls the repository, retriever and answerer directly | `httpBackend`: calls the REST API |
| Authentication | Bearer JWT with `aud = <base>/mcp`, verified per request | Its own client credentials; token cached and refreshed ([`httpBackend.ts`](../services/api/src/mcp/httpBackend.ts)) |
| Tenancy | `req.clientId` from the token → row-level security | The REST API applies it |
| Good for | Agents and services, multiple users, deployment | Claude Code / Claude Desktop on one machine |

**Stateless Streamable HTTP.** Each `POST /mcp` creates a fresh server bound to the caller's tenant, handles one JSON-RPC exchange and closes (`sessionIdGenerator: undefined`, JSON responses).
- **Benefit:** any API replica can serve any request (no sticky sessions, no session store), and the tenant comes from the token on every request.
- **Cost:** the server can't push messages between requests (the GET stream, notifications), which these read-only tools don't need. `GET` and `DELETE /mcp` return 405.
- **The stateful alternative** keeps a session per `Mcp-Session-Id` header, which is needed for server→client streaming and sampling, and requires session affinity or a shared store when scaled out.

**stdio's one rule:** stdout *is* the protocol channel. Anything else printed there corrupts the JSON-RPC stream, so diagnostics go to stderr.

## Authorization for remote MCP

The MCP authorization spec builds on OAuth 2.x. The MCP server is an OAuth **resource server**. This API is also the **authorization server**, and the two roles are published separately, so the authorization server could be moved out (to Okta, Auth0 or Keycloak) without changing MCP clients.

Discovery, as a client performs it ([`src/cli/mcp-smoke.ts`](../services/api/src/cli/mcp-smoke.ts) does exactly this):

```
1. POST /mcp (no token)
   ← 401  WWW-Authenticate: Bearer realm="rag-api",
          resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
2. GET /.well-known/oauth-protected-resource/mcp                       (RFC 9728)
   ← { "resource": "http://localhost:3000/mcp", "authorization_servers": ["http://localhost:3000"], ... }
3. GET /.well-known/oauth-authorization-server                         (RFC 8414)
   ← { "token_endpoint": ".../oauth/token", "jwks_uri": "...", "grant_types_supported": ["client_credentials"], ... }
4. POST /oauth/token  grant_type=client_credentials&scope=query&resource=http://localhost:3000/mcp   (RFC 8707)
   ← { "access_token": "<JWT with aud = http://localhost:3000/mcp>", ... }
5. POST /mcp  Authorization: Bearer <token>   → initialize, tools/list, tools/call ...
```

**Audience binding (RFC 8707 resource indicators)** is the key idea. A token names the one resource it's for:
- A token issued for `/mcp` is **rejected by the REST API**, and a REST token is **rejected by `/mcp`** (both tested).
- A token leaked from one resource can't be replayed against another.
- Requests for an unknown `resource` get `invalid_target`.

**No token passthrough.** The MCP spec forbids an MCP server from forwarding the token it received to another service. That creates a *confused deputy*: the downstream service can't tell who it's really serving, and audience checks become meaningless. In this design:
- The HTTP endpoint never calls another service with the caller's token: it runs in-process.
- The stdio server authenticates to the REST API with **its own** credentials and requests only `scope=query` (least privilege).

**Limitation, stated honestly:** interactive hosts that implement MCP OAuth for *users* (Claude Desktop, Claude Code's remote-server login) use the authorization-code flow with PKCE, often with dynamic client registration. This authorization server supports only client credentials (machine to machine), so:
- For interactive hosts on this machine, use **stdio**.
- The remote endpoint is for services and agents that hold client credentials (or a token passed as a header).
- Adding authorization code + PKCE is the path to letting users connect remotely.

## Connecting clients

First, create a query-only client for MCP use. This is least privilege: the server only reads.

```bash
docker compose exec api node dist/cli/create-client.js --name mcp --scopes query
```

**Claude Code (stdio, recommended).** Nothing runs on the host: the host launches the server inside the API container through `docker compose exec -T`.

```bash
claude mcp add rag-docs \
  -e RAG_CLIENT_ID=<client_id> -e RAG_CLIENT_SECRET=<client_secret> \
  -- docker compose -f /absolute/path/to/docker-compose.yml exec -T \
     -e RAG_CLIENT_ID -e RAG_CLIENT_SECRET api node dist/mcp/stdio.js
```

Then ask Claude Code something like *"Using rag-docs, what does the Nimbus runbook say about under-replicated partitions?"*. It will call `search_documents` and cite the excerpts. `/mcp` inside Claude Code shows the server's status and tools. Note that `claude mcp add -e` stores the secret in your Claude Code configuration, which is another reason to give this client only the `query` scope.

**Claude Code over HTTP with a static token** (it expires after 15 minutes, so this is only for experiments):

```bash
TOKEN=$(curl -s -u "$ID:$SECRET" -d grant_type=client_credentials -d scope=query \
  -d resource=http://localhost:3000/mcp localhost:3000/oauth/token | jq -r .access_token)
claude mcp add --transport http rag-docs-http http://localhost:3000/mcp --header "Authorization: Bearer $TOKEN"
```

**MCP Inspector** (a browser UI for poking at any MCP server; runs on the host, needs Node):

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: http://localhost:3000/mcp · Header: Authorization: Bearer <MCP token>
```

**Smoke test of both transports:**

```bash
docker compose exec -T -e RAG_CLIENT_ID=<id> -e RAG_CLIENT_SECRET=<secret> api \
  node dist/cli/mcp-smoke.js --collection acme-demo --query "NimbusUnderReplicated"
```

## Security considerations

- **Tool results are an injection channel.** Document text flows straight into the host model's context. A malicious document could say "ignore previous instructions and…". Mitigations:
  - Excerpts are delimited, and any delimiter tags inside them are stripped.
  - Every result starts with an explicit untrusted-content note.
  - All tools are read-only, so the worst case is misleading text, not an action. Hosts should still keep human approval for any *write* tools in the same session.
- **Tool poisoning:** a malicious server can hide instructions in tool *descriptions*. As a server author, keep descriptions factual. As a user, review a third-party server's tool descriptions before connecting it.
- **Least privilege:** MCP clients get `query` only; the stdio server asks for `scope=query` even if its client holds more.
- **Tenant isolation is unchanged:** every MCP call ends up in the same tenant-scoped repository calls under row-level security as the REST API.
- **Local HTTP servers and DNS rebinding:** an unauthenticated MCP server bound to localhost can be reached by a malicious web page via DNS rebinding. That's why the spec says to validate `Origin`. This endpoint requires a bearer token on every request, which a web page can't obtain.

## Design choices and alternatives

| Choice | Alternative | Why |
|---|---|---|
| MCP server inside the API process (HTTP) | Separate MCP service calling the REST API | In-process reuses auth, RLS and the retriever with no extra hop, and avoids forwarding tokens between services |
| stdio server calls the REST API | stdio server connects to Postgres directly | Keeps a single enforcement point for auth and tenancy; the stdio process holds only API credentials |
| Stateless Streamable HTTP | Stateful sessions (`Mcp-Session-Id`) | Horizontal scaling without sticky sessions; no server-push features needed |
| Search tool as the default path | Only `ask_question` | The host model (often stronger than the local 7B) writes the answer from excerpts in seconds; `ask_question` stays available for a self-contained answer |
| Audience-bound tokens per resource | One token for everything | Limits the blast radius of a leaked token; required by the MCP authorization spec |

## Testing

- [`test/unit/mcp-server.test.ts`](../services/api/test/unit/mcp-server.test.ts): a real MCP `Client` connected to the server through the SDK's **in-memory transport pair**. It covers tool listing and annotations, name resolution, excerpt delimiting and resource links, recoverable tool errors, schema validation, resources, templates and prompts.
- [`test/unit/mcp-http.test.ts`](../services/api/test/unit/mcp-http.test.ts): `/mcp` over HTTP. It covers the 401 challenge with `resource_metadata`, audience binding in both directions, JSON-RPC `initialize` / `tools/list` / `tools/call`, stateless 405s, the discovery metadata, and `invalid_target`.
- [`test/unit/mcp-http-backend.test.ts`](../services/api/test/unit/mcp-http-backend.test.ts): token caching, early refresh, retry after a 401, least-privilege scope.
- The integration test for `repo.getChunk` checks that another tenant can't read a chunk by id.
