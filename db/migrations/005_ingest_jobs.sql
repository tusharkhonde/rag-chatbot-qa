-- 005: background ingestion. An upload is accepted by inserting a `processing` document and
-- a job in ONE transaction; a worker in the ml service claims jobs with FOR UPDATE SKIP LOCKED,
-- parses/chunks/embeds outside any transaction, then commits the chunks, flips the document to
-- `ready` and deletes the job, again in one transaction. See docs/adr/0009-async-ingestion.md.
--
-- Why Postgres and not Redis: the job and its document are created atomically (no orphaned
-- documents, no jobs for documents that don't exist), Redis here is an evicting LRU cache, and
-- deleting a document deletes its job through the foreign key (that's how cancellation works).

CREATE TABLE ingest_jobs (
  document_id   uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('pdf', 'markdown', 'text')),
  payload       bytea NOT NULL,          -- the uploaded bytes (≤ 20 MB), deleted with the job
  attempts      int NOT NULL DEFAULT 0,  -- incremented on every claim; doubles as the lease token
  run_after     timestamptz NOT NULL DEFAULT now(),  -- retry backoff
  locked_at     timestamptz,             -- lease start; a stale lease is reclaimed (crashed worker)
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingest_jobs_runnable_idx ON ingest_jobs (run_after, created_at);

-- The upload transaction runs as the tenant (rag_app), so it may INSERT a job, but only for its
-- own collection. Reading, claiming and deleting jobs is the worker's job and runs as the owner.
GRANT INSERT ON ingest_jobs TO rag_app;
ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_enqueue ON ingest_jobs FOR INSERT TO rag_app
  WITH CHECK (
    client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
    AND collection_id IN (SELECT id FROM collections)
  );
