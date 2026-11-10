# ADR 0009: Background ingestion with a Postgres job queue

**Status:** accepted (replaces synchronous ingestion inside the upload request)

## Context
Uploads used to be parsed, chunked and embedded inside the HTTP request. On CPU a large PDF
takes minutes, which holds a request open (and a proxy timeout can kill it), gives the user no
progress, and loses the work if the client disconnects. The schema already had
`documents.status` (`processing | ready | failed`) and `error`, but nothing used them.

## Decision
- **Accept fast, process later.** `POST /collections/:id/documents` detects the type (415
  immediately), hashes, deduplicates, and inserts a `processing` document **and** an
  `ingest_jobs` row (with the file bytes) in one transaction, then returns **202 Accepted** with
  a `Location` to poll. Duplicate bytes return 200 and the existing document.
- **The queue is a Postgres table** (migration 005). Worker threads in the ml service claim a job
  with `UPDATE … WHERE document_id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, which commits a
  **lease** (`locked_at`, `attempts + 1`). Parsing and embedding run with no transaction open.
  A second transaction locks the job (matching `attempts`, the lease token), inserts chunks,
  marks the document `ready`, bumps the collection version and deletes the job.
- **Failures:** a file that can't be parsed or has no text fails permanently (`status=failed`,
  `error` set, no retry). Anything else (embedder down, timeout, database blip) retries with
  exponential backoff (10 s, 20 s, …) and fails after `INGEST_MAX_ATTEMPTS` (3).
- **Crashes:** a job whose lease is older than `INGEST_LEASE_SECONDS` (15 min) is reclaimed. The
  old worker can't finish it afterwards: its `attempts` no longer matches.
- **Cancellation is a foreign key.** Deleting a document deletes its job (`ON DELETE CASCADE`).
  A worker that finishes later finds no job row and drops its result.
- **Tenancy:** the enqueue runs as the tenant under RLS. `rag_app` may only INSERT into
  `ingest_jobs`, and only for its own collections. Claiming and deleting jobs is the owner's.
- **Re-upload retries a failure:** a previous `failed` document with the same bytes is replaced.

## Consequences
- Uploads return in milliseconds regardless of file size. Clients poll
  `GET /collections/:id/documents/:documentId` (the web app's admin page polls every 2 s).
- Chunks become searchable only at the final commit, so search never sees half a document and
  needs no `status` filter.
- Job state, retries and errors are inspectable with SQL; no new infrastructure.
- The file bytes sit in Postgres until processed (≤ 20 MB each). At scale they'd go to object
  storage, with the job row holding a key instead.
- Polling, not push: there are no progress events.

## Alternatives considered
- **Redis list/stream:** in this stack Redis is an `allkeys-lru` cache that may evict a job,
  the ml service has no Redis client, and the job couldn't be created in the same transaction
  as its document (a crash between the two leaves an orphan).
- **A broker (RabbitMQ/SQS) + Celery:** the right tool for high volume or fan-out, but one more
  service to run and a dual-write problem (database row + message) that needs an outbox.
- **FastAPI `BackgroundTasks`:** runs after the response in the same process, but a restart
  loses the work and there's no retry, lease or visibility.
- **`LISTEN/NOTIFY` instead of polling:** lower latency across processes. Here the upload and
  the worker share a process, so an in-process wake-up already makes local pickup immediate,
  and a 1 s poll covers other replicas.
