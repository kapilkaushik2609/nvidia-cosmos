# Plan — Multi-Model Batch Script (Cosmos vs. Ollama-served models)

> Status: planning only, nothing implemented yet.
> Supersedes the original draft of this file (2026-07-09) now that real Ollama model tags and the GPU-handoff approach are confirmed.

## Context

Rahul (client) wants Cosmos Reason's compliance-assessment output compared against other vision-language models — specifically the models already pulled on the same server (`103.204.95.220`) via Ollama: `qwen3-vl:8b`, `qwen3.5:9b`, `gemma4:e4b`. The prompt must be byte-identical across every model tested, and result files must be traceable (model + prompt version + timestamp).

Constraint confirmed by the user: **Ollama and Cosmos (vLLM) cannot run on the GPU at the same time** — running one requires the other to be stopped first. The user has decided this handoff stays **manual** (no script-driven `systemctl`/service management) — the new script processes one "model family" per invocation, and the user swaps services between runs themselves. Scope for now is the **local** Ollama models only (the two `:cloud`-tagged models don't touch the local GPU and are deferred).

The existing two batch scripts (`backend/scripts/batch_compliance.sh`, `backend/scripts/batch_compliance_folder.sh`) stay **completely untouched** — this is explicitly a new, third script. Confirmed via exploration that nothing about the existing backend/scripts has drifted from the original plan; this supersedes the original Phases 1–4 with concrete details now that real model tags and the GPU-handoff decision are known.

## What gets built

### 1. Model registry — `backend/src/config/models.js` (new file)

```js
const { VLLM_URL, MODEL } = require("./index");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

module.exports = {
  cosmos:   { label: "Cosmos3-Nano", provider: "vllm",   baseUrl: VLLM_URL,   model: MODEL },
  qwen3vl:  { label: "Qwen3-VL 8B",  provider: "ollama", baseUrl: OLLAMA_URL, model: "qwen3-vl:8b" },
  qwen35:   { label: "Qwen3.5 9B",   provider: "ollama", baseUrl: OLLAMA_URL, model: "qwen3.5:9b" },
  gemma4:   { label: "Gemma4 e4b",   provider: "ollama", baseUrl: OLLAMA_URL, model: "gemma4:e4b" },
};
```

`provider` field lets the controller know whether to run the Cosmos-specific `ensureVLLM()`/`resetIdle()` lifecycle (vllm only) or skip it (ollama — models load lazily on first request, no explicit start/stop needed).

Add `OLLAMA_URL` to `backend/src/config/index.js` exports and to `backend/.env.example` / `backend/.env` (default `http://127.0.0.1:11434`, matching the pattern already used for every other URL constant there).

### 2. Extend `backend/src/controller/batchTest.controller.js` (existing file, additive change)

Confirmed current behavior: `analyzeSimulationLocal` unconditionally calls `ensureVLLM()`, hardcodes `VLLM_URL`/`MODEL` from config for the `/v1/chat/completions` call, and reads no model selector from `req.body`.

Change:
- Destructure `modelId` from `req.body` (default `"cosmos"` if omitted — preserves exact current behavior for any existing caller).
- Look up the entry from `models.js`; 404/400 with a clear error if `modelId` isn't in the registry.
- Only call `ensureVLLM()` / `resetIdle()` when `entry.provider === "vllm"`.
- Use `entry.baseUrl` and `entry.model` instead of `VLLM_URL`/`MODEL` when building the `/v1/chat/completions` request — same request/response shape for both providers (Ollama's OpenAI-compatible endpoint accepts the same `messages`/`image_url` content-part shape vLLM does), so no other code in the controller changes.
- Response JSON gains a `model`/`modelId` echo field so the calling script can double check what actually answered.

This is the only change to existing backend code. `simulation.controller.js` (the real product API) stays untouched, exactly as already agreed.

### 3. New script — `backend/scripts/batch_multi_model.sh`

Folder-driven (reuses the same local `allocations/` data-sourcing as `batch_compliance_folder.sh` — report.json/config.json + temperature_summary.json + thermal_map.png, same jq pipeline for building `facility`/`rowStats`/`topRisks`, same image-resize step, same 7-section extraction / `auto_check` / CSV-writing helpers). Copy these proven building blocks rather than re-deriving them; the new parts are the model dimension and the GPU-safety guard.

Key differences from the existing folder script:

- **`MODELS` env var** (space-separated registry keys, e.g. `MODELS="qwen3vl qwen35 gemma4"` or `MODELS=cosmos`). Outer loop over models, inner loop over datacenters/allocations (same as today).
- **GPU-safety guard**: before running, check whether `MODELS` mixes `cosmos` with any `ollama`-provider entry (cross-reference against the registry — script can just hardcode the same 4 keys/providers, or fetch `/api/health`-style metadata; simplest is a small static map mirroring `models.js` inside the script). If mixed, **abort immediately** with a clear message ("cosmos and Ollama models can't run in the same pass — GPU conflict. Run once per family, swap services between runs."). This is what operationalizes "manual sequencing only" — the script actively prevents the unsafe case rather than just documenting it.
- **Per-model warm-up**: for `cosmos`, keep the existing `/api/start` + poll `/api/health` sequence. For `ollama`-provider models, skip that entirely (no equivalent needed) — just proceed straight to requests.
- **`modelId` added to the request body** sent to `/api/analyze-simulation-local`.
- **Output filename embeds model + timestamp**: `test_multi_model_${modelId}_$(date +%Y%m%d-%H%M%S).csv` (prompt-version tag deferred — no versioned prompt file exists yet; add a `PROMPT_VERSION=R1` placeholder in the filename now so the convention is already in place once prompt-file extraction happens later).
- **CSV gains a `model` column** (and `model_label` for readability) alongside the existing columns, so multiple models' CSVs can later be concatenated for comparison without losing that info.

### Explicitly not in this pass

- No prompt-file versioning yet (`backend/prompts/*.txt`) — still using the inline prompt text already in `batchTest.controller.js`, shared identically across all models since they all call the same controller function.
- No automation of stopping/starting the Ollama service — purely a script-level guard + clear error message.
- No `:cloud`-tagged Ollama models (`glm-5.2:cloud`, `deepseek-v4-pro:cloud`) — local models only for now.
- No cross-model comparison/merge script yet — that's a follow-up once real result files exist from at least two models.
- No changes to `batch_compliance.sh` / `batch_compliance_folder.sh` — both stay exactly as they are.

## Verification

1. `node --check` every touched/new backend file (`config/models.js`, `config/index.js`, `controller/batchTest.controller.js`).
2. Boot the backend locally and hit `/api/analyze-simulation-local` directly with `modelId: "cosmos"` (should behave identically to today — regression check) and, separately, confirm the request-building logic for an `ollama`-provider `modelId` produces a well-formed request (can be checked without a live Ollama instance by inspecting the built payload / checking `ensureVLLM` is *not* invoked for that path).
3. `bash -n` the new script.
4. Dry-run the new script with `LIMIT=1-2` against the real backend on `103.204.95.220`, once Ollama is confirmed reachable there — first with `MODELS=cosmos` (should match existing folder-script behavior), then separately with `MODELS=qwen3vl` after Ollama is up and vLLM is stopped, confirming the GPU-guard correctly *allows* single-family runs and *blocks* a mixed one (e.g. `MODELS="cosmos qwen3vl"` should abort with the conflict message before making any request).
