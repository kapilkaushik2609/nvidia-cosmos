# Plan — Multi-Model Analysis (Cosmos vs. Gemma 4 / Qwen 3.6 VL / Ollama)

> Status: planning only, nothing implemented yet.
> Source of requirements: `NewWork_OasisDiscussion20.md` items 4–6, `OASIS_COSMOS_PROGRESS.md` → "Meeting Context (Rahul — Oasis Discussion 20)".

## Goal

Run the **identical** compliance prompt against Cosmos Reason and at least one other vision-language model (Gemma 4 / Qwen 3.6 VL, served via Ollama), across the same allocation dataset, and produce labeled, versioned, comparable result files — without touching the real `/api/analyze-simulation` product API.

## What already exists (don't rebuild)

- `backend/src/controller/batchTest.controller.js` + `routes/batchTest.routes.js` → `POST /api/analyze-simulation-local`. Testing-only endpoint, already separate from the real API. Currently hardcodes the model call to `VLLM_URL`/`MODEL` (Cosmos3-Nano) from `backend/src/config`.
- `backend/scripts/batch_compliance.sh` (API/OASIS-driven) and `batch_compliance_folder.sh` (local `allocations/`-driven) — both build the same request body shape, POST to a compliance endpoint, extract the 7 report sections + `result_summary`, cross-check against ground truth via `auto_check()`, write CSV.
- Compliance/physics/general prompt text lives duplicated in both `simulation.controller.js` (real API) and `batchTest.controller.js` (testing API) — by design, per earlier instruction not to touch the real one.

## Key architectural decision: standardize on the OpenAI-compatible chat API

vLLM (Cosmos) already speaks the OpenAI `/v1/chat/completions` shape. **Ollama also exposes an OpenAI-compatible endpoint** (`POST {OLLAMA_URL}/v1/chat/completions`), so Gemma 4 and Qwen 3.6 VL served through Ollama can be called with the *exact same request/response shape* just by changing the base URL + `model` field. This means we don't need per-provider adapters — one HTTP call shape, parameterized by which server/model to hit.

**Needs verifying before implementation:** Ollama is currently only mentioned in this repo as something that *competes for GPU 1* (`COSMOS_TP=2` requires killing it) — confirm Ollama is actually reachable (locally or on `103.204.95.220`), has Gemma 4 and/or Qwen 3.6 VL pulled, and check whether running it alongside Cosmos needs `COSMOS_TP=1` (single-GPU mode) to avoid the GPU conflict already documented in `CLAUDE.md`/`context.md`.

## Phases

### Phase 1 — Model registry (small, low-risk)

New file: `backend/src/config/models.js` (or a `.json` if preferred for editing without touching code) — the single source of truth for "which models can be tested":

```js
module.exports = {
  cosmos:  { label: "Cosmos3-Nano",  baseUrl: process.env.VLLM_URL || "http://127.0.0.1:8001", model: "nvidia/Cosmos3-Nano" },
  gemma4:  { label: "Gemma 4",       baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434", model: "gemma4" /* exact tag TBD */ },
  qwenvl:  { label: "Qwen 3.6 VL",   baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434", model: "qwen2.5vl" /* exact tag TBD */ },
};
```

Add `OLLAMA_URL` to `backend/src/config/index.js` and `.env.example` (default `http://127.0.0.1:11434`).

### Phase 2 — Prompt versioning (small–medium)

Extract the compliance/physics/general prompt template text out of `batchTest.controller.js` into versioned files, e.g.:

```
backend/prompts/
  compliance_R1.txt
  physics_R1.txt
  general_R1.txt
```

`batchTest.controller.js` reads the active version's file instead of an inline template literal (still string-interpolates the same `dataBlock`/facility values). A `PROMPT_VERSION` env var or request field picks which version to load (default `R1`). This makes "R1"/"R2" a real, diffable artifact instead of an implicit code state — satisfies Rahul's explicit ask that the prompt must be identical across every model in a comparison, and versioned when it changes.

### Phase 3 — Extend the testing endpoint to accept a model selector

Modify `batchTest.controller.js`'s `analyzeSimulationLocal`:
- Accept `modelId` (key into the Phase 1 registry) and optional `promptVersion` in the request body.
- Look up `{ baseUrl, model }` from the registry (fall back to `cosmos` if omitted, so existing calls without `modelId` keep working unchanged).
- POST to `${baseUrl}/v1/chat/completions` with `model` from the registry entry, instead of the hardcoded `VLLM_URL`/`MODEL`.
- Everything else (prompt building, image embedding, response parsing) stays the same, since the request/response shape is identical across providers (see architectural decision above).

This only touches the testing-only controller — `simulation.controller.js` (real API) is untouched.

### Phase 4 — Batch script changes

Both `batch_compliance.sh` and `batch_compliance_folder.sh`:
- New `MODELS` env var (default `cosmos`), space-separated list, e.g. `MODELS="cosmos gemma4"`.
- Outer loop over `MODELS`, inner loop stays over datacenters/allocations as today.
- `modelId` (and `promptVersion`, once Phase 2 lands) added to the JSON body sent to `/api/analyze-simulation-local`.
- **Output filename must embed model + prompt version + timestamp** (Rahul's explicit ask): e.g.
  `test_allocation_reasoner_${PROMPT_VERSION}_${modelId}_$(date +%Y%m%d-%H%M%S).csv`
  instead of the current fixed `OUTFILE` default — so re-runs never clobber each other and every file is self-describing.
- Add a `model` and `prompt_version` column to every CSV row too (not just the filename), so files can be concatenated later for cross-model analysis without losing that info.

### Phase 5 — `allocations/` folder: gitignore + configurable path (bundled in, small)

Not strictly multi-model, but blocking clean sharing of this pipeline (Rahul's other explicit ask):
- Add `allocations/` to `.gitignore`.
- Add `ALLOCATIONS_DIR` to `backend/.env.example` (already an env var override in `batch_compliance_folder.sh` — just needs to be the *documented, canonical* way to set it, and a README note that the folder must be dropped in manually).

### Phase 6 (stretch, not blocking the 2026-07-10 deliverable) — cross-model comparison merger

Once at least two per-model CSVs exist, a small follow-up script (Node or Python — CSV/Excel merging is painful in pure bash) that joins them on `allocation_id` into one wide comparison sheet: `compliance_status_cosmos` vs `compliance_status_gemma4` vs `actual_violations` (ground truth), etc. This is what actually answers "do the models agree." Not needed for the immediate "share 2-3 labeled result files" deliverable, but worth flagging now since it's the natural next step Rahul will ask for.

## Open questions (need Rahul or Shubham to confirm before/while implementing)

1. Exact Ollama model tags for "Gemma 4" and "Qwen 3.6 VL" (Ollama's model registry naming may not match the version names used in conversation).
2. Where does Ollama run — locally alongside Cosmos on `103.204.95.220`, or elsewhere? Affects whether `COSMOS_TP=1` (single-GPU) is required to free up GPU 1.
3. Do vision-capable Ollama models expect images the same way (base64 data URL in an OpenAI-shaped `image_url` content part)? Needs a quick smoke test before trusting the "one shape fits all" assumption in Phase 3.
4. Confirm `R1` is an acceptable label for "the current prompt" (matches Rahul's own example naming) before extracting Phase 2's files.

## Suggested order of work

1. Phase 1 (registry) + Phase 5 (gitignore/config path) — small, independent, no risk to anything working.
2. Smoke-test Ollama reachability + image handling (answers open question 3) before writing Phase 3 code.
3. Phase 2 (prompt versioning).
4. Phase 3 (endpoint model selector).
5. Phase 4 (batch script loop + filename versioning) — this is what actually produces Rahul's requested deliverable.
6. Phase 6 only after Rahul sees the first labeled result files and asks for the comparison view.
