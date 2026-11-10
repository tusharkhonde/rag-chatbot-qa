"""Background ingestion workers: threads in the ml process that drain the Postgres job queue.

Threads rather than a separate service keep the deployment at one container. Embedding is I/O
(an HTTP call to Ollama), so threads don't fight the GIL much. Running the worker as its own
process or container later is a deployment change, not a code change: the queue is in Postgres.
"""

import logging
import threading

from app.pipeline import IngestPipeline

log = logging.getLogger("rag.ingest")


class IngestWorkers:
    def __init__(self, pipeline: IngestPipeline, count: int, poll_seconds: float):
        self._pipeline = pipeline
        self._poll = poll_seconds
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads = [threading.Thread(target=self._run, name=f"ingest-{i}", daemon=True) for i in range(count)]

    def start(self) -> None:
        for t in self._threads:
            t.start()

    def wake(self) -> None:
        """Called after an upload is accepted, so a local worker starts at once instead of at the next poll."""
        self._wake.set()

    def stop(self, timeout: float = 30) -> None:
        # A job interrupted here keeps its lease and is reclaimed after INGEST_LEASE_SECONDS.
        self._stop.set()
        self._wake.set()
        for t in self._threads:
            t.join(timeout)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                outcome = self._pipeline.process_next()
            except Exception:  # noqa: BLE001: e.g. Postgres unreachable; keep the thread alive
                log.exception("ingest worker error")
                outcome = None
                self._stop.wait(self._poll * 5)
            if outcome is None:  # queue empty: sleep until woken or the next poll
                self._wake.wait(self._poll)
                self._wake.clear()
