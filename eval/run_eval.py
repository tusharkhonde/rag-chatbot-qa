"""Offline evaluation of the RAG pipeline against eval/dataset.jsonl.

Retrieval (always, every mode): precision@k, hit@k (= recall@k with one gold passage), MRR,
plus the top-vector-score distribution for answerable vs unanswerable questions (to calibrate
RETRIEVAL_HIT_THRESHOLD).
Generation (--generate): key-fact coverage, citation accuracy, answer/reference similarity,
LLM-as-judge score, refusal accuracy on unanswerable questions, latency percentiles, tokens.

Standard library only. Runs inside the compose network via scripts/eval.sh.
"""

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from metrics import cosine, hit_at_k, is_relevant, mean, percentile, phrase_coverage, precision_at_k, reciprocal_rank

HERE = Path(__file__).parent

JUDGE_PROMPT = """You grade answers produced by a document question-answering system.

Question: {question}
Reference answer: {reference}
System answer: {answer}

Score the system answer from 1 to 5:
5 = correct and complete relative to the reference
4 = correct but missing a minor detail
3 = partially correct, or missing a key detail
2 = mostly incorrect
1 = wrong, irrelevant, or a refusal
Judge only factual agreement with the reference, not style or citation markers.
Reply with JSON only: {{"score": <1-5>, "reason": "<one sentence>"}}"""


# ------------------------------------------------------------------ HTTP helpers


def http(method: str, url: str, body=None, headers=None, timeout=600):
    data, hdrs = None, dict(headers or {})
    if isinstance(body, (dict, list)):
        data, hdrs["content-type"] = json.dumps(body).encode(), "application/json"
    elif isinstance(body, bytes):
        data = body
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def multipart(field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


class Api:
    def __init__(self, base: str, client_id: str, client_secret: str):
        self.base = base.rstrip("/")
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        req = urllib.request.Request(
            f"{self.base}/oauth/token",
            data=b"grant_type=client_credentials",
            headers={"authorization": f"Basic {basic}", "content-type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as res:
            self.auth = {"authorization": f"Bearer {json.loads(res.read())['access_token']}"}

    def call(self, method, path, body=None, headers=None):
        return http(method, f"{self.base}{path}", body, {**self.auth, **(headers or {})})

    def ensure_collection(self, name: str, docs_dir: Path) -> str:
        status, body = self.call("POST", "/collections", {"name": name})
        if status == 201:
            collection_id = body["id"]
        elif status == 409:
            _, listing = self.call("GET", "/collections")
            collection_id = next(c["id"] for c in listing["collections"] if c["name"] == name)
        else:
            raise SystemExit(f"cannot create collection: {status} {body}")
        pending = {}
        for path in sorted(docs_dir.iterdir()):
            payload, ctype = multipart("file", path.name, path.read_bytes())
            status, body = self.call("POST", f"/collections/{collection_id}/documents", payload, {"content-type": ctype})
            if status not in (200, 202):
                raise SystemExit(f"upload of {path.name} failed: {status} {body}")
            pending[body["documentId"]] = path.name
        self.wait_until_ready(collection_id, pending)
        return collection_id

    def wait_until_ready(self, collection_id: str, pending: dict[str, str], timeout_s: float = 600) -> None:
        """Uploads are accepted (202) and indexed in the background: poll until every one is ready."""
        deadline = time.monotonic() + timeout_s
        while pending:
            for document_id, name in list(pending.items()):
                status, doc = self.call("GET", f"/collections/{collection_id}/documents/{document_id}")
                if status != 200:
                    raise SystemExit(f"cannot read {name}: {status} {doc}")
                if doc["status"] == "failed":
                    raise SystemExit(f"ingestion of {name} failed: {doc['error']}")
                if doc["status"] == "ready":
                    del pending[document_id]
            if pending and time.monotonic() > deadline:
                raise SystemExit(f"timed out waiting for {sorted(pending.values())}")
            if pending:
                time.sleep(1)


# ------------------------------------------------------------------ evaluation


def eval_retrieval(api: Api, collection_id: str, items: list[dict], modes: list[str], k: int) -> dict:
    per_mode, rows = {}, {}
    for mode in modes:
        p, h, rr = [], [], []
        for item in items:
            status, res = api.call("POST", f"/collections/{collection_id}/search", {"query": item["question"], "mode": mode, "topK": k})
            if status != 200:
                raise SystemExit(f"search failed: {status} {res}")
            row = rows.setdefault(item["id"], {"id": item["id"], "answerable": item["expected_doc"] is not None})
            if mode == "hybrid" or "top_vector_score" not in row:
                row["top_vector_score"] = res["topVectorScore"]
            if item["expected_doc"] is None:
                continue
            relevant = [is_relevant(c, item) for c in res["chunks"]]
            p.append(precision_at_k(relevant, k))
            h.append(hit_at_k(relevant, k))
            rr.append(reciprocal_rank(relevant))
            row[f"{mode}_rank"] = next((i + 1 for i, r in enumerate(relevant) if r), None)
        per_mode[mode] = {"precision_at_k": mean(p), "hit_at_k": mean(h), "mrr": mean(rr), "n": len(p)}
    return {"modes": per_mode, "rows": list(rows.values())}


def judge(llm_url: str, model: str, item: dict, answer: str) -> dict:
    prompt = JUDGE_PROMPT.format(question=item["question"], reference=item["reference_answer"], answer=answer)
    status, res = http("POST", f"{llm_url}/chat/completions", {
        "model": model, "temperature": 0, "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": prompt}],
    })
    try:
        verdict = json.loads(res["choices"][0]["message"]["content"])
        return {"score": int(verdict["score"]), "reason": str(verdict.get("reason", ""))}
    except (KeyError, ValueError, TypeError):
        return {"score": None, "reason": f"unparseable judge output (status {status})"}


def eval_generation(api: Api, collection_id: str, items: list[dict], args) -> dict:
    rows = []
    for n, item in enumerate(items, 1):
        started = time.perf_counter()
        status, res = api.call("POST", f"/collections/{collection_id}/query", {"question": item["question"]})
        wall = time.perf_counter() - started
        if status != 200:
            raise SystemExit(f"query failed: {status} {res}")
        row = {
            "id": item["id"], "answerable": item["expected_doc"] is not None, "answer": res["answer"],
            "refused": res["refused"], "cached": res["cached"], "latency_s": wall,
            "ttft_s": (res["timings"].get("ttft") or 0) / 1000 or None, "usage": res["usage"],
            "invalid_citations": len(res["invalidCitations"]),
        }
        if row["answerable"]:
            row["coverage"] = phrase_coverage(res["answer"], item["expected_phrases"])
            row["citation_ok"] = any(c["filename"] == item["expected_doc"] for c in res["citations"])
            _, emb = http("POST", f"{args.ml}/embed", {"texts": [res["answer"], item["reference_answer"]], "kind": "document"})
            row["similarity"] = cosine(*emb["embeddings"])
            row["judge"] = judge(args.llm, args.judge_model, item, res["answer"]) if not args.no_judge else None
        print(f"  [{n}/{len(items)}] {item['id']}: {'refused' if row['refused'] else 'answered'} in {wall:.1f}s", flush=True)
        rows.append(row)

    answerable = [r for r in rows if r["answerable"]]
    unanswerable = [r for r in rows if not r["answerable"]]
    fresh = [r for r in rows if not r["cached"]]  # cached answers would make latency look free
    scores = [r["judge"]["score"] for r in answerable if r.get("judge") and r["judge"]["score"]]
    return {
        "rows": rows,
        "summary": {
            "key_fact_coverage": mean([r["coverage"] for r in answerable]),
            "citation_accuracy": mean([float(r["citation_ok"]) for r in answerable]),
            "answer_similarity": mean([r["similarity"] for r in answerable]),
            "judge_score": mean(scores),
            "false_refusal_rate": mean([float(r["refused"]) for r in answerable]),
            "correct_refusal_rate": mean([float(r["refused"]) for r in unanswerable]),
            "invalid_citations": sum(r["invalid_citations"] for r in rows),
            "latency_p50_s": percentile([r["latency_s"] for r in fresh], 50),
            "latency_p95_s": percentile([r["latency_s"] for r in fresh], 95),
            "ttft_p50_s": percentile([r["ttft_s"] for r in fresh if r["ttft_s"]], 50),
            "ttft_p95_s": percentile([r["ttft_s"] for r in fresh if r["ttft_s"]], 95),
            "prompt_tokens": sum((r["usage"] or {}).get("promptTokens", 0) for r in fresh),
            "completion_tokens": sum((r["usage"] or {}).get("completionTokens", 0) for r in fresh),
            "fresh_answers": len(fresh),
        },
    }


# ------------------------------------------------------------------ report


def fmt(v, digits=3):
    return "–" if v is None else (f"{v:.{digits}f}" if isinstance(v, float) else str(v))


def report(args, retrieval: dict, generation: dict | None, threshold: float) -> str:
    lines = [
        "# RAG evaluation report",
        "",
        f"- Run: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"- Dataset: {args.dataset} · k = {args.k}",
        "",
        "## Retrieval",
        "",
        "Relevant chunk = from the expected document **and** containing an expected phrase.",
        "hit@k equals recall@k here (one gold passage per question). precision@k is capped by how many",
        "relevant chunks exist, so read it together with hit@k and MRR.",
        "",
        "| mode | precision@k | hit@k (recall@k) | MRR | questions |",
        "|---|---|---|---|---|",
    ]
    for mode, m in retrieval["modes"].items():
        lines.append(f"| {mode} | {fmt(m['precision_at_k'])} | {fmt(m['hit_at_k'])} | {fmt(m['mrr'])} | {m['n']} |")

    ans = [r["top_vector_score"] for r in retrieval["rows"] if r["answerable"] and r["top_vector_score"] is not None]
    una = [r["top_vector_score"] for r in retrieval["rows"] if not r["answerable"] and r["top_vector_score"] is not None]
    lines += [
        "",
        "### Retrieval confidence (top cosine similarity)",
        "",
        f"Used to calibrate `RETRIEVAL_HIT_THRESHOLD` (currently {threshold}). A good threshold separates the two rows.",
        "",
        "| questions | n | min | mean | max | share ≥ threshold |",
        "|---|---|---|---|---|---|",
    ]
    for label, vals in (("answerable", ans), ("unanswerable", una)):
        share = mean([float(v >= threshold) for v in vals])
        lines.append(f"| {label} | {len(vals)} | {fmt(min(vals) if vals else None)} | {fmt(mean(vals))} | {fmt(max(vals) if vals else None)} | {fmt(share)} |")

    lines += ["", "### Rank of first relevant chunk per question", "", "| question | " + " | ".join(retrieval["modes"]) + " |", "|---|" + "---|" * len(retrieval["modes"])]
    for r in retrieval["rows"]:
        if r["answerable"]:
            lines.append(f"| {r['id']} | " + " | ".join(fmt(r.get(f"{m}_rank")) for m in retrieval["modes"]) + " |")

    if generation:
        s = generation["summary"]
        lines += [
            "",
            "## Generation (hybrid retrieval)",
            "",
            "| metric | value |",
            "|---|---|",
            f"| key-fact coverage (answerable) | {fmt(s['key_fact_coverage'])} |",
            f"| citation accuracy (cites the expected doc) | {fmt(s['citation_accuracy'])} |",
            f"| answer ↔ reference similarity (cosine) | {fmt(s['answer_similarity'])} |",
            f"| LLM-as-judge score (1–5) | {fmt(s['judge_score'], 2)} |",
            f"| false refusals (answerable questions) | {fmt(s['false_refusal_rate'])} |",
            f"| correct refusals (unanswerable questions) | {fmt(s['correct_refusal_rate'])} |",
            f"| hallucinated citation markers | {s['invalid_citations']} |",
            f"| latency p50 / p95 (s) | {fmt(s['latency_p50_s'], 1)} / {fmt(s['latency_p95_s'], 1)} |",
            f"| time to first token p50 / p95 (s) | {fmt(s['ttft_p50_s'], 1)} / {fmt(s['ttft_p95_s'], 1)} |",
            f"| tokens (prompt / completion) | {s['prompt_tokens']} / {s['completion_tokens']} |",
            "",
            f"Latency and tokens cover the {s['fresh_answers']} uncached answers. The judge is the same model as the",
            "generator, which is known to bias scores upward (self-preference); treat it as a relative signal.",
            "",
            "| question | refused | coverage | cites doc | judge | answer |",
            "|---|---|---|---|---|---|",
        ]
        for r in generation["rows"]:
            answer = r["answer"].replace("\n", " ").replace("|", "\\|")
            answer = answer[:140] + ("…" if len(answer) > 140 else "")
            judge_score = (r.get("judge") or {}).get("score")
            lines.append(f"| {r['id']} | {r['refused']} | {fmt(r.get('coverage'), 2)} | {r.get('citation_ok', '–')} | {fmt(judge_score)} | {answer} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://api:3000")
    parser.add_argument("--ml", default="http://ml:8000")
    parser.add_argument("--llm", default="http://ollama:11434/v1", help="OpenAI-compatible base URL for the judge")
    parser.add_argument("--judge-model", default=os.environ.get("LLM_MODEL", "qwen2.5:7b"))
    parser.add_argument("--dataset", default=str(HERE / "dataset.jsonl"))
    parser.add_argument("--docs", default="/samples/docs")
    parser.add_argument("--collection", default="eval")
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--modes", default="hybrid,vector,keyword")
    parser.add_argument("--generate", action="store_true", help="also evaluate answers (slow on CPU)")
    parser.add_argument("--limit", type=int, help="only the first N answerable + N unanswerable questions (generation)")
    parser.add_argument("--no-judge", action="store_true")
    parser.add_argument("--threshold", type=float, default=0.6)
    args = parser.parse_args()

    creds = json.loads(os.environ["EVAL_CREDENTIALS"])
    api = Api(args.api, creds["client_id"], creds["client_secret"])
    items = [json.loads(line) for line in open(args.dataset) if line.strip()]
    collection_id = api.ensure_collection(args.collection, Path(args.docs))

    print(f"Retrieval eval: {len(items)} questions × modes {args.modes}")
    retrieval = eval_retrieval(api, collection_id, items, args.modes.split(","), args.k)
    for mode, m in retrieval["modes"].items():
        print(f"  {mode:8} precision@{args.k}={fmt(m['precision_at_k'])} hit@{args.k}={fmt(m['hit_at_k'])} MRR={fmt(m['mrr'])}")

    generation = None
    if args.generate:
        subset = items
        if args.limit:
            subset = [i for i in items if i["expected_doc"]][: args.limit] + [i for i in items if not i["expected_doc"]][: args.limit]
        print(f"Generation eval: {len(subset)} questions")
        generation = eval_generation(api, collection_id, subset, args)
        for key, value in generation["summary"].items():
            print(f"  {key}: {fmt(value)}")

    out_dir = HERE / "reports"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"report-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.md"
    path.write_text(report(args, retrieval, generation, args.threshold))
    print(f"Report: eval/reports/{path.name}")


if __name__ == "__main__":
    main()
