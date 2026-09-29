# How it works

A walkthrough of the whole system: what happens to a document and to a question, and every
concept the design relies on. The implementation is explained along the way, the reason behind
each choice, and where it lives in the code. Read it top to bottom once, then use the section
headings as a reference.

- [1. What RAG is and why it exists](#1-what-rag-is-and-why-it-exists)
- [2. The system at a glance](#2-the-system-at-a-glance)
- [3. The life of a document (ingestion)](#3-the-life-of-a-document-ingestion)
- [4. The life of a question (query)](#4-the-life-of-a-question-query)
- [5. Concepts in depth](#5-concepts-in-depth)
  - [5.1 Embeddings and vector similarity](#51-embeddings-and-vector-similarity)
  - [5.2 Chunking](#52-chunking)
  - [5.3 Approximate nearest-neighbour search and HNSW](#53-approximate-nearest-neighbour-search-and-hnsw)
  - [5.4 Full-text search in Postgres](#54-full-text-search-in-postgres)
  - [5.5 Hybrid retrieval and Reciprocal Rank Fusion](#55-hybrid-retrieval-and-reciprocal-rank-fusion)
  - [5.6 Prompting for grounded answers](#56-prompting-for-grounded-answers)
  - [5.7 Prompt injection](#57-prompt-injection)
  - [5.8 Citations and hallucination detection](#58-citations-and-hallucination-detection)
  - [5.9 Streaming with Server-Sent Events](#59-streaming-with-server-sent-events)
  - [5.10 Caching](#510-caching)
  - [5.11 Idempotency and transactions](#511-idempotency-and-transactions)
  - [5.12 Authentication: OAuth2 client credentials and JWTs](#512-authentication-oauth2-client-credentials-and-jwts)
  - [5.13 Multi-tenancy and row-level security](#513-multi-tenancy-and-row-level-security)
  - [5.14 Observability](#514-observability)
  - [5.15 Evaluation](#515-evaluation)
  - [5.16 Containers and Compose](#516-containers-and-compose)
  - [5.17 Testing strategy](#517-testing-strategy)
  - [5.18 MCP: exposing retrieval to AI applications](#518-mcp-exposing-retrieval-to-ai-applications)
- [6. Bugs found while building it](#6-bugs-found-while-building-it)
- [7. Tradeoffs and what changes at scale](#7-tradeoffs-and-what-changes-at-scale)
- [8. Questions this design should be able to answer](#8-questions-this-design-should-be-able-to-answer)

---

## 1. What RAG is and why it exists

A large language model only knows what was in its training data. It doesn't know your
company's runbooks, it has a knowledge cutoff, and when it doesn't know something it tends to
produce a fluent, plausible, wrong answer (a *hallucination*).

**Retrieval-augmented generation** fixes this at question time instead of training time:

1. **Retrieve** the few passages from your documents most likely to contain the answer.
2. **Augment** the prompt with those passages.
3. **Generate** an answer instructed to use only those passages, and to cite them.

Why not fine-tune the model on the documents instead?
- Fine-tuning teaches *style and patterns* well but is unreliable for *facts*: the model still
  can't tell you where a fact came from, and it still hallucinates.
- Documents change daily. RAG picks up a new document the moment it's ingested; fine-tuning
  needs a new training run.
- RAG gives citations (auditability) and per-tenant data isolation for free; a fine-tuned
  model mixes everything it was trained on.

The quality of a RAG system is dominated by **retrieval**. If the right passage isn't in the
prompt, no model can answer correctly; if it is, even a small local model usually can. That's
why most of this project's complexity is in chunking and retrieval, and why the evaluation
measures retrieval separately from generation.

## 2. The system at a glance

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

| Service | Language | Responsibility |
|---|---|---|
| `api` | TypeScript (Fastify) | The public edge: OAuth2 tokens, JWT verification, scopes, tenant-scoped data access, retrieval, prompting, streaming, caching, metrics |
| `ml` | Python (FastAPI) | Document processing: parse, chunk, embed, store. Also embeds queries for the API so both sides use the *same* model |
| `postgres` | pgvector/pg17 | Tenants, collections, documents, chunks; HNSW vector index; full-text index; row-level security |
| `redis` | Redis 7 | Query-embedding cache and answer cache |
| `ollama` | Ollama | Runs the embedding model (`nomic-embed-text`) and the LLM (`qwen2.5:7b`) |

**Why two application services?** Document parsing has the best libraries in Python (pypdf),
while the API edge (auth, streaming, lots of concurrent I/O) suits Node. The rule that decides
the split: the component that embeds documents must also embed queries, because vectors are
only comparable if the same model produced them. So all embedding goes through `ml`.

**Data model** (`db/migrations/001_init.sql`):

```
clients ──< collections ──< documents ──< chunks
 (tenant)    (unit of        (one file,     (text + metadata + vector(768)
              tenancy,        sha256)        + tsvector + embedding_model)
              version)
```

## 3. The life of a document (ingestion)

`POST /collections/:id/documents` with a multipart file.

**1. Authenticate before reading the body.** The auth hook runs in Fastify's `onRequest`
phase, before the body is parsed (`services/api/src/auth/plugin.ts`). An unauthenticated
20 MB upload is rejected without being read. Then `preHandler` checks the route's scope
(`documents:write`).

**2. Check ownership.** The API loads the collection *as the tenant*
(`repo.getCollection`, under row-level security). If it belongs to someone else, it doesn't
exist as far as this tenant is concerned: 404. This check is the tenancy boundary, because the
`ml` service trusts the ids it's given (it still writes under RLS as a second layer).

**3. Forward to `ml`.** The API buffers the file (bounded by the 20 MB multipart limit) and
posts it to `ml /ingest` with the tenant and collection ids (`services/api/src/ml/client.ts`).
Buffering rather than streaming is fine here: `ml` needs the whole file to hash it anyway.

**4. Hash and deduplicate** (`services/ml/app/pipeline.py`). SHA-256 of the bytes. If this
collection already has a document with that hash, return it immediately (`created: false`,
HTTP 200). This cheap check skips the expensive embedding step for re-uploads.

**5. Parse into sections** (`services/ml/app/parsers.py`). A *section* is a run of text that
shares one citation location:
- PDF: one section per page (`{"page": 3}`). Pages without a text layer (scans) are skipped;
  a document with no text at all returns 422.
- Markdown: split at headings, tracking the heading hierarchy as a breadcrumb
  (`{"heading_path": ["Runbook", "Alerts", "NimbusUnderReplicated"]}`). Lines inside code
  fences are never treated as headings.
- Text: one section.

**6. Chunk each section** (`services/ml/app/chunker.py`, section 5.2 explains why):
split into sentence/line atoms, pack them up to ~600 tokens (hard max 800), start each new
chunk with the previous chunk's last ~80 tokens of sentences. Chunks never cross sections,
so each chunk cites exactly one place. Character offsets are kept so the exact source span
can be highlighted.

**7. Add a context header.** Each chunk's *embedding input* is
`"nimbus-queue-runbook > Alerts > NimbusUnderReplicated\n\n<chunk text>"`. A chunk from the
middle of a section often never names its topic ("Restart the follower process…"); the header
puts that context into the vector. The header is also stored as `metadata.context`, where the
keyword index gives it extra weight.

**8. Embed** (`services/ml/app/embedder.py`). All chunks of the document go to Ollama's
`/api/embed` in batches, with the `search_document: ` prefix, `truncate: false` (fail rather
than silently cut), and the result normalized to unit length.

**9. Store atomically** (`services/ml/app/store.py`). One short transaction, as the tenant:
insert the document with `ON CONFLICT (collection_id, sha256) DO NOTHING` → insert all chunks →
`collections.version += 1`. Either all of it happens or none of it does. The version bump is
what invalidates cached answers for this collection (section 5.10).

Note the ordering: the slow step (embedding) happens **before** the transaction opens. A
transaction held open during a multi-second model call would pin a database connection and
its locks the whole time.

## 4. The life of a question (query)

`POST /collections/:id/query` with `{"question": "...", "stream": true}`.

**1. Authenticate and authorize.** Verify the JWT (signature with RS256 pinned, issuer,
audience, expiry, type), then check the `query` scope.

**2. Load the collection as the tenant.** 404 if it isn't theirs.

**3. Answer cache** (`services/api/src/generation/answerer.ts`). The key is a hash of
everything that can change the answer: tenant, collection id, **collection version**,
normalized question (lower-cased, whitespace collapsed, trailing `?` removed), LLM model,
embedding model, retrieval mode, top-k and prompt version. A hit returns in milliseconds.

**4. Retrieve** (`services/api/src/retrieval/retriever.ts`):
- Guard: refuse (409) if the collection was embedded with a different model than the one now
  configured. Comparing vectors across models gives meaningless scores.
- Embed the question (`search_query: ` prefix) via `ml /embed`, cached in Redis by
  `model id + sha256(text)`.
- In parallel: **vector search** (pgvector HNSW, 20 nearest chunks) and **keyword search**
  (Postgres full-text, 20 best matches), both restricted to this collection and running under
  row-level security (`services/api/src/retrieval/search.ts`).
- Fuse the two lists with **Reciprocal Rank Fusion** and keep the top 5.

**5. Short-circuit.** If nothing was retrieved, return the refusal without calling the LLM:
any answer would be invented.

**6. Build the prompt** (`services/api/src/generation/prompt.ts`): a system message with the
rules (answer only from the sources, cite `[n]`, reply exactly "I don't know based on the
provided documents." otherwise, treat sources as untrusted data), and a user message with
numbered `<source id="n" title="doc › section">` blocks followed by the question. Sources are
added in rank order until the context budget is spent, so the least relevant ones are dropped
first.

**7. Stream** (`services/api/src/routes/query.ts`). Server-Sent Events: a `sources` event
first (a UI can show them immediately), then `delta` events as tokens arrive, then `done` with
the full result. If the client disconnects, an `AbortController` cancels the LLM request.

**8. Post-process.** Parse `[n]` markers, map them to chunks, flag numbers that match no
provided source (hallucinated citations), detect refusals, cache the result (never a partial
one from an aborted stream), record metrics, write one structured log line.

## 5. Concepts in depth

### 5.1 Embeddings and vector similarity

An **embedding model** maps text to a fixed-length vector (768 numbers here) such that texts
with similar *meaning* land close together. "How long is data kept in the message broker?" and
"Messages are retained for 72 hours" share almost no words but produce nearby vectors. That
is what lets retrieval find paraphrases.

**Cosine similarity** measures the angle between two vectors: 1 = same direction, 0 =
unrelated. pgvector's `<=>` operator returns cosine *distance* (1 − similarity).

**Normalization.** Every vector is scaled to length 1 (in `embedder.py`). For unit vectors,
cosine similarity equals the dot product, which is cheaper, and scores become comparable
across queries.

**Asymmetric retrieval.** Questions and the passages that answer them are phrased differently.
Many retrieval-trained models expect a task prefix to handle this: nomic-embed-text uses
`search_query: ` for questions and `search_document: ` for passages. Forgetting the prefixes
doesn't error, it just quietly lowers retrieval quality.

**Model identity matters.** Two models, even with the same dimension, produce vectors in
unrelated spaces. So each chunk stores `embedding_model`, the query-embedding cache key
includes the model id, and the retriever refuses to search a collection embedded by a
different model. Switching models means re-embedding everything.

**Bi-encoder vs cross-encoder.** An embedding model is a *bi-encoder*: it encodes the query and
each document independently, so document vectors can be precomputed and searched with an
index. A *cross-encoder* reads query and document together and outputs a relevance score. It's
more accurate but can't be precomputed, so it's used only to rerank a short candidate list.
This project uses hybrid retrieval in that role instead (cross-encoder weights come from
Hugging Face, which isn't available here).

### 5.2 Chunking

Embedding a whole document gives one vector that averages every topic in it, which is useless
for finding a specific fact. So documents are split into chunks, each embedded separately.

**Size is a tradeoff.**
- Smaller chunks: each vector is about one thing, so matching is precise; but a chunk may lack
  the context needed to answer, and more chunks means more prompt slots used per fact.
- Larger chunks: more context per hit; but the vector blurs several topics, and every
  retrieved chunk costs more prompt tokens.
- This project uses 600 tokens target, 800 max, within the 500–800 range the brief asked for.

**Overlap** (80 tokens): each chunk starts with the last few sentences of the previous one, so
a fact that straddles a boundary appears whole in at least one chunk. The cost is some
duplicated storage and embedding.

**Measure in tokens, not characters.** Models have a context limit in *tokens*, and many
embedding APIs silently truncate longer input: the tail of the chunk never makes it into the
vector and becomes unfindable. Two defences here: a deliberately pessimistic token estimate
(`max(chars/3, words×1.4)`) when sizing chunks, and `truncate: false` so Ollama errors instead
of truncating.

**Structure awareness.** Chunks don't cross page or heading boundaries, which gives each chunk
exactly one citation location. The cost: very short sections produce small chunks (the
handbook's sections give 60–280-token chunks). That's arguably good for citations; merging
small sibling sections is the fix if evaluation showed it hurting recall.

**The algorithm** (`chunker.py`): split on newlines and sentence boundaries into atoms; an atom
over the maximum is split on spaces, and a space-free run (e.g. base64) by characters using a
binary search for the longest prefix that fits; then greedily pack atoms up to the target,
carrying trailing atoms forward as overlap. Offsets are preserved exactly
(`text[char_start:char_end] == chunk.text`).

### 5.3 Approximate nearest-neighbour search and HNSW

Finding the nearest vectors exactly means comparing the query with every row: fine for
thousands of chunks, too slow for millions. **Approximate nearest-neighbour (ANN)** indexes
trade a little recall for speed.

**HNSW (Hierarchical Navigable Small World)** builds a layered graph. Upper layers have few
nodes and long-range links; the bottom layer has every vector with short-range links. A search
enters at the top, greedily moves toward the query, and drops a layer at a time, like zooming
into a map. Parameters:
- `m` (16): links per node. More = better recall, bigger index.
- `ef_construction` (64): candidate list size while building. More = better graph, slower build.
- `ef_search` (100, set per query): candidate list size while searching. The main recall/latency dial.

**IVFFlat**, the other pgvector index, clusters vectors and searches only the nearest clusters.
Its clusters are computed from the data present when the index is built, so building it on an
empty table (as a migration would) produces useless clusters. HNSW has no training step and
handles inserts incrementally, which is why it's used here.

**Operator class must match the query operator.** The index is built with `vector_cosine_ops`,
so queries must order by `<=>` (cosine distance). Ordering by `<->` (Euclidean) would silently
bypass the index and scan the whole table.

**Filtered ANN.** Queries filter by `collection_id`. HNSW finds `ef_search` candidates first and
the filter is applied afterwards, so if a collection is a small slice of the table, most
candidates get filtered out and fewer than `k` rows come back. pgvector 0.8's
`hnsw.iterative_scan = relaxed_order` keeps walking the graph until enough rows pass the
filter. "Relaxed" means results may be slightly out of order, so the outer query re-sorts.
Both settings are applied per transaction with `set_config(..., true)`.

### 5.4 Full-text search in Postgres

- `to_tsvector('english', text)` turns text into lexemes: lower-cased, **stemmed** ("releases",
  "released" → `releas`), with **stopwords** ("the", "is", "how") removed.
- `chunks.tsv` is a **generated column**, so it can never drift out of sync with the content,
  indexed with **GIN** (an inverted index: lexeme → rows).
- **Field weighting** (migration 002): the chunk's heading path gets weight A and the body
  weight B, so `ts_rank_cd` ranks a heading match above a passing mention. It's the same idea as
  BM25F's per-field boosts. It's what makes a query like `NimbusUnderReplicated` find the section
  with that heading.
- **AND vs OR.** `plainto_tsquery('how long is data kept')` produces `'long' & 'data' & 'kept'`:
  every term must match, so natural-language questions rarely match anything. The query rewrites
  `&` to `|` (OR), and `ts_rank_cd` rewards chunks matching more terms, closer together.

### 5.5 Hybrid retrieval and Reciprocal Rank Fusion

Vector search and keyword search fail in opposite ways:

| Query | Vector search | Keyword search |
|---|---|---|
| "how long is data kept in the message broker?" (paraphrase) | ✅ finds *Nimbus › Architecture* | partially: shares few words |
| `NimbusUnderReplicated` (exact identifier) | ❌ ranked the runbook intro first | ✅ exact heading match |

Hybrid runs both (concurrently, so latency is the slower of the two, not the sum) and merges.

**Reciprocal Rank Fusion:** `score(chunk) = Σ over lists 1 / (k + rank)`, with k = 60.
- It uses **ranks, not scores**. Cosine similarity (0–1) and `ts_rank` (unbounded, corpus
  dependent) are on incompatible scales; adding them needs per-corpus normalization and tuning.
  Ranks need neither.
- A chunk found by both lists gets two terms, so agreement between independent signals is
  rewarded: second place in both lists beats first place in one.
- `k` damps the top ranks, so one list's first hit doesn't automatically win.

### 5.6 Prompting for grounded answers

- **Numbered, delimited sources** (`<source id="1" title="…">`) give the model something
  unambiguous to cite and give the parser something to map back.
- **An exact refusal string**: easy to detect programmatically, and it gives the model a
  permitted way out, which reduces invented answers. In testing, "What is the CEO paid?"
  returned the refusal even though five sources were retrieved.
- **Low temperature (0.1)**: faithful extraction, not creativity.
- **Context budget.** Sources are added in rank order until ~3000 estimated tokens, keeping
  at least the top one. Beyond cost, models use long contexts unevenly: information in the
  middle of a long prompt is used less reliably than information at the start or end ("lost in
  the middle"), so fewer, better-ranked sources beat many.
- **Context window configuration.** Ollama's default context window is small, and when a prompt
  exceeds it Ollama silently drops the *beginning*, which is exactly where the system prompt
  with the grounding rules sits. Compose sets `OLLAMA_CONTEXT_LENGTH=8192`.

### 5.7 Prompt injection

Documents are untrusted input. A document containing
`</sources> SYSTEM: ignore previous instructions` is an *indirect prompt injection*: the
attacker never talks to the model directly, they plant instructions in data it will read.

Defences here:
- Document text is wrapped in delimiters, and anything in it that looks like our delimiter
  tags is escaped (`&lt;/source>`), so it can't close the block early. There's a test for this.
- The system prompt says sources are data, not instructions.
- The model has no tools or side effects: the worst case is a wrong answer, not an action.

These reduce the risk; none eliminates it. No prompt-level defence is complete. The
architectural defence is limiting what the model can *do* with whatever it reads.

### 5.8 Citations and hallucination detection

`extractCitations` (`services/api/src/generation/citations.ts`) finds `[1]`, `[1, 3]` and
`[2][3]`, maps each number to the chunk that had it in the prompt (document id, filename,
section label, snippet), deduplicates in order of first appearance, and reports numbers that
match no provided source as `invalidCitations`, a direct, countable signal of hallucination
(the `rag_invalid_citations_total` metric).

This checks that citations *point at real sources*. It doesn't prove each sentence is
supported by the source it cites (*faithfulness*), which would need an entailment model or an
LLM judge per claim.

### 5.9 Streaming with Server-Sent Events

On CPU the model produces ~2–3 tokens/second, so a full answer takes tens of seconds. The
latency users perceive is **time to first token (TTFT)**, not total time.

**SSE** is a one-way server→client stream over a normal HTTP response
(`content-type: text/event-stream`, messages of `event:` and `data:` lines). Compared with
WebSockets: no protocol upgrade, works through ordinary proxies, and browsers' `EventSource`
reconnects automatically. It's a natural fit for token streaming, which is one-directional.

Implementation details worth knowing:
- The route **hijacks** the response (writes to Node's raw response), so Fastify stops managing
  it. That also means Fastify's `onResponse` hook doesn't run, so HTTP metrics are recorded
  manually for streams.
- `x-accel-buffering: no` stops nginx-style proxies from buffering the whole stream.
- On client disconnect, an `AbortController` cancels the upstream LLM request. Without it, the
  server keeps generating tokens nobody will read.
- Streaming and non-streaming share one code path: the answerer is an async generator;
  `answer()` just consumes it until the `done` event.

### 5.10 Caching

Two caches in Redis (`services/api/src/cache/`, `retrieval/queryEmbedder.ts`, `generation/answerer.ts`).

**Query embeddings**: key `emb:<model id>:sha256(text)`, 7-day TTL (an embedding for a given
model and text never changes). Stored as raw float32 bytes in base64: ~4 KB per vector versus
~15 KB as a JSON array of decimals. Measured: 105 ms → 0.6 ms.

**Answers**: key = hash of (tenant, collection id, collection version, normalized question,
LLM model, embedding model, mode, top-k, prompt version), 1-hour TTL. Measured: ~100 s → 5 ms.

**Invalidation by key design.** "There are only two hard things in computer science: cache
invalidation and naming things." Instead of finding and deleting affected keys when a document
is added, every ingest bumps `collections.version`, which is part of the key. Old entries
simply stop matching and age out through TTL and LRU eviction. The same trick covers config
changes: a new model or prompt version changes the key.

**Tenant in the key.** Without it, two tenants asking the same question of same-named
collections could be served each other's answers: a data leak through the cache.

**The cache must never break the service.** The Redis client fails fast
(`enableOfflineQueue: false`, one retry), and a fail-safe wrapper turns any Redis error into a
cache miss plus a log line. Redis itself runs with `allkeys-lru` and a memory cap, so a full
cache evicts old entries instead of refusing writes.

**Not done: semantic caching** (reusing an answer for a *similar* question found by embedding
similarity). Higher hit rate, but similar questions can need different answers ("deploy
windows on Monday" vs "on Friday").

### 5.11 Idempotency and transactions

- **Idempotent upload:** the same bytes uploaded twice to a collection produce one document.
  The content hash is the identity, with a `UNIQUE (collection_id, sha256)` constraint.
- **Race-safe:** two identical uploads at the same moment both pass an application-level
  "does it exist?" check. `INSERT … ON CONFLICT DO NOTHING RETURNING id` lets the database's
  unique constraint pick exactly one winner; the loser reads the existing id.
- **Atomic:** document, chunks and version bump commit together or not at all. There's never
  a document with half its chunks.
- **Slow work outside transactions:** embedding happens before the transaction opens.

### 5.12 Authentication: OAuth2 client credentials and JWTs

**The flow.** API consumers are services, not people. OAuth2's **client-credentials grant**
(RFC 6749 §4.4) is designed for machine-to-machine access:

1. An operator registers a client (`create-client` CLI) and gets a `client_id` and a
   `client_secret` (256 random bits), shown once.
2. The client calls `POST /oauth/token` with `grant_type=client_credentials`, authenticating
   with HTTP Basic (`client_secret_basic`) or form fields (`client_secret_post`).
3. It receives a short-lived **access token** (15 minutes) and sends it as
   `Authorization: Bearer …` on API calls, re-fetching when it expires.

The long-lived secret is sent only to the token endpoint, occasionally. Data requests carry a
token that expires in minutes and can carry scopes. That's the advantage over static API keys.
(The authorization-code flow with PKCE is for apps acting on behalf of a *user* in a browser;
there's no user here.)

**Storing secrets.** Only an **argon2id** hash is stored. Argon2 is deliberately slow and
*memory-hard* (19 MiB per hash here), which makes brute-forcing a leaked hash expensive even
on GPUs. Fast hashes like SHA-256 are the wrong tool for secrets.

**Timing attacks.** If an unknown `client_id` returned instantly but a wrong secret took 50 ms
(the argon2 cost), response times would reveal which client ids exist. Unknown ids are
therefore verified against a dummy hash, so both failures take the same time.

**The token: a JWT** (`header.payload.signature`, each base64url):
- Header: `{"alg":"RS256","kid":"…","typ":"at+jwt"}`
- Payload: `iss` (who issued it), `aud` (who it's for), `sub` (the tenant's internal id),
  `exp`, `iat`, `jti` (unique id), `scope`, `client_id`.
- Signature: RSA over header + payload with the private key.

Anyone can *read* a JWT; the signature only makes it tamper-evident. Never put secrets in claims.

**RS256 vs HS256.** HS256 is symmetric: the same secret signs and verifies, so every service
that verifies tokens could also mint them. RS256 is asymmetric: only the API holds the private
key; anyone can verify with the public key, published at `/.well-known/jwks.json`.

**Key rotation.** Each key has a `kid` (here the RFC 7638 thumbprint of the public key).
Tokens name the key that signed them. To rotate: publish old and new keys together, sign with
the new one, and remove the old one once its tokens have expired (15 minutes).

**What verification checks** (`services/api/src/auth/tokens.ts`): signature, `alg` pinned to
RS256, issuer, audience, expiry (30 s clock tolerance), `typ`, and required claims. Pinning the
algorithm blocks two classic attacks:
- `alg: none`: an unsigned token that naive libraries accept.
- **Key confusion**: an attacker takes the *public* key and uses it as an HMAC secret to sign
  an HS256 token; a verifier that trusts the token's `alg` header would accept it.
Both are covered by tests, along with expired, wrong-audience, wrong-issuer, wrong-key and
tampered tokens.

**Revocation.** A JWT is valid until it expires; checking it needs no database lookup (fast,
stateless, verifiable anywhere). The cost is that you can't instantly revoke one. Short
lifetimes bound the damage; `jti` would allow a denylist if instant revocation were required.
The alternative, opaque tokens checked against a store on every request, trades that
statelessness for instant revocation.

**Response codes** (RFC 6750):
- **401** = "who are you?" (missing, invalid or expired token), with a `WWW-Authenticate: Bearer` header.
- **403** = "I know who you are; you can't do this" (insufficient scope).
- **404** for another tenant's resource: returning 403 would confirm that the resource exists.

**Rate limiting.** `/oauth/token` is the one endpoint that checks secrets, so it's limited to
20 requests/minute per IP to slow down guessing.

### 5.13 Multi-tenancy and row-level security

Two independent layers:

1. **Application layer:** every repository query filters by the tenant
   (`WHERE client_id = $1`, or via the collection).
2. **Database layer:** Postgres **row-level security** (migration 003). Policies on
   `collections`, `documents` and `chunks` restrict every query to the tenant set in
   `app.client_id`. Even a query with *no* WHERE clause (a bug, or SQL injection) returns only
   that tenant's rows. `WITH CHECK` prevents writing rows for another tenant.

How it's wired (`services/api/src/db/tenant.ts`, `services/ml/app/store.py`):

```sql
BEGIN;
SET LOCAL ROLE rag_app;                              -- least-privilege role
SELECT set_config('app.client_id', '<tenant>', true); -- true = transaction-local
... queries ...
COMMIT;                                              -- role and tenant reset here
```

Details that matter:
- **Superusers bypass RLS**, always. The app connects as the owner, so each tenant transaction
  switches to `rag_app`, a role with no login, access only to the three data tables, and **no
  access to `clients`** (tenant code can't even read credential hashes).
- **Transaction-local settings are essential with connection pools.** A session-level
  `SET app.client_id` on a pooled connection would still be set when the next request, maybe
  from another tenant, reuses that connection. `SET LOCAL` ends with the transaction.
- **Fail closed:** if `app.client_id` is unset, the policy compares against NULL and matches
  nothing (tested).
- `documents` and `chunks` policies check `collection_id IN (SELECT id FROM collections)`, and
  that subquery is itself filtered by the `collections` policy, so ownership flows through the
  collection without duplicating `client_id` everywhere.
- The `ml` service writes under the same policies, so even if the API's ownership check were
  bypassed, `ml` couldn't write into another tenant's collection.
- Cost: three extra round trips per tenant query (BEGIN, SET ROLE, set_config), a few
  milliseconds locally.

### 5.14 Observability

**Metrics** (Prometheus, `services/api/src/observability/metrics.ts`):
- Counters (only go up: tokens, cache hits, answers) and histograms (latency distributions).
- **Histograms over summaries:** a histogram's buckets can be summed across instances, so a
  fleet-wide p95 is computable; summary quantiles can't be averaged.
- **Low-cardinality labels:** every distinct label combination is a separate time series.
  Routes are labelled by template (`/collections/:collectionId/query`), never by concrete URL,
  and never by question, tenant or collection id.
- Per-stage latency: `embed`, `vector_search`, `keyword_search`, `ttft`, `generate`, `total`.
  Stage timings show *where* latency goes: here ~99% is generation on CPU.

**Retrieval hit-rate** is defined explicitly: a retrieval is a *hit* when its best cosine
similarity is at least `RETRIEVAL_HIT_THRESHOLD` (0.6). The distribution of top scores is also
exported, because the threshold should be calibrated from data (see 5.15).

**Liveness vs readiness.**
- `/health` (liveness) checks nothing but the process. If it checked Postgres, a database
  blip would make the orchestrator restart every healthy API container at once.
- `/ready` (readiness) checks Postgres, Redis, ml and the LLM, in parallel, each with a timeout
  (one hung dependency can't hang the probe). Failing readiness means "stop sending me
  traffic", not "restart me".

**Logs:** structured JSON (pino). Every line carries the request id; an incoming
`X-Request-Id` from a gateway is honoured and echoed back, so a failure a user reports can be
found in the logs. Each question produces one `rag_query` line (timings, token usage, cache
status, retrieval confidence, citation counts), deliberately without the question text,
which may be sensitive.

### 5.15 Evaluation

"It seems to work on the questions I tried" isn't evidence. `eval/` measures the system on a
fixed dataset so changes can be compared.

**Dataset design** (`eval/dataset.jsonl`): 20 answerable questions, each with its expected
document and key phrases (checked to appear verbatim in the source), and 5 unanswerable ones.
The documents are fictional, so the model can't answer from training data: a correct answer
proves retrieval worked.

**Retrieval metrics** (`eval/metrics.py`), with a chunk counted relevant if it comes from the
expected document *and* contains an expected phrase:
- **precision@k**: share of the top k that is relevant. Capped by how many relevant chunks
  exist: with one answer-bearing chunk and k = 5, the maximum is 0.2. That's exactly what was
  measured, which is why precision@k alone misleads.
- **hit@k**: is any relevant chunk in the top k? With one gold passage per question this equals
  **recall@k**, and it bounds answer quality: if the passage isn't retrieved, the answer can't be right.
- **MRR** (mean reciprocal rank): average of 1/rank of the first relevant chunk. Rewards
  putting the answer first.

Results on the sample corpus: hit@5 = 1.0 for every mode; MRR 0.942 hybrid, 0.871 vector,
0.950 keyword. The questions were written from the documents and reuse their vocabulary, which
favours keyword search; a real evaluation set should include paraphrased questions from real users.

**Calibration finding.** Top cosine similarity for answerable questions ranged 0.557–0.859;
for unanswerable ones 0.599–0.701. The ranges **overlap**, so no similarity threshold can decide
"the documents don't contain this". That's why refusal is left to the grounded prompt, and why
the hit-rate metric is a health signal, not a gate.

**Answer metrics** (`--generate`): key-fact coverage (expected phrases in the answer), citation
accuracy (cites the expected document), cosine similarity to a reference answer, an
**LLM-as-judge** score (1–5), correct-refusal rate on unanswerable questions, false-refusal
rate on answerable ones, hallucinated citation count, latency p50/p95 and TTFT.
LLM-as-judge caveats: when the judge is the same model as the generator it tends to favour its
own outputs (self-preference), and judges are sensitive to answer length and position. Use it as
a relative signal between versions, not an absolute score.

**Offline vs online.** This is offline evaluation (fixed dataset, run before shipping). Online
evaluation samples real traffic: refusal rate, invalid-citation rate and hit-rate over time,
plus user feedback.

### 5.16 Containers and Compose

- **Startup ordering with healthchecks.** Plain `depends_on` only waits for a container to
  *start*. `condition: service_healthy` waits for its healthcheck (e.g. `pg_isready`), and
  `service_completed_successfully` waits for a one-shot job to exit 0. The model-pull jobs are
  split so `ml` waits only for the small embedding model, not the 4.7 GB LLM.
- **One-shot jobs** (`ollama-pull-embed`, `ollama-pull-llm`) run `ollama pull` and exit. Models
  live in a named volume, so later starts are near-instant.
- **Named volumes:** Postgres data, model weights, and the JWT signing key persist across
  `docker compose down`.
- **Network exposure:** only the API port is published. `ml` and `ollama` are reachable only
  inside the compose network; Postgres and Redis are bound to `127.0.0.1` for local debugging.
- **Image layering:** dependency manifests are copied and installed before source code, so
  editing code rebuilds only the last layer. The API image is multi-stage (build with dev
  dependencies, ship only the compiled output and production dependencies) and runs as a
  non-root user.
- **Migrations at startup, guarded by a Postgres advisory lock**, so two replicas starting
  together can't both apply them; each migration runs in a transaction with its bookkeeping row.

### 5.17 Testing strategy

- **Dependency injection** makes the core logic testable: `buildApp()` takes the repository, ml
  client, retriever, answerer, token service and metrics as parameters, and routes are exercised
  with `app.inject()` (no network). The chunker takes its token counter as a parameter, so tests
  use a word counter and stay fast and readable.
- **Fakes over mocks** for behaviour (in-memory cache, fake LLM that streams given tokens, fake
  search store), mocks only to assert interactions ("the LLM was never called").
- **Integration tests against real Postgres** for anything whose correctness depends on the
  database: SQL retrieval on seeded vectors (ordering, collection isolation, stemming), RLS
  policies, argon2 hashing, migrations (idempotent, concurrent).
- **Security tests** are written as attacks: forged, expired, re-targeted, unsigned and
  algorithm-confused tokens; cross-tenant reads and writes; prompt-injection text.

### 5.18 MCP: exposing retrieval to AI applications

The Model Context Protocol lets any MCP-capable host (Claude Code, Claude Desktop, agents)
discover and call this system without custom integration code. Full guide: [mcp.md](mcp.md).

- **Three primitives, three controllers:** *tools* are chosen by the model (`search_documents`),
  *resources* are loaded by the application by URI (`rag://chunks/{chunkId}`), *prompts* are
  picked by the user (`answer_from_docs`).
- **Protocol:** JSON-RPC 2.0 with an `initialize` handshake that negotiates version and capabilities.
- **Ports and adapters:** one server definition depends on a `RagBackend` interface. The HTTP
  endpoint binds it in-process to the token's tenant; the stdio server binds it to the REST API
  using its own client credentials. Same tools, same results, verified by one smoke test for both.
- **Transports:** stdio (the host spawns the process; stdout is reserved for protocol messages)
  and Streamable HTTP (`POST /mcp`), here in **stateless** mode so any replica can serve any request.
- **Authorization (MCP spec):**
  - A 401 challenge carries `resource_metadata`, pointing to the protected-resource metadata (RFC 9728).
  - That names the authorization server, whose metadata (RFC 8414) gives the token endpoint.
  - Tokens are requested for a specific resource (RFC 8707) and carry it as their audience.
  - Audience binding means a token for `/mcp` is useless against the REST API and vice versa.
  - **No token passthrough:** a server never forwards the token it received (the confused-deputy problem).
- **Designing tools for models:** accept names, not UUIDs; describe *when* to use each tool;
  bound the output size; return recoverable failures as tool results with `isError`, so the model
  can retry with a valid argument; validate input with schemas.
- **Security:** tool results are an indirect prompt-injection channel. Excerpts are delimited and
  labelled untrusted, and every tool is read-only.

## 6. Bugs found while building it

These make good stories because each one was silent: nothing crashed.

1. **IPv6 `localhost` in healthchecks.** Inside Alpine, `localhost` resolved to `::1` first,
   while the server listened on IPv4 `0.0.0.0`. The healthcheck got "connection refused" although
   the API was fine. Fix: target `127.0.0.1`.
2. **Double stemming in keyword search.** Rewriting `plainto_tsquery` output through
   `to_tsquery('english', …)` stemmed terms a second time (`releas` → `relea`), which then matched
   nothing. An integration test caught it. Fix: cast with `::tsquery`.
3. **Headings weren't searchable.** Headings were stored only as metadata, so keyword search
   couldn't find `NimbusUnderReplicated`. Fix: store the context header on the chunk and index it
   with a higher weight (migration 002).
4. **Silent prompt truncation (prevented).** Ollama's default context window would have silently
   cut the start of long prompts: the system prompt. Fix: raise it and cap the prompt budget.
5. **Model supply chain.** The network blocks Hugging Face, so the planned sentence-transformers
   models couldn't be downloaded. The embedding layer already sat behind a provider interface,
   so switching to Ollama-served models was a configuration change.

## 7. Tradeoffs and what changes at scale

| Area | Current choice | What changes at scale |
|---|---|---|
| Ingestion | Synchronous in the request | Queue (the schema already has `status = processing`), workers, retries |
| Inference | CPU Ollama in Docker | GPU nodes or a hosted API; batching; keep local models for development |
| Vector store | One Postgres | Partition chunks by tenant, read replicas, or a dedicated vector DB past tens of millions of vectors |
| Reranking | RRF only | Cross-encoder or LLM reranker on the top 20–50 |
| Token counting | Pessimistic estimate | The model's real tokenizer, if it can run in-process |
| Keys | Generated, stored in a volume | KMS/secret manager, scheduled rotation, several keys in the JWKS |
| Revocation | Expiry (15 min) | `jti` denylist in Redis if instant revocation is required |
| Tracing | Per-stage timings | OpenTelemetry spans across api → ml → Postgres → LLM |
| Evaluation | Offline dataset | Plus online sampling, user feedback, regression gates in CI |

## 8. Questions this design should be able to answer

**Why pgvector rather than a vector database?** One transactional store: documents and chunks
commit atomically, metadata filters are SQL, tenancy is enforced by the same database with RLS,
and there's one system to back up and operate. A dedicated vector DB wins at very large scale
(hundreds of millions of vectors, high QPS, sharding).

**How did you choose the chunk size?** A tradeoff between retrieval precision (small) and
context per hit (large), bounded by the embedding model's window, measured in tokens, with
overlap for boundary facts. Then validated with the evaluation's hit@k and MRR; the right size
is corpus-dependent.

**What happens if a chunk is longer than the embedding model's limit?** Most APIs silently
truncate, losing the tail. Here chunk sizes use a pessimistic estimate, and Ollama is called with
`truncate: false` so it errors instead.

**Why hybrid search?** Vector search handles paraphrase, keyword search handles exact
identifiers; each fails where the other succeeds. RRF merges them by rank, which needs no score
normalization.

**How do you stop the model making things up?** Retrieval quality first; then a prompt that
restricts answers to numbered sources with a fixed refusal; low temperature; skipping the LLM
entirely when nothing is retrieved; and detecting citations to sources that weren't provided.

**How do you know it works?** An evaluation dataset with fictional documents: retrieval metrics
(hit@k, MRR, precision@k) per mode, answer metrics (coverage, citation accuracy, judge score,
refusal accuracy), and latency percentiles.

**Why RS256 and not HS256?** With HS256, every verifier holds the key that can mint tokens.
RS256 separates signing (private key, only the API) from verifying (public JWKS, anyone).

**How would you revoke a token?** Short expiry bounds exposure. For instant revocation, a denylist
of `jti` values checked on each request (Redis), or switch to opaque tokens with introspection,
giving up statelessness.

**How is one tenant prevented from seeing another's data?** Tenant-filtered queries, plus
row-level security enforced by Postgres under a least-privilege role with transaction-local
tenant settings; 404 for other tenants' resources; tenant id in every cache key.

**Why does another tenant's collection return 404 rather than 403?** 403 confirms the resource
exists, which leaks information (an IDOR/BOLA enumeration aid).

**How is the cache invalidated when documents change?** It isn't explicitly: the collection
version is part of the key and every ingest bumps it, so stale entries stop matching and expire.

**What if Redis goes down?** Requests continue with cache misses. The client fails fast instead
of queueing, and a wrapper turns cache errors into misses.

**Liveness vs readiness?** Liveness asks "should this process be restarted?" and must not depend
on other services. Readiness asks "should this instance receive traffic?" and checks dependencies.

**Where does the latency go, and how would you reduce it?** Per-stage metrics show generation
dominates (CPU inference). Options: GPU or hosted model, a smaller model, fewer prompt tokens,
streaming for perceived latency (TTFT), and caching repeated questions.

**What is MCP and why add it?** A standard protocol (JSON-RPC) for AI applications to discover and
call tools, read resources and use prompts. Adding it lets any MCP host use this retrieval
without a bespoke client: one integration instead of one per host.

**Tools vs resources vs prompts?** Who decides: the model calls tools, the application loads
resources, the user picks prompts.

**stdio vs Streamable HTTP?** stdio is a local subprocess, single user, credentials on that machine.
Streamable HTTP is a network service, multi-user, OAuth-protected. Stateless HTTP scales without
sticky sessions but can't push messages between requests.

**How does an MCP client know how to authenticate?** The 401's `WWW-Authenticate` header points to
protected-resource metadata, which names the authorization server, whose metadata gives the
token endpoint. The token is requested for the MCP resource and bound to it by audience.

**What is token passthrough and why is it forbidden?** Forwarding the token you received to another
service. The downstream service can't tell who it's really acting for, and audience checks stop
meaning anything: a confused deputy. Each hop should authenticate as itself (or use token exchange).

**What's the weakest part of this system?** Generation speed on CPU, and a small evaluation set
written from the documents themselves (it favours keyword search). Next steps: a paraphrased
evaluation set from real questions, reranking, and async ingestion.
