# Running `batch_multi_model.sh`

Runs the folder-driven batch test against Cosmos (vLLM) or the Ollama models, one model family per run. Runs from your **local machine** (needs the local `allocations/` folder) and just points at the server's backend over HTTP.

## 1. One-time: deploy backend code to the server

Sync these changed files to the server, then restart the backend process there:
```
backend/src/config/models.js
backend/src/config/index.js
backend/src/controller/batchTest.controller.js
backend/prompts/probe_R1.txt
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
LIMIT=2 MODELS="qwen3vl qwen35 gemma4 qwen36" BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

`qwen36` (`qwen3.6:35b`, pulled on the server 2026-07-13) is the newest addition — same as the other Ollama entries, just add/remove it from `MODELS`. To run only the new model against everything already covered by the other three:

```bash
LIMIT=0 MODELS=qwen36 BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

You can list one or more Ollama models together — just never mix `cosmos` with an Ollama model in the same `MODELS` value (the script blocks that automatically, GPU conflict).

## Notes

- `LIMIT` caps how many allocations to test — use `LIMIT=2` for a quick check, drop it for a full run (or `LIMIT=0`, the default).
- Output: one CSV + one log file per model, in `backend/scripts/` — filenames are stable (`test_multi_model_<PROMPT_VERSION>_<modelId>.csv`, `batch_multi_model_<modelId>.log`), not timestamped, so an interrupted run can be resumed by just re-running the same command (already-processed allocation IDs are skipped). Set `RESET=1` to wipe a model's output and start that model over from scratch.
- Env vars you might also need: `ALLOCATIONS_DIR` (defaults to local `allocations/`), `PROMPT_VERSION` (defaults `R1`).

## Model probing (visual-perception column)

Per Rahul's ask (call on 2026-07-10): a plain "describe the image" prompt, kept completely separate from the compliance assessment, so a model's raw visual-perception quality can be judged independently of its compliance reasoning.

Implementation: for every allocation, the script now makes a **second** call to `/api/analyze-simulation-local` with `mode: "probe"` — same image as the compliance call, but a minimal dedicated prompt (`backend/prompts/probe_R1.txt`):

> Look only at the attached image and describe what you see: what the layout is like, how many racks and aisles you see, and the temperature statistics you see. Do not give a compliance status, risk rating, or any assessment — this is a visual description only.

The raw response lands in the `model_probe` column, which is the **last** column of the CSV (after `model_label`). No `PROMPT_VERSION=R2` needed — this now always runs alongside the compliance call, one extra request per allocation, so a full run takes roughly 2x as long per model as before.

## Gotcha: reasoning models returning empty results

Reasoning-style models (e.g. `qwen35`, and sometimes `qwen3vl`) can burn their whole `max_tokens` budget on hidden "thinking" tokens and never emit a final answer — the API response comes back with `"result": ""` and `completion_tokens` exactly equal to `max_tokens`.

Root cause, confirmed 2026-07-10 by curling Ollama directly on the server: Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) puts reasoning output in a separate `"reasoning"` field and leaves `content` empty until thinking finishes — and it silently ignores a `think` passthrough field since that's not part of the OpenAI schema it decodes, so `think: false` has no effect there. Ollama's *native* `/api/chat` endpoint does honor `think: false` (verified: same trivial prompt returned real content instantly).

Fix: `batchTest.controller.js` now routes Ollama-provider models through `/api/chat` (native shape — image goes in an `images: []` array on the message, not `image_url` content parts) with `think: false`, while vLLM (Cosmos) keeps using `/v1/chat/completions` unchanged. If a new Ollama model still comes back empty after this, check the raw response in the per-model `.log` file — it may not support `think` at all (older model) or may need a different disable mechanism.
