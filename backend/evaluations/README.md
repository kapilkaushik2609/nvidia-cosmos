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
cd backend/evaluations
LIMIT=2 MODELS=cosmos BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

vLLM starts itself automatically — no manual start step needed.

## 3. Run against Ollama models

```bash
# stop vLLM cleanly first
curl -X POST http://103.204.95.220:7086/api/stop

# start Ollama on the server (however you normally do it), then:
cd backend/evaluations
LIMIT=2 MODELS="qwen3vl qwen35 gemma4 qwen36" BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

`qwen36` (`qwen3.6:35b`, pulled on the server 2026-07-13) is the newest addition — same as the other Ollama entries, just add/remove it from `MODELS`. To run only the new model against everything already covered by the other three:

```bash
LIMIT=0 MODELS=qwen36 BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
```

You can list one or more Ollama models together — just never mix `cosmos` with an Ollama model in the same `MODELS` value (the script blocks that automatically, GPU conflict).

## Notes

- `LIMIT` caps how many allocations to test — use `LIMIT=2` for a quick check, drop it for a full run (or `LIMIT=0`, the default).
- Output: one CSV per model in `backend/evaluations/results/`, named `<date>_model_<PROMPT_VERSION>_<modelId>.csv` (e.g. `2026-07-13_model_R1_qwen36.csv`) — this is the naming convention to follow from now on for anything saved there. One log file per model stays next to the script (`batch_multi_model_<modelId>.log`).
  - `RUN_DATE` defaults to today and is baked into the CSV filename — re-running the *same command on the same day* resumes (already-processed allocation IDs are skipped). Resuming a prior day's run requires passing that day's `RUN_DATE` explicitly, since the filename changes daily. Set `RESET=1` to wipe a model's output file for the day and start over from scratch.
- Env vars you might also need: `ALLOCATIONS_DIR` (defaults to local `allocations/`), `PROMPT_VERSION` (defaults `R1`), `RESULTS_DIR` (defaults to `backend/evaluations/results/`), `RUN_DATE` (defaults to today, `YYYY-MM-DD`).

## Model probing (visual-perception column)

Per Rahul's ask (call on 2026-07-10): a plain "describe the image" prompt, kept completely separate from the compliance assessment, so a model's raw visual-perception quality can be judged independently of its compliance reasoning.

Implementation: for every allocation, the script now makes a **second** call to `/api/analyze-simulation-local` with `mode: "probe"` — same image as the compliance call, but a minimal dedicated prompt (`backend/prompts/probe_R1.txt`):

> Look only at the attached image and describe what you see: what the layout is like, how many racks and aisles you see, and the temperature statistics you see. Do not give a compliance status, risk rating, or any assessment — this is a visual description only.

## Comparing models (per Rahul's ask, call on 2026-07-13)

Two scripts, both reading every CSV in `results/`, both writing a per-row detail CSV + a per-model summary CSV back into `results/`. Run one, both, or neither — they don't depend on each other.

- **`score_perception_factual.py`** — deterministic, no LLM calls. Regex-extracts the concrete facts a model's `model_probe` text claims (rack count, row/aisle count, peak temperature) and checks them against the real facility config (`allocations/<id>/config.json`) and that row's own `actual_max_temp`. Free, instant, fully explainable — but only catches facts reducible to a number.
- **`score_perception_llm_judge.py`** — asks a judge model (default `qwen3.6:35b` via Ollama) to grade the qualitative parts a regex can't: layout description quality, completeness, and hallucination (stating specifics that contradict the real facility data). Costs one extra inference call per row and its scores are the judge's opinion, not ground truth. Talks directly to Ollama/vLLM's own API — no backend changes needed — but that means it needs network access to the judge model's port (tunnel it if not exposed externally).

Recommendation: run the factual scorer first (it's free) to get an objective floor, then run the LLM judge for the harder-to-quantify parts (layout/completeness/hallucination) if you want a richer picture for the client.

For the compliance side (the 7-category columns), the existing `is_correct`/`comments` columns already give ground-truth-checked accuracy per row (via `auto_check` in `batch_multi_model.sh`) — aggregate those per model for the compliance comparison Rahul asked for; no new script needed there yet.

The raw response lands in the `model_probe` column, which is the **last** column of the CSV (after `model_label`). No `PROMPT_VERSION=R2` needed — this now always runs alongside the compliance call, one extra request per allocation, so a full run takes roughly 2x as long per model as before.

## Gotcha: reasoning models returning empty results

Reasoning-style models (e.g. `qwen35`, and sometimes `qwen3vl`) can burn their whole `max_tokens` budget on hidden "thinking" tokens and never emit a final answer — the API response comes back with `"result": ""` and `completion_tokens` exactly equal to `max_tokens`.

Root cause, confirmed 2026-07-10 by curling Ollama directly on the server: Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) puts reasoning output in a separate `"reasoning"` field and leaves `content` empty until thinking finishes — and it silently ignores a `think` passthrough field since that's not part of the OpenAI schema it decodes, so `think: false` has no effect there. Ollama's *native* `/api/chat` endpoint does honor `think: false` (verified: same trivial prompt returned real content instantly).

Fix: `batchTest.controller.js` now routes Ollama-provider models through `/api/chat` (native shape — image goes in an `images: []` array on the message, not `image_url` content parts) with `think: false`, while vLLM (Cosmos) keeps using `/v1/chat/completions` unchanged. If a new Ollama model still comes back empty after this, check the raw response in the per-model `.log` file — it may not support `think` at all (older model) or may need a different disable mechanism.
