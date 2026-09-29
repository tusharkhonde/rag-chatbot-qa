# RAG Document Q&A

A retrieval-augmented generation (RAG) service: upload PDF, Markdown or text documents, then ask
questions and get answers grounded in those documents, with inline citations back to the exact
source sections. It runs entirely locally (one `docker compose up`) with multi-tenant auth,
caching, metrics and an evaluation harness.

```
question ─► embed ─┬─► pgvector HNSW search ──┐
                   └─► Postgres full-text ────┴─► RRF fusion ─► prompt with numbered sources ─► LLM ─► answer [1][2]
```

![Chat UI](docs/images/chat.png)

**Stack:** React + Vite web app with a Fastify backend-for-frontend · TypeScript/Fastify API · Python/FastAPI ingestion service · PostgreSQL 17 + pgvector ·
Redis · Ollama (`qwen2.5:7b` for answers, `nomic-embed-text` for embeddings) · Docker Compose

## Highlights

- **Hybrid retrieval:** HNSW vector search and weighted full-text search run concurrently and
  are fused with Reciprocal Rank Fusion, so both paraphrases and exact identifiers are found.
- **Grounded answers with verified citations:** numbered, delimited sources; a fixed refusal
  when the answer isn't in the documents; citation markers are mapped back to chunks and
  hallucinated source numbers are detected.
- **Token-aware, structure-aware chunking:** chunks follow headings/pages (one citation
  location each), carry a context header, and can never be silently truncated by the model.
- **OAuth2 client credentials → RS256 JWTs** with JWKS, scopes, argon2id secret hashing, rate
  limiting, and **Postgres row-level security** as a second tenancy layer.
- **Caching that invalidates itself:** query embeddings and answers in Redis, keyed on tenant,
  collection version, models and prompt version.
- **Streaming:** answers stream over Server-Sent Events; client disconnects abort generation.
- **Observability:** Prometheus metrics per pipeline stage, token usage, cache and retrieval
  hit-rates; structured logs with request ids; liveness vs readiness probes.
- **Web app:** chat UI for users (streamed answers, clickable citations) and an admin console
  for collections, drag-and-drop uploads and user accounts. A backend-for-frontend keeps
  tokens out of the browser: HttpOnly session cookies, CSRF tokens, argon2id passwords, and
  role-based, least-privilege API tokens.
- **MCP server:** the same retrieval as Model Context Protocol tools, resources and a prompt,
  over **stdio** (for Claude Code / Claude Desktop) and **Streamable HTTP** (`/mcp`) with
  OAuth discovery metadata and audience-bound tokens (RFC 9728 / 8414 / 8707).
- **Evaluation harness:** precision@k, recall@k (hit@k), MRR per retrieval mode, answer quality
  (key-fact coverage, citation accuracy, LLM-as-judge), refusal accuracy and latency percentiles.

## Quickstart

Requirements: Docker with **≥ 10 GB of memory** assigned (Docker Desktop → Settings → Resources).

```bash
docker compose up --build -d     # first run pulls ~5 GB of models (qwen2.5:7b, nomic-embed-text)
curl localhost:3000/ready        # {"status":"ready", ...} once every dependency is up
scripts/demo.sh                  # client → token → upload samples → search → streamed answers
```

**Web app:** open <http://localhost:8080> and sign in as the initial admin. On first start the
password is generated and printed once:

```bash
docker compose logs web | grep -A1 'Initial admin'
```

Create a collection, upload documents (**Admin → Documents**), add chat users (**Admin → Users**),
then chat. Details: [`docs/web.md`](docs/web.md).

> **Performance note:** Docker on macOS can't use the GPU, so the 7B model runs on CPU
> (~2–3 tokens/s, 30–100 s per answer; the first request also loads the model). Answers
> stream, and repeated questions are served from cache in milliseconds. For faster demos set
> `LLM_MODEL=qwen2.5:3b`, or point `LLM_BASE_URL` at any OpenAI-compatible hosted API.

## Using the API

```bash
# 1. Register a client (prints client_id and client_secret once)
docker compose exec api node dist/cli/create-client.js --name my-app --scopes "documents:write query"

# 2. Get an access token (OAuth2 client credentials, HTTP Basic auth)
TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \
  localhost:3000/oauth/token | jq -r .access_token)

# 3. Create a collection and upload documents
COLLECTION=$(curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"handbook"}' localhost:3000/collections | jq -r .id)
curl -H "authorization: Bearer $TOKEN" -F file=@samples/docs/nimbus-queue-runbook.md \
  localhost:3000/collections/$COLLECTION/documents

# 4. Ask (add "stream": true for Server-Sent Events)
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"How long does the message broker keep messages?"}' \
  localhost:3000/collections/$COLLECTION/query
```

| Endpoint | Scope | Purpose |
|---|---|---|
| `POST /oauth/token` | – | Client-credentials grant → 15-min RS256 access token |
| `GET /.well-known/jwks.json` | – | Public signing keys |
| `GET /.well-known/oauth-authorization-server` · `/.well-known/oauth-protected-resource/mcp` | – | OAuth discovery metadata (RFC 8414 / RFC 9728) |
| `POST /collections` · `GET /collections` | `documents:write` · `query` | Manage collections |
| `POST /collections/:id/documents` | `documents:write` | Upload PDF / Markdown / text (idempotent by content hash) |
| `GET /collections/:id/documents` | `query` | List documents and chunk counts |
| `POST /collections/:id/search` | `query` | Retrieval only (`mode`: hybrid / vector / keyword) |
| `POST /collections/:id/query` | `query` | Grounded answer with citations; `stream: true` for SSE |
| `GET /chunks/:id` | `query` | One chunk's full text and source |
| `POST /mcp` | `query` (token `aud` = `…/mcp`) | MCP over Streamable HTTP (stateless JSON-RPC) |
| `GET /health` · `GET /ready` · `GET /metrics` | – | Liveness, readiness, Prometheus metrics |

A real response (qwen2.5:7b on CPU; the question never says "Nimbus", semantic retrieval found it):

```json
{
  "answer": "By default, messages are retained for 72 hours. However, the `telemetry.raw` topic keeps messages for 7 days because reprocessing jobs replay it after decoder upgrades. [1]",
  "citations": [{ "index": 1, "label": "nimbus-queue-runbook.md › Architecture", "chunkId": "90a985d1-…" }],
  "invalidCitations": [],
  "refused": false,
  "cached": false,
  "model": "qwen2.5:7b",
  "usage": { "promptTokens": 818, "completionTokens": 41 },
  "retrieval": { "mode": "hybrid", "topVectorScore": 0.695, "embeddingCached": false },
  "timings": { "embed": 50.9, "vector_search": 5.2, "keyword_search": 8.4, "ttft": 52726.7, "generate": 61728.7, "total": 61803 }
}
```

Timings are in milliseconds: retrieval takes ~60 ms, generation on CPU takes the rest.

## Architecture

```
            ┌───────────────────── Docker Compose network ──────────────────────┐
 client ──► │ api  (TypeScript, Fastify) :3000   ← the only published port      │
   JWT      │   auth · tenancy · caching · retrieval · prompting · SSE · metrics │
            │      │ HTTP           │ SQL (RLS)        │ RESP       │ HTTP       │
            │      ▼                ▼                  ▼            ▼            │
            │  ml (Python)     postgres+pgvector     redis       ollama          │
            │  parse · chunk    chunks, vectors,     embedding   qwen2.5:7b      │
            │  embed · /embed   full-text, tenants   & answer    nomic-embed-    │
            │      └──── writes chunks (RLS) ─┘      caches      text            │
            └────────────────────────────────────────────────────────────────────┘
```

- **api** owns the HTTP edge: OAuth2 token issuance, JWT verification, per-route scopes,
  tenant-scoped data access, hybrid retrieval, prompt construction, streaming, caching, metrics.
- **ml** owns document processing: parsing (pypdf, heading-aware Markdown), chunking, and
  embedding (via Ollama), plus query embedding for the API so both sides use the same model.
  It isn't reachable from outside the compose network, and its writes also run under RLS.
- **postgres** holds tenants, collections, documents and chunks (`vector(768)` + HNSW index,
  generated weighted `tsvector` + GIN index), with row-level security policies.
- **redis** caches query embeddings and answers (LRU, memory-capped, fail-safe).
- **ollama** serves both models; one-shot compose jobs pull them on first start.

### Request flow for `POST /collections/:id/query`

1. `onRequest`: verify the bearer JWT (RS256 pinned, issuer, audience, expiry) *before* the body is read; `preHandler` checks the route's scope.
2. Load the collection under RLS for this tenant (another tenant's id → 404).
3. Answer cache lookup (tenant + collection version + normalized question + models + params).
4. Embed the query (Redis-cached), then run **vector** and **keyword** search concurrently, 20 candidates each; fuse with RRF; keep the top 5.
5. No chunks → refuse without calling the LLM. Otherwise build the prompt: numbered `<source>` blocks within a token budget, grounding and refusal rules, document text treated as untrusted.
6. Stream tokens from the LLM (SSE: `sources` → `delta`… → `done`); parse `[n]` citations; flag invalid ones; cache the result; record metrics and one structured log line.

## Web app

| Chat user | Admin |
|---|---|
| Ask questions; answers stream in with numbered citations that expand to the source excerpt | Everything a chat user can do, plus create collections, upload documents, create and disable users |

```
browser (React SPA) ──HttpOnly session cookie──► web (Fastify BFF) :8080 ──JWT, scope by role──► api :3000
```

- **Sessions:** server-side in Redis (hashed ids, idle and absolute expiry), instantly revocable.
  Session ids are rotated at login (fixation defense).
- **CSRF:** SameSite=Lax cookies, an Origin check, and a per-session token in `X-CSRF-Token`.
- **Roles in two layers:** BFF route checks, *and* chat users' requests carry a `query`-only API
  token, so the API would refuse an upload even if a route check were missing.
- **Streaming:** the BFF passes the API's SSE stream through. The SPA parses it from `fetch`
  (EventSource can't POST), and Stop aborts all the way to the LLM.
- **Rendering:** model output is rendered as React elements, never as HTML, under a strict CSP
  (`script-src 'self'`).

Full guide, including the design alternatives and the bugs found in browser testing: [`docs/web.md`](docs/web.md).

| Admin: documents | Admin: users |
|---|---|
| ![Admin documents](docs/images/admin-documents.png) | ![Admin users](docs/images/admin-users.png) |

## MCP (Model Context Protocol)

The service is also an MCP server, so AI apps like Claude Code can search your collections
directly. Full guide: [`docs/mcp.md`](docs/mcp.md).

| Primitive | Name | Purpose |
|---|---|---|
| Tool | `list_collections` · `list_documents` | Discover what can be searched |
| Tool | `search_documents` | Hybrid search; excerpts with sources, resource links to each chunk |
| Tool | `ask_question` | Full RAG answer with citations (local LLM, slow on CPU) |
| Resource | `rag://collections` · `rag://chunks/{chunkId}` | Collection list; full chunk text |
| Prompt | `answer_from_docs` | "Answer only from this collection, with citations" |

```bash
# A query-only client for MCP (least privilege)
docker compose exec api node dist/cli/create-client.js --name mcp --scopes query

# Claude Code, stdio transport (runs inside the api container; nothing installed on the host)
claude mcp add rag-docs -e RAG_CLIENT_ID=<id> -e RAG_CLIENT_SECRET=<secret> \
  -- docker compose -f "$PWD/docker-compose.yml" exec -T -e RAG_CLIENT_ID -e RAG_CLIENT_SECRET \
     api node dist/mcp/stdio.js

# Both transports end to end, including the OAuth discovery chain for /mcp
docker compose exec -T -e RAG_CLIENT_ID=<id> -e RAG_CLIENT_SECRET=<secret> api \
  node dist/cli/mcp-smoke.js --collection <name> --query "rollback"
```

The HTTP endpoint only accepts tokens issued for it (`resource=http://localhost:3000/mcp` at
the token endpoint → `aud` = the MCP URL). REST tokens are rejected there and MCP tokens are
rejected by the REST API. An unauthenticated request gets a 401 whose `WWW-Authenticate` header
points at the protected-resource metadata, which is how MCP clients discover where to get a token.

## Design decisions

Each has a short decision record in [`docs/adr/`](docs/adr/) with the alternatives considered.

| Decision | Choice | Main tradeoff |
|---|---|---|
| [Vector store](docs/adr/0001-postgres-pgvector.md) | PostgreSQL + pgvector, HNSW | One transactional store with SQL filtering and RLS, vs. a dedicated vector DB's scale-out |
| [Chunking](docs/adr/0002-chunking.md) | Section-bounded, 600/800 tokens, 80 overlap, context headers | Precise citations and no silent truncation, vs. some small chunks |
| [Inference](docs/adr/0003-local-inference-ollama.md) | Ollama in Docker, OpenAI-compatible APIs | Private, free, one command, vs. CPU-only speed on macOS |
| [Retrieval](docs/adr/0004-hybrid-retrieval.md) | Vector + full-text, Reciprocal Rank Fusion | Robust to paraphrase *and* identifiers without score tuning, vs. a cross-encoder's precision |
| [Auth & tenancy](docs/adr/0005-auth-and-tenancy.md) | Client credentials, RS256 JWT, scopes, RLS | Stateless verification, vs. revocation only by expiry |
| [Caching](docs/adr/0006-caching.md) | Versioned keys in Redis | Self-invalidating, tenant-safe, vs. no semantic (similar-question) hits |
| [Web app auth](docs/adr/0008-web-bff.md) | Backend-for-frontend with server-side sessions | No tokens in the browser and instant revocation, vs. a stateful session store |
| [MCP](docs/adr/0007-mcp-server.md) | One server definition, stdio + stateless Streamable HTTP, audience-bound tokens | Reuses auth/RLS in-process and scales without sessions, vs. no server-initiated messages |

## Evaluation

`scripts/eval.sh` runs the harness in a container on the compose network against
[`eval/dataset.jsonl`](eval/dataset.jsonl): 20 answerable questions (each with the expected
source document and key phrases) and 5 unanswerable ones. A retrieved chunk counts as relevant
if it comes from the expected document **and** contains an expected phrase.

```bash
scripts/eval.sh                       # retrieval: all modes, all questions (~10 s)
scripts/eval.sh --generate --limit 5  # plus answer quality on 5 + 5 questions (slow on CPU)
```

Retrieval on the sample corpus (k = 5):

| mode | precision@5 | hit@5 (= recall@5) | MRR |
|---|---|---|---|
| hybrid | 0.200 | 1.000 | 0.942 |
| vector | 0.200 | 1.000 | 0.871 |
| keyword | 0.200 | 1.000 | 0.950 |

Reading the numbers:
- **precision@5 = 0.2** is the ceiling here: each question has one answer-bearing chunk. That's
  why it's reported together with hit@k and MRR.
- **Keyword ≈ hybrid > vector on MRR.** The questions were written from the documents and share
  their vocabulary, which favours keyword search. Hybrid keeps its advantage on paraphrased
  questions ("message broker" → Nimbus Queue).
- **Retrieval confidence overlaps:** unanswerable questions reach a top cosine similarity of 0.70,
  while some answerable ones score 0.56. No similarity threshold separates them, so the refusal
  decision is left to the grounded prompt rather than a score cutoff.

Generation, `--generate --limit 3` (3 answerable + 3 unanswerable questions, qwen2.5:7b on CPU):

| metric | value |
|---|---|
| key-fact coverage (answerable) | 1.00 |
| citation accuracy (cites the expected document) | 1.00 |
| answer ↔ reference similarity (cosine) | 0.83 |
| LLM-as-judge (1–5) | 4.67 |
| correct refusals (unanswerable) / false refusals (answerable) | 1.00 / 0.00 |
| hallucinated citation markers | 0 |
| latency p50 / p95 · time to first token p50 / p95 | 45 s / 106 s · 36 s / 95 s |

The sample is small (CPU inference makes each answer take ~1 minute), and the judge is the same
model as the generator, which biases it upward. Treat these as a smoke test, not a benchmark.

## Observability

- `GET /metrics` (Prometheus): `rag_stage_duration_seconds{stage}` (embed, vector_search,
  keyword_search, ttft, generate, total), `rag_llm_tokens_total{type}`,
  `rag_cache_requests_total{cache,result}`, `rag_retrieval_queries_total{mode,outcome}`,
  `rag_retrieval_top_vector_score`, `rag_answers_total{outcome,cached}`,
  `rag_invalid_citations_total`, HTTP latency by route template, plus process metrics.
- **Retrieval hit-rate** = hits / queries, where a hit means the best cosine similarity is at
  least `RETRIEVAL_HIT_THRESHOLD` (keyword mode: any result).
- `GET /health` is liveness (process only); `GET /ready` checks Postgres, Redis, ml and the LLM in parallel with timeouts.
- Logs are structured JSON (pino) with a request id (`X-Request-Id` honoured and echoed). Each question produces one `rag_query` line with timings, tokens, cache and retrieval confidence, never the question text.

## Tests

```bash
# API (TypeScript): unit tests with fakes, then integration tests against compose Postgres
cd services/api && npm test && npm run test:integration

# ml service (Python), in a container
docker build --target test -t rag-ml-test services/ml && docker run --rm rag-ml-test

# web app: BFF + client unit tests, then Postgres integration tests
cd services/web && npm test && npm run test:integration

# evaluation metric functions
docker run --rm -v "$PWD/eval":/eval -w /eval python:3.12-slim python -m unittest
```

Coverage highlights: chunk boundaries/overlap/limits, parsers (heading paths, PDF pages),
RRF, SQL retrieval on seeded vectors (including cross-collection isolation and the
double-stemming regression), prompt construction and injection escaping, citation parsing,
cache keys (tenant, version), SSE, token forgery (expired, wrong audience/issuer/key,
`alg: none`, HS256 key confusion, tampering), OAuth errors and rate limiting, RLS, and MCP
(a real MCP client over the SDK's in-memory transport, `/mcp` JSON-RPC, audience binding,
discovery metadata, the stdio backend's token refresh).

## Configuration

Every setting has a default; see [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | Ollama / `qwen2.5:7b` / – | Any OpenAI-compatible chat endpoint |
| `EMBEDDINGS_PROVIDER` / `EMBEDDING_MODEL` | `ollama` / `nomic-embed-text` | Or `openai` / `text-embedding-3-small` (re-ingest after switching) |
| `RETRIEVAL_MODE` / `RETRIEVAL_TOP_K` | `hybrid` / `5` | Retriever and chunks per prompt |
| `RETRIEVAL_HIT_THRESHOLD` | `0.6` | Hit-rate metric threshold |
| `METRICS_TOKEN` | unset | Protect `/metrics` with a bearer token |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / generated | Initial web admin, created only when no users exist |
| `WEB_PUBLIC_ORIGIN` / `COOKIE_SECURE` | `http://localhost:8080` / `false` | The web app's origin (CSRF Origin check); set Secure cookies behind HTTPS |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Token issuer and OAuth/MCP discovery URLs; the MCP resource is `<base>/mcp` |

## Project layout

```
db/migrations/        001 schema + HNSW · 002 weighted full-text · 003 row-level security · 004 web users
services/api/src/     auth/ cache/ db/ generation/ mcp/ ml/ observability/ retrieval/ routes/ cli/
services/web/         server/ (Fastify BFF: users, sessions, CSRF, roles, API client) · client/ (React SPA)
services/ml/app/      parsers · chunker · embedder · pipeline · store · main (FastAPI)
eval/                 dataset.jsonl · run_eval.py · metrics.py · reports/
samples/              docs/ (fictional handbook, runbook, FAQ) · queries.md
scripts/              demo.sh · eval.sh
docs/                how-it-works.md · web.md · mcp.md · images/ · adr/ (architecture decision records)
```

## Production next steps

- **Async ingestion:** queue uploads (status `processing` already exists in the schema) so large PDFs don't hold a request open.
- **GPU inference** or a hosted LLM; keep Ollama for local development.
- **Reranking:** a cross-encoder second stage where model sources allow it.
- **Key management:** signing key from a KMS or secret manager with scheduled rotation (the JWKS already supports several keys by `kid`).
- **Tracing:** OpenTelemetry spans across api → ml → Postgres → LLM instead of per-stage timings only.
- **Online evaluation:** sample production answers for LLM-judge scoring; track refusal and citation rates over time.
- **Scale:** partition chunks by tenant or move to a dedicated vector store past tens of millions of vectors.
