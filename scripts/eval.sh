#!/usr/bin/env bash
# Run the offline evaluation inside the compose network (no local Python needed).
#   scripts/eval.sh                      # retrieval metrics for hybrid, vector and keyword modes
#   scripts/eval.sh --generate --limit 5 # plus answer quality for 5 answerable + 5 unanswerable questions per dataset
#   scripts/eval.sh --conversations      # plus follow-up questions with vs without chat history (LLM calls)
#   scripts/eval.sh --dataset dataset.jsonl  # one dataset only (default: original + paraphrased)
set -euo pipefail
cd "$(dirname "$0")/.."

# A dedicated client per run keeps eval data in its own tenant (it never touches real collections).
creds="${EVAL_CREDENTIALS:-$(docker compose exec -T api node dist/cli/create-client.js --name "eval" --json)}"

docker run --rm \
  --network rag_default \
  -e EVAL_CREDENTIALS="$creds" \
  -e LLM_MODEL="${LLM_MODEL:-qwen2.5:7b}" \
  -v "$PWD/eval:/eval" \
  -v "$PWD/samples:/samples:ro" \
  -w /eval \
  python:3.12-slim python run_eval.py "$@"
