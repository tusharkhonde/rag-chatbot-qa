import os
from dataclasses import dataclass

# Defaults that only make sense together, per provider. Any of them can still be overridden by env.
_PROVIDER_DEFAULTS: dict[str, dict[str, str]] = {
    # nomic-embed-text: 768-d, 8k-token window, trained with task prefixes on BOTH sides.
    "ollama": {
        "EMBEDDING_MODEL": "nomic-embed-text",
        "EMBED_QUERY_PREFIX": "search_query: ",
        "EMBED_DOCUMENT_PREFIX": "search_document: ",
        "CHUNK_TARGET_TOKENS": "600",
        "CHUNK_MAX_TOKENS": "800",
        "CHUNK_OVERLAP_TOKENS": "80",
    },
    "openai": {
        "EMBEDDING_MODEL": "text-embedding-3-small",
        "EMBED_QUERY_PREFIX": "",
        "EMBED_DOCUMENT_PREFIX": "",
        "CHUNK_TARGET_TOKENS": "600",
        "CHUNK_MAX_TOKENS": "800",
        "CHUNK_OVERLAP_TOKENS": "80",
    },
}


@dataclass(frozen=True)
class Settings:
    database_url: str
    embeddings_provider: str  # ollama | openai
    embedding_model: str
    embedding_dim: int  # must match vector(N) in db/migrations/001_init.sql
    query_prefix: str
    document_prefix: str
    ollama_url: str
    ollama_num_ctx: int
    openai_base_url: str
    openai_api_key: str
    chunk_target_tokens: int
    chunk_max_tokens: int
    chunk_overlap_tokens: int
    max_upload_bytes: int
    ingest_workers: int  # background worker threads in this process (0 = accept uploads only)
    ingest_poll_seconds: float
    ingest_max_attempts: int
    ingest_retry_base_seconds: float
    ingest_lease_seconds: int  # a claimed job not finished within this is reclaimed (worker died)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        provider = env.get("EMBEDDINGS_PROVIDER", "ollama")
        if provider not in _PROVIDER_DEFAULTS:
            raise ValueError(f"Unknown EMBEDDINGS_PROVIDER {provider!r}")
        get = lambda key, default=None: env.get(key, _PROVIDER_DEFAULTS[provider].get(key, default))
        return cls(
            database_url=get("DATABASE_URL", "postgresql://rag:rag@localhost:5432/rag"),
            embeddings_provider=provider,
            embedding_model=get("EMBEDDING_MODEL"),
            embedding_dim=int(get("EMBEDDING_DIM", "768")),
            query_prefix=get("EMBED_QUERY_PREFIX"),
            document_prefix=get("EMBED_DOCUMENT_PREFIX"),
            ollama_url=get("OLLAMA_URL", "http://localhost:11434"),
            # Chunks max out around 800 (estimated) tokens + a short header; 2048 leaves ~2.5x
            # margin for the approximate counter while keeping Ollama's memory use small.
            ollama_num_ctx=int(get("OLLAMA_NUM_CTX", "2048")),
            openai_base_url=get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            openai_api_key=get("OPENAI_API_KEY", ""),
            chunk_target_tokens=int(get("CHUNK_TARGET_TOKENS")),
            chunk_max_tokens=int(get("CHUNK_MAX_TOKENS")),
            chunk_overlap_tokens=int(get("CHUNK_OVERLAP_TOKENS")),
            max_upload_bytes=int(get("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024))),
            ingest_workers=int(get("INGEST_WORKERS", "1")),
            ingest_poll_seconds=float(get("INGEST_POLL_SECONDS", "1")),
            ingest_max_attempts=int(get("INGEST_MAX_ATTEMPTS", "3")),
            ingest_retry_base_seconds=float(get("INGEST_RETRY_BASE_SECONDS", "10")),
            # Longer than the slowest legitimate job (a large PDF on CPU embeddings).
            ingest_lease_seconds=int(get("INGEST_LEASE_SECONDS", "900")),
        )
