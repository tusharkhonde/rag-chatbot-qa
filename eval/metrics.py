"""Pure metric functions for the offline evaluation (no I/O, unit-tested in test_metrics.py)."""

import math
import re


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def is_relevant(chunk: dict, item: dict) -> bool:
    """A retrieved chunk is relevant if it comes from the expected document AND contains at least
    one expected phrase. Filename alone is too lenient (a 10-chunk doc would make most hits
    "relevant"); requiring the phrase checks that the chunk actually holds the answer."""
    if chunk["filename"] != item["expected_doc"]:
        return False
    content = normalize(chunk["content"])
    return any(normalize(p) in content for p in item["expected_phrases"])


# Small stopword list: enough to keep "how/the/is" from counting as shared vocabulary.
_STOPWORDS = set(
    "a an and are as at be by can do does for from has have how i if in is it its of on or so that the "
    "their then there they this to was we what when where which who why will with you your our us me my "
    "should must may any all into out up down one".split()
)


def content_words(text: str) -> set[str]:
    """Lower-cased words minus stopwords, with a crude plural strip ("deploys" ~ "deploy")."""
    words = re.findall(r"[a-z0-9][a-z0-9._-]*", text.lower())
    return {w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words if w not in _STOPWORDS}


def vocabulary_overlap(question: str, document: str) -> float:
    """Share of the question's content words that also appear in the document. High overlap makes
    keyword search look better than it would on real users' questions; the paraphrased set
    is written to keep this low."""
    q = content_words(question)
    return len(q & content_words(document)) / len(q) if q else 0.0


def precision_at_k(relevant: list[bool], k: int) -> float:
    """Share of the top k that is relevant. Capped by how many relevant chunks exist: with one
    answer-bearing chunk and k=5 the best possible score is 0.2, which is why it's reported
    alongside hit@k and MRR rather than on its own."""
    return sum(relevant[:k]) / k


def hit_at_k(relevant: list[bool], k: int) -> float:
    """1 if any relevant chunk is in the top k. Equals recall@k when a question has a single
    gold passage, the usual case in QA; this is the metric that bounds answer quality."""
    return 1.0 if any(relevant[:k]) else 0.0


def reciprocal_rank(relevant: list[bool]) -> float:
    """1/rank of the first relevant chunk (0 if none). Averaged over queries = MRR. Rewards
    putting the answer first: position matters because the LLM attends most to early context."""
    for i, rel in enumerate(relevant):
        if rel:
            return 1.0 / (i + 1)
    return 0.0


def phrase_coverage(answer: str, phrases: list[str]) -> float:
    """Share of key facts (expected phrases) that appear in the answer."""
    if not phrases:
        return 0.0
    text = normalize(answer)
    return sum(normalize(p) in text for p in phrases) / len(phrases)


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile (p in 0..100). p95 shows the tail users actually complain about."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None
