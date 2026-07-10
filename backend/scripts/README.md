# Running `batch_multi_model.sh`

Runs the folder-driven batch test against Cosmos (vLLM) or the Ollama models, one model family per run. Runs from your **local machine** (needs the local `allocations/` folder) and just points at the server's backend over HTTP.

## 1. One-time: deploy backend code to the server

Sync these changed files to the server, then restart the backend process there:
```
backend/src/config/models.js
backend/src/config/index.js
backend/src/controller/batchTest.controller.js
```

## 2. Run against Cosmos (vLLM)

Make sure Ollama is stopped on the server first (frees the GPU), then:

```bash
cd backend/scripts
LIMIT=2 MODELS=cosmos BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

vLLM starts itself automatically — no manual start step needed.

## 3. Run against Ollama models

```bash
# stop vLLM cleanly first
curl -X POST http://103.204.95.220:7086/api/stop

# start Ollama on the server (however you normally do it), then:
cd backend/scripts
LIMIT=2 MODELS="qwen3vl qwen35 gemma4" BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

You can list one or more Ollama models together — just never mix `cosmos` with an Ollama model in the same `MODELS` value (the script blocks that automatically, GPU conflict).

## Notes

- `LIMIT` caps how many allocations to test — use `LIMIT=2` for a quick check, drop it for a full run.
- Output: one CSV + one log file per model, timestamped, in `backend/scripts/`.
- Env vars you might also need: `ALLOCATIONS_DIR` (defaults to local `allocations/`), `PROMPT_VERSION` (defaults `R1`).
