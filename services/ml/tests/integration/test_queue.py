"""The job queue against real Postgres: claiming, leases, cancellation and RLS.

Needs a database migrated to at least 005 (run the API or its integration tests first):
  docker run --rm --network rag_default -e DATABASE_URL=postgresql://rag:rag@postgres:5432/rag \
    rag-ml-test pytest -q tests/integration
"""

import hashlib
import os
import uuid

import psycopg
import pytest
from psycopg.errors import InsufficientPrivilege

from app.store import ChunkRow, Store

DSN = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL not set (integration test)")


@pytest.fixture(scope="module")
def db():
    with psycopg.connect(DSN, autocommit=True) as conn:
        if conn.execute("SELECT to_regclass('ingest_jobs')").fetchone()[0] is None:
            pytest.skip("migration 005 not applied yet")
        yield conn


@pytest.fixture
def tenant(db):
    """A fresh client with one collection; deleting the client cascades everything."""
    client_id = db.execute(
        "INSERT INTO clients (client_id, secret_hash, name) VALUES (%s, 'x', 'queue test') RETURNING id",
        (f"it-queue-{uuid.uuid4()}",),
    ).fetchone()[0]
    collection_id = db.execute(
        "INSERT INTO collections (client_id, name) VALUES (%s, 'q') RETURNING id", (client_id,)
    ).fetchone()[0]
    yield str(client_id), str(collection_id)
    db.execute("DELETE FROM clients WHERE id = %s", (client_id,))


@pytest.fixture
def store():
    s = Store(DSN)
    yield s
    s.close()


def enqueue(store, tenant, data=None):
    data = data or uuid.uuid4().bytes
    client_id, collection_id = tenant
    return store.enqueue_document(
        client_id, collection_id, "a.md", "text/markdown", "markdown", hashlib.sha256(data).hexdigest(), data
    )


def claim_mine(store, document_id, lease=900):
    """Claim jobs until we get this test's one (other tests' leftovers can't interfere for long)."""
    for _ in range(50):
        job = store.claim_job(lease)
        if job is None or job.document_id == document_id:
            return job
    raise AssertionError("job not found")


def chunk_rows(n=2):
    return [ChunkRow(i, f"text {i}", 2, {}, [0.01] * 768) for i in range(n)]


def doc(db, document_id):
    return db.execute("SELECT status, chunk_count, error FROM documents WHERE id = %s", (document_id,)).fetchone()


def test_enqueue_creates_a_processing_document_and_its_job_and_dedupes(db, store, tenant):
    data = b"same bytes"
    first = enqueue(store, tenant, data)
    assert first.created and first.status == "processing"
    assert doc(db, first.document_id)[0] == "processing"
    assert db.execute("SELECT count(*) FROM ingest_jobs WHERE document_id = %s", (first.document_id,)).fetchone()[0] == 1

    again = enqueue(store, tenant, data)
    assert (again.document_id, again.created, again.status) == (first.document_id, False, "processing")


def test_complete_stores_chunks_marks_ready_bumps_version_and_deletes_the_job(db, store, tenant):
    _, collection_id = tenant
    version = db.execute("SELECT version FROM collections WHERE id = %s", (collection_id,)).fetchone()[0]
    accepted = enqueue(store, tenant)
    job = claim_mine(store, accepted.document_id)
    assert job.attempts == 1 and job.client_id == tenant[0]

    assert store.complete_document(job, "ollama:test", chunk_rows(3))
    assert doc(db, job.document_id) == ("ready", 3, None)
    assert db.execute("SELECT count(*) FROM chunks WHERE document_id = %s", (job.document_id,)).fetchone()[0] == 3
    assert db.execute("SELECT version FROM collections WHERE id = %s", (collection_id,)).fetchone()[0] == version + 1
    assert db.execute("SELECT count(*) FROM ingest_jobs WHERE document_id = %s", (job.document_id,)).fetchone()[0] == 0


def test_a_claimed_job_is_not_claimed_again_and_a_locked_row_is_skipped(db, store, tenant):
    accepted = enqueue(store, tenant)
    with psycopg.connect(DSN) as other:
        # Another worker mid-claim holds the row lock: SKIP LOCKED passes over it instead of waiting.
        other.execute("SELECT 1 FROM ingest_jobs WHERE document_id = %s FOR UPDATE", (accepted.document_id,))
        assert claim_mine(store, accepted.document_id) is None
        other.rollback()
    job = claim_mine(store, accepted.document_id)
    assert job is not None
    # Leased now: a second worker doesn't get it while the lease is fresh.
    assert claim_mine(store, accepted.document_id) is None


def test_an_expired_lease_is_reclaimed_and_the_old_worker_can_no_longer_finish(db, store, tenant):
    accepted = enqueue(store, tenant)
    stale = claim_mine(store, accepted.document_id)
    db.execute("UPDATE ingest_jobs SET locked_at = now() - interval '1 hour' WHERE document_id = %s", (stale.document_id,))

    fresh = claim_mine(store, accepted.document_id)
    assert fresh.attempts == stale.attempts + 1
    assert not store.complete_document(stale, "ollama:test", chunk_rows())  # lease lost
    assert store.complete_document(fresh, "ollama:test", chunk_rows())
    assert doc(db, accepted.document_id)[0] == "ready"


def test_retry_later_releases_the_lease_with_a_backoff(db, store, tenant):
    accepted = enqueue(store, tenant)
    job = claim_mine(store, accepted.document_id)
    store.retry_later(job, 3600, "ConnectionError: down")
    assert claim_mine(store, accepted.document_id) is None  # not runnable for an hour
    row = db.execute("SELECT locked_at, last_error FROM ingest_jobs WHERE document_id = %s", (job.document_id,)).fetchone()
    assert row == (None, "ConnectionError: down")


def test_deleting_the_document_cancels_its_job(db, store, tenant):
    accepted = enqueue(store, tenant)
    job = claim_mine(store, accepted.document_id)
    db.execute("DELETE FROM documents WHERE id = %s", (job.document_id,))  # what the API's DELETE does
    assert not store.complete_document(job, "ollama:test", chunk_rows())
    assert db.execute("SELECT count(*) FROM chunks WHERE document_id = %s", (job.document_id,)).fetchone()[0] == 0


def test_a_failed_document_keeps_its_error_and_re_uploading_retries_it(db, store, tenant):
    data = b"will fail first"
    accepted = enqueue(store, tenant, data)
    job = claim_mine(store, accepted.document_id)
    assert store.fail_document(job, "No extractable text")
    assert doc(db, job.document_id) == ("failed", 0, "No extractable text")

    again = enqueue(store, tenant, data)
    assert again.created and again.document_id != accepted.document_id
    assert doc(db, accepted.document_id) is None  # the failed row was replaced


def test_rls_blocks_enqueueing_into_another_tenants_collection(db, store, tenant):
    other_client = db.execute(
        "INSERT INTO clients (client_id, secret_hash, name) VALUES (%s, 'x', 'other') RETURNING id",
        (f"it-queue-{uuid.uuid4()}",),
    ).fetchone()[0]
    try:
        _, collection_id = tenant
        with pytest.raises(InsufficientPrivilege):
            enqueue(store, (str(other_client), collection_id))
    finally:
        db.execute("DELETE FROM clients WHERE id = %s", (other_client,))
