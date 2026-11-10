"""Ingestion, in two halves.

accept()  (request path, milliseconds): detect type → hash → dedupe → enqueue a `processing` document.
process() (background worker): parse → chunk → embed → store chunks and mark the document `ready`.
"""

import hashlib
import logging
from dataclasses import dataclass
from pathlib import PurePath

from app.chunker import TokenCounter, chunk_text
from app.config import Settings
from app.embedder import Embedder
from app.parsers import Section, detect_kind, parse
from app.store import ChunkRow, Job, Store

log = logging.getLogger("rag.ingest")

_MIME = {"pdf": "application/pdf", "markdown": "text/markdown", "text": "text/plain"}


class EmptyDocument(ValueError):
    pass


@dataclass(frozen=True)
class AcceptResult:
    document_id: str
    created: bool  # False = identical file was already in this collection
    status: str  # processing | ready | failed
    chunk_count: int


@dataclass(frozen=True)
class ProcessOutcome:
    document_id: str
    outcome: str  # ready | failed | retry | cancelled
    detail: str = ""


def context_header(filename: str, section: Section) -> str:
    """'handbook > Deploys > Rollback': prepended to each chunk's *embedding input* only.

    A chunk from the middle of a section often never names its topic ("Run the script
    twice..."). Prefixing where it came from lets the vector capture that context.
    """
    return " > ".join([PurePath(filename).stem, *section.metadata.get("heading_path", [])])


class IngestPipeline:
    def __init__(self, settings: Settings, count_tokens: TokenCounter, embedder: Embedder, store: Store):
        self._settings = settings
        self._count = count_tokens
        self._embedder = embedder
        self._store = store

    def accept(
        self, client_id: str, collection_id: str, filename: str, content_type: str | None, data: bytes
    ) -> AcceptResult:
        """Validate cheaply and enqueue. Everything slow happens in process(), off the request path."""
        kind = detect_kind(filename, content_type)  # raises UnsupportedFileType → 415 right away
        sha256 = hashlib.sha256(data).hexdigest()
        result = self._store.enqueue_document(client_id, collection_id, filename, _MIME[kind], kind, sha256, data)
        return AcceptResult(result.document_id, result.created, result.status, result.chunk_count)

    def process_next(self) -> ProcessOutcome | None:
        """Claim and process one job. None = the queue had nothing runnable."""
        job = self._store.claim_job(self._settings.ingest_lease_seconds)
        return self.process(job) if job else None

    def process(self, job: Job) -> ProcessOutcome:
        try:
            rows, embed_inputs = self._chunk(job)
        except Exception as e:  # noqa: BLE001: any parse failure is a property of the file
            # Permanent: the same bytes will fail the same way, so don't retry.
            return self._fail(job, str(e) if isinstance(e, EmptyDocument) else f"Could not parse {job.filename!r}: {e}")

        try:
            # Embedding runs outside any DB transaction: it's the slow step, and holding a
            # transaction open during it would pin a connection and its locks for seconds.
            vectors = self._embedder.embed(embed_inputs, kind="document")
            chunk_rows = [
                ChunkRow(i, chunk.text, chunk.token_count, metadata, vector)
                for i, ((chunk, metadata), vector) in enumerate(zip(rows, vectors, strict=True))
            ]
            done = self._store.complete_document(job, self._embedder.model_id, chunk_rows)
        except Exception as e:  # noqa: BLE001: embedder down, timeout, DB blip: worth retrying
            return self._retry_or_fail(job, e)

        if not done:
            log.info("ingest cancelled", extra={"document_id": job.document_id})
            return ProcessOutcome(job.document_id, "cancelled")
        log.info("ingest ready", extra={"document_id": job.document_id, "chunks": len(chunk_rows)})
        return ProcessOutcome(job.document_id, "ready", f"{len(chunk_rows)} chunks")

    # ---------------------------------------------------------------- internals

    def _chunk(self, job: Job):
        rows, embed_inputs = [], []
        for section in parse(job.payload, job.kind):
            header = context_header(job.filename, section)
            # Reserve room for the header so header + chunk still fits the model's window.
            header_tokens = self._count(header) + 2
            max_tokens = self._settings.chunk_max_tokens - header_tokens
            for chunk in chunk_text(
                section.text,
                self._count,
                target_tokens=min(self._settings.chunk_target_tokens, max_tokens),
                max_tokens=max_tokens,
                overlap_tokens=self._settings.chunk_overlap_tokens,
            ):
                metadata = {**section.metadata, "context": header, "char_start": chunk.char_start, "char_end": chunk.char_end}
                rows.append((chunk, metadata))
                embed_inputs.append(f"{header}\n\n{chunk.text}")
        if not rows:
            raise EmptyDocument(f"No extractable text in {job.filename!r} (scanned PDF without a text layer?)")
        return rows, embed_inputs

    def _fail(self, job: Job, error: str) -> ProcessOutcome:
        if not self._store.fail_document(job, error):
            return ProcessOutcome(job.document_id, "cancelled")
        log.warning("ingest failed", extra={"document_id": job.document_id, "error": error})
        return ProcessOutcome(job.document_id, "failed", error)

    def _retry_or_fail(self, job: Job, err: Exception) -> ProcessOutcome:
        error = f"{type(err).__name__}: {err}"
        if job.attempts >= self._settings.ingest_max_attempts:
            return self._fail(job, f"Gave up after {job.attempts} attempts. Last error: {error}")
        # Exponential backoff: base, 2×base, 4×base… so a struggling embedder isn't hammered.
        delay = self._settings.ingest_retry_base_seconds * 2 ** (job.attempts - 1)
        self._store.retry_later(job, delay, error)
        log.warning("ingest retry", extra={"document_id": job.document_id, "attempt": job.attempts, "error": error})
        return ProcessOutcome(job.document_id, "retry", error)
