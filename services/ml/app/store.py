import json
from dataclasses import dataclass

from psycopg_pool import ConnectionPool


@dataclass(frozen=True)
class ChunkRow:
    ordinal: int
    content: str
    token_count: int
    metadata: dict
    embedding: list[float]


@dataclass(frozen=True)
class Job:
    """A claimed ingestion job. `attempts` is the lease token: a later claim increments it, so a
    worker whose lease expired (and was reclaimed by another) can't complete or fail the job."""

    document_id: str
    client_id: str
    collection_id: str
    filename: str
    kind: str
    payload: bytes
    attempts: int


@dataclass(frozen=True)
class Enqueued:
    document_id: str
    created: bool  # False = identical file already in this collection (any status but failed)
    status: str
    chunk_count: int


def to_pgvector(vector: list[float]) -> str:
    # pgvector's text format '[0.1,0.2,...]'. 9 significant digits round-trips float32 exactly.
    return "[" + ",".join(f"{x:.9g}" for x in vector) + "]"


def _as_tenant(conn, client_id: str) -> None:
    """Scope this transaction to one tenant under Postgres Row-Level Security (migration 003).

    SET LOCAL lasts until the transaction ends, so nothing leaks to the next use of a pooled connection.
    """
    conn.execute("SET LOCAL ROLE rag_app")
    conn.execute("SELECT set_config('app.client_id', %s, true)", (client_id,))


class Store:
    def __init__(self, dsn: str):
        self._pool = ConnectionPool(dsn, min_size=1, max_size=4, open=True)

    def close(self) -> None:
        self._pool.close()

    # ------------------------------------------------------------ accept (request path)

    def enqueue_document(
        self, client_id: str, collection_id: str, filename: str, mime_type: str, kind: str, sha256: str, data: bytes
    ) -> Enqueued:
        """Accept an upload: a `processing` document and its job, in one transaction, as the tenant.

        ON CONFLICT DO NOTHING lets the unique (collection_id, sha256) constraint pick one winner
        when identical uploads race; the loser gets the existing document. A previous *failed*
        attempt for the same bytes is replaced, so re-uploading is how a failed document is retried.
        RLS applies to both inserts: a collection owned by another tenant can't be written to.
        """
        with self._pool.connection() as conn, conn.transaction():
            _as_tenant(conn, client_id)
            conn.execute(
                "DELETE FROM documents WHERE collection_id = %s AND sha256 = %s AND status = 'failed'",
                (collection_id, sha256),
            )
            row = conn.execute(
                """INSERT INTO documents (collection_id, filename, mime_type, sha256, status)
                   VALUES (%s, %s, %s, %s, 'processing')
                   ON CONFLICT (collection_id, sha256) DO NOTHING
                   RETURNING id""",
                (collection_id, filename, mime_type, sha256),
            ).fetchone()
            if row is None:
                existing = conn.execute(
                    "SELECT id, status, chunk_count FROM documents WHERE collection_id = %s AND sha256 = %s",
                    (collection_id, sha256),
                ).fetchone()
                return Enqueued(str(existing[0]), False, existing[1], existing[2])
            conn.execute(
                """INSERT INTO ingest_jobs (document_id, client_id, collection_id, filename, kind, payload)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (row[0], client_id, collection_id, filename, kind, data),
            )
            return Enqueued(str(row[0]), True, "processing", 0)

    # ------------------------------------------------------------ worker (owner role)

    def claim_job(self, lease_seconds: int) -> Job | None:
        """Claim the oldest runnable job, or reclaim one whose lease expired (its worker died).

        FOR UPDATE SKIP LOCKED: concurrent workers skip rows another worker is claiming instead of
        queueing behind its lock, so N workers claim N different jobs. The claim commits at once
        (a lease), so no transaction stays open during the slow parse/embed work.
        """
        with self._pool.connection() as conn, conn.transaction():
            row = conn.execute(
                """UPDATE ingest_jobs j
                      SET locked_at = now(), attempts = j.attempts + 1
                    WHERE j.document_id = (
                          SELECT document_id FROM ingest_jobs
                           WHERE run_after <= now()
                             AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => %s))
                           ORDER BY created_at
                           LIMIT 1
                           FOR UPDATE SKIP LOCKED)
                RETURNING j.document_id, j.client_id, j.collection_id, j.filename, j.kind, j.payload, j.attempts""",
                (lease_seconds,),
            ).fetchone()
        if row is None:
            return None
        return Job(str(row[0]), str(row[1]), str(row[2]), row[3], row[4], bytes(row[5]), row[6])

    def _lock_job(self, conn, job: Job) -> bool:
        """Lock our job row for the finishing transaction. False = the document was deleted (the
        job went with it: cancelled) or our lease expired and another worker reclaimed it."""
        return conn.execute(
            "SELECT 1 FROM ingest_jobs WHERE document_id = %s AND attempts = %s FOR UPDATE",
            (job.document_id, job.attempts),
        ).fetchone() is not None

    def complete_document(self, job: Job, embedding_model: str, chunks: list[ChunkRow]) -> bool:
        """Store the chunks, mark the document ready, bump the collection version and delete the
        job: all or nothing. Returns False if the job was cancelled or reclaimed meanwhile.

        Chunks only become visible to search at this commit, so a half-processed document is
        never retrievable. The writes run as the tenant (RLS); only the job row is the owner's.
        """
        with self._pool.connection() as conn, conn.transaction():
            if not self._lock_job(conn, job):
                return False
            _as_tenant(conn, job.client_id)
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO chunks (document_id, collection_id, ordinal, content, token_count,
                                           metadata, embedding, embedding_model)
                       VALUES (%s, %s, %s, %s, %s, %s, %s::vector, %s)""",
                    [
                        (job.document_id, job.collection_id, c.ordinal, c.content, c.token_count,
                         json.dumps(c.metadata), to_pgvector(c.embedding), embedding_model)
                        for c in chunks
                    ],
                )
            conn.execute(
                "UPDATE documents SET status = 'ready', chunk_count = %s, error = NULL WHERE id = %s",
                (len(chunks), job.document_id),
            )
            # New searchable content: bump the version so cached answers for this collection stop matching.
            conn.execute("UPDATE collections SET version = version + 1 WHERE id = %s", (job.collection_id,))
            conn.execute("RESET ROLE")
            conn.execute("DELETE FROM ingest_jobs WHERE document_id = %s", (job.document_id,))
            return True

    def fail_document(self, job: Job, error: str) -> bool:
        """Give up on a job: the document stays, with status `failed` and the reason."""
        with self._pool.connection() as conn, conn.transaction():
            if not self._lock_job(conn, job):
                return False
            _as_tenant(conn, job.client_id)
            conn.execute(
                "UPDATE documents SET status = 'failed', error = %s WHERE id = %s", (error[:1000], job.document_id)
            )
            conn.execute("RESET ROLE")
            conn.execute("DELETE FROM ingest_jobs WHERE document_id = %s", (job.document_id,))
            return True

    def retry_later(self, job: Job, delay_seconds: float, error: str) -> None:
        """Release the lease and schedule another attempt (exponential backoff decided by the caller)."""
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """UPDATE ingest_jobs
                      SET locked_at = NULL, run_after = now() + make_interval(secs => %s), last_error = %s
                    WHERE document_id = %s AND attempts = %s""",
                (delay_seconds, error[:1000], job.document_id, job.attempts),
            )
