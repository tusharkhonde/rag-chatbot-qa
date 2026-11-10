import pytest

from app.config import Settings
from app.parsers import Section, UnsupportedFileType
from app.pipeline import IngestPipeline, context_header
from app.store import Enqueued, Job


class FakeEmbedder:
    model_id, dim = "fake:model", 3

    def __init__(self, fail_times: int = 0):
        self.inputs: list[str] = []
        self.fail_times = fail_times

    def embed(self, texts, kind):
        assert kind == "document"
        if self.fail_times:
            self.fail_times -= 1
            raise ConnectionError("embedder unreachable")
        self.inputs.extend(texts)
        return [[1.0, 0.0, 0.0] for _ in texts]


class FakeStore:
    """In-memory stand-in for the queue half of Store. Postgres behaviour (SKIP LOCKED, RLS,
    leases) is covered by tests/integration/test_queue.py."""

    def __init__(self, existing: Enqueued | None = None, cancelled: bool = False):
        self.existing = existing
        self.cancelled = cancelled
        self.enqueued: dict | None = None
        self.completed: dict | None = None
        self.failed: str | None = None
        self.retries: list[tuple[float, str]] = []
        self.jobs: list[Job] = []

    def enqueue_document(self, client_id, collection_id, filename, mime_type, kind, sha256, data):
        if self.existing:
            return self.existing
        self.enqueued = dict(client_id=client_id, filename=filename, mime_type=mime_type, kind=kind, sha256=sha256)
        return Enqueued("doc-1", True, "processing", 0)

    def claim_job(self, lease_seconds):
        return self.jobs.pop(0) if self.jobs else None

    def complete_document(self, job, embedding_model, chunks):
        if self.cancelled:
            return False
        self.completed = dict(model=embedding_model, chunks=chunks, client_id=job.client_id)
        return True

    def fail_document(self, job, error):
        self.failed = error
        return not self.cancelled

    def retry_later(self, job, delay, error):
        self.retries.append((delay, error))


def make_pipeline(store, embedder=None, **env):
    settings = Settings.from_env({k.upper(): str(v) for k, v in env.items()})  # independent of the host env
    words = lambda t: len(t.split())
    return IngestPipeline(settings, words, embedder or FakeEmbedder(), store)


def job(payload=b"# Deploys\n## Rollback\nRun rollback.sh twice.", kind="markdown", attempts=1, filename="runbook.md"):
    return Job("doc-1", "t1", "c1", filename, kind, payload, attempts)


def test_context_header_uses_filename_stem_and_heading_path():
    assert context_header("docs/runbook.md", Section("x", {"heading_path": ["Deploys", "Rollback"]})) == (
        "runbook > Deploys > Rollback"
    )
    assert context_header("report.pdf", Section("x", {"page": 2})) == "report"


# ------------------------------------------------------------------ accept (request path)


def test_accept_enqueues_without_parsing_or_embedding():
    store, embedder = FakeStore(), FakeEmbedder()
    result = make_pipeline(store, embedder).accept("t1", "c1", "runbook.md", None, b"# Hi\nThere.")
    assert (result.document_id, result.created, result.status, result.chunk_count) == ("doc-1", True, "processing", 0)
    assert store.enqueued["kind"] == "markdown" and store.enqueued["mime_type"] == "text/markdown"
    assert store.enqueued["client_id"] == "t1"  # the enqueue runs as the tenant (RLS)
    assert len(store.enqueued["sha256"]) == 64
    assert embedder.inputs == []


def test_accept_returns_the_existing_document_for_a_duplicate():
    store = FakeStore(existing=Enqueued("doc-0", False, "ready", 7))
    result = make_pipeline(store).accept("t1", "c1", "a.txt", None, b"hello")
    assert (result.document_id, result.created, result.status, result.chunk_count) == ("doc-0", False, "ready", 7)


def test_accept_rejects_unsupported_types_synchronously():
    with pytest.raises(UnsupportedFileType):
        make_pipeline(FakeStore()).accept("t1", "c1", "photo.png", "image/png", b"\x89PNG")


# ------------------------------------------------------------------ process (worker)


def test_process_embeds_header_plus_chunk_but_stores_raw_chunk():
    store, embedder = FakeStore(), FakeEmbedder()
    outcome = make_pipeline(store, embedder).process(job())

    assert outcome.outcome == "ready"
    [row] = store.completed["chunks"]
    assert row.content == "Run rollback.sh twice."
    assert row.metadata["heading_path"] == ["Deploys", "Rollback"]
    assert row.metadata["context"] == "runbook > Deploys > Rollback"  # feeds the weighted keyword index
    assert embedder.inputs == ["runbook > Deploys > Rollback\n\nRun rollback.sh twice."]
    assert store.completed["model"] == "fake:model" and store.completed["client_id"] == "t1"


def test_a_document_without_text_fails_permanently_without_retrying():
    store, embedder = FakeStore(), FakeEmbedder()
    outcome = make_pipeline(store, embedder).process(job(payload=b"   \n\n  ", kind="text", filename="blank.txt"))
    assert outcome.outcome == "failed"
    assert "No extractable text" in store.failed
    assert store.retries == [] and embedder.inputs == []


def test_an_unparseable_file_fails_permanently():
    store = FakeStore()
    outcome = make_pipeline(store).process(job(payload=b"not a pdf at all", kind="pdf", filename="broken.pdf"))
    assert outcome.outcome == "failed" and "Could not parse 'broken.pdf'" in store.failed


def test_a_transient_error_is_retried_with_exponential_backoff_then_given_up():
    store = FakeStore()
    pipeline = make_pipeline(store, FakeEmbedder(fail_times=10), ingest_retry_base_seconds=10, ingest_max_attempts=3)

    assert pipeline.process(job(attempts=1)).outcome == "retry"
    assert pipeline.process(job(attempts=2)).outcome == "retry"
    assert [d for d, _ in store.retries] == [10, 20]
    assert "ConnectionError: embedder unreachable" in store.retries[0][1]

    outcome = pipeline.process(job(attempts=3))
    assert outcome.outcome == "failed"
    assert store.failed.startswith("Gave up after 3 attempts") and store.completed is None


def test_a_retry_succeeds_once_the_embedder_is_back():
    store = FakeStore()
    pipeline = make_pipeline(store, FakeEmbedder(fail_times=1))
    assert pipeline.process(job(attempts=1)).outcome == "retry"
    assert pipeline.process(job(attempts=2)).outcome == "ready"


def test_a_document_deleted_while_processing_is_cancelled():
    store = FakeStore(cancelled=True)
    assert make_pipeline(store).process(job()).outcome == "cancelled"


def test_process_next_returns_none_on_an_empty_queue():
    store = FakeStore()
    pipeline = make_pipeline(store)
    assert pipeline.process_next() is None
    store.jobs.append(job())
    assert pipeline.process_next().outcome == "ready"
