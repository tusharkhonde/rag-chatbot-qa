#!/usr/bin/env bash
# End-to-end demo against a running stack (docker compose up --build):
# register a client → get a token → create a collection → upload samples (indexed in the
# background) → search → ask (streamed) → delete a document.
set -euo pipefail
cd "$(dirname "$0")/.."
API="${API:-http://localhost:3000}"

json() { python3 -c "import sys, json; d = json.load(sys.stdin); print($1)"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Register an API client (the secret is shown once, then stored only as an argon2id hash)"
creds=$(docker compose exec -T api node dist/cli/create-client.js --name "demo" --json)
client_id=$(echo "$creds" | json 'd["client_id"]')
client_secret=$(echo "$creds" | json 'd["client_secret"]')
echo "client_id=$client_id"

step "Exchange client credentials for a 15-minute access token (OAuth2 client_credentials)"
token=$(curl -sf -u "$client_id:$client_secret" -d grant_type=client_credentials "$API/oauth/token" | json 'd["access_token"]')
echo "${token:0:40}…"
auth=(-H "authorization: Bearer $token")

step "Create a collection and upload the sample documents (202 Accepted: indexed in the background)"
collection=$(curl -sf "${auth[@]}" -H 'content-type: application/json' -d '{"name":"acme-demo"}' "$API/collections" | json 'd["id"]')
docs=()
for f in samples/docs/*; do
  id=$(curl -sf "${auth[@]}" -F "file=@$f" "$API/collections/$collection/documents" | json 'd["documentId"]')
  echo "  $(basename "$f"): accepted ($id)"
  docs+=("$id")
done

step "Wait until the ml worker has parsed, chunked and embedded each one"
for id in "${docs[@]}"; do
  while :; do
    doc=$(curl -sf "${auth[@]}" "$API/collections/$collection/documents/$id")
    status=$(echo "$doc" | json 'd["status"]')
    [ "$status" = processing ] || break
    sleep 1
  done
  echo "$doc" | json "'  ' + d['filename'] + ': ' + d['status'] + ', ' + str(d['chunkCount']) + ' chunks' + (' (' + d['error'] + ')' if d['error'] else '')"
done

step "Hybrid search (retrieval only): 'NimbusUnderReplicated'"
curl -sf "${auth[@]}" -H 'content-type: application/json' \
  -d '{"query":"NimbusUnderReplicated","topK":3}' "$API/collections/$collection/search" |
  json "'\n'.join('  %.4f  %s' % (c['score'], ' › '.join([c['filename']] + c['metadata'].get('heading_path', [])[1:])) for c in d['chunks'])"

# Prints the SSE stream as it arrives: answer tokens, then citations and timings.
read -r -d '' SSE_READER <<'PY' || true
import json, sys
event = None
for line in sys.stdin:
    line = line.rstrip("\n")
    if line.startswith("event: "):
        event = line[7:]
    elif line.startswith("data: "):
        d = json.loads(line[6:])
        if event == "delta":
            print(d["text"], end="", flush=True)
        elif event == "done":
            print()
            for c in d["citations"]:
                print(f"  [{c['index']}] {c['label']}")
            t = d["timings"]
            print(f"  cached={d['cached']} refused={d['refused']} ttft={t.get('ttft', 0) / 1000:.1f}s total={t['total'] / 1000:.1f}s")
        elif event == "error":
            print("error:", d)
PY

ask() {
  step "Ask (streamed over SSE): $1"
  curl -sN "${auth[@]}" -H 'content-type: application/json' \
    -d "{\"question\": \"$1\", \"stream\": true}" "$API/collections/$collection/query" | python3 -c "$SSE_READER"
}
ask "How do I roll back a bad deploy, and does it need approval?"
ask "What is the CEO of Acme Orbital paid?"
ask "How do I roll back a bad deploy, and does it need approval?"   # answer cache hit

step "Delete a document: its chunks go with it, and cached answers for the collection are invalidated"
curl -sf -o /dev/null -w '  DELETE → %{http_code}\n' -X DELETE "${auth[@]}" "$API/collections/$collection/documents/${docs[0]}"
curl -sf "${auth[@]}" "$API/collections/$collection/documents" | json "'  remaining: ' + ', '.join(x['filename'] for x in d['documents'])"

step "Observability"
curl -sf "$API/ready" | json "'  ready: ' + str(d['ready']) + '  ' + str({k: v['ok'] for k, v in d['checks'].items()})"
curl -sf "$API/metrics" | grep -E '^rag_(answers_total|cache_requests_total|llm_tokens_total)' | sed 's/^/  /'
