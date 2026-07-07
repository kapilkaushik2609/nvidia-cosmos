# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A React + Express UI for **NVIDIA Cosmos3-Nano**, a vision-language model served via vLLM. It has two roles bolted together:

1. A generic vLLM chat/image-analysis frontend (upload an image, ask a question, get a text answer).
2. A datacenter thermal/power simulation dashboard ("Simulation" tab) that combines a client-side physics model with Cosmos-generated risk assessments and live data from an external "OASIS" allocation-management API.

## Commands

Backend (repo root):
```bash
npm install
node server.js          # runs on :7086 (serves API + client/dist if built)
```

Frontend dev (separate terminal, from `client/`):
```bash
cd client
npm install
npm run dev              # Vite dev server on :5173, proxies /api, /powerdraw, /thermal, /temperature, /config.json → :7086
```

Frontend production build:
```bash
cd client
npm run build             # outputs client/dist/
cd ..
node server.js            # now serves the built SPA + API from one process
```

There is no test suite, linter, or typechecker configured in either `package.json` — don't invent commands for these.

### Key environment variables (set before `node server.js`)

| Variable | Default | Purpose |
|---|---|---|
| `VLLM_URL` | `http://127.0.0.1:8001` | vLLM OpenAI-compatible server |
| `MODEL` | `nvidia/Cosmos3-Nano` | Model name sent in chat payloads |
| `PORT` | `7086` | Express port |
| `OASIS_API` | `http://103.204.95.220:7040` | External allocation/thermal data backend, proxied under `/api/oasis/*` |
| `ALLOC_BASE` | `''` | Optional local directory containing `thermal/thermal_map_composite.png` for image-grounded prompts; harmless if unset (`fs.existsSync` checks fail gracefully) |
| `IDLE_TIMEOUT_MIN` | `10` | Minutes of inactivity before vLLM subprocess is auto-killed |
| `COSMOS_TP` | `2` | Tensor-parallel GPU count for the vLLM subprocess (`1` = single-GPU mode) |

vLLM itself is a separate process (not part of this repo) — see `COSMOS_RUNSHEET.md` for how to install/run it standalone, including GPU/CUDA prerequisites and troubleshooting. `server.js` can also spawn/manage it itself (see below).

### Deployment

Runs on a remote GPU box (`103.204.95.220`, GPU 0 = RTX A4000 15GB, GPU 1 = RTX A4500 20GB — the latter may have Ollama loaded). `npm run dev` at the repo root there starts backend + Vite dev server together; `COSMOS_TP=1` forces single-GPU mode so Ollama doesn't need to be killed. See `context.md` for the current SSH/port map — it's a living session-notes file, more likely to be fresh than this document for day-to-day operational details (exact ports in use, current known issues). If it materially disagrees with this file, prefer `context.md` and update this section.

This repo is mirrored to a second path (`omniverse/cosmos-ui`, per `context.md`) that must be kept in sync manually — if asked to make a change "everywhere" or the user mentions the mirror, ask whether both copies need editing.

## Architecture

### Backend (`server.js` entry point + `src/` modules)

`server.js` itself is now just the Express bootstrap: CORS/JSON middleware, static SPA serving, mounting the route modules below, `app.listen`, and the `SIGINT` handler. All actual logic lives under `src/`:

- `src/config.js` — every env-derived constant (`VLLM_URL`, `ALLOC_BASE`, `MODEL`, `PORT`, `OASIS_API`, `IDLE_TIMEOUT_MS`, `STARTUP_MAX_MS`, `POLL_INTERVAL_MS`, `COSMOS_TP`). Add new env vars here, not inline in a route file.
- `src/services/vllmProcess.js` — the on-demand vLLM process manager: rather than assuming vLLM is always running, this can `spawn()` the `vllm serve` CLI itself (hardcoded path `/home/block2/cosmos-reasoner/bin/vllm`), poll `/health` until ready, and auto-kill it after `IDLE_TIMEOUT_MIN` of no requests. Exports `ensureVLLM()` / `stopVLLM()` / `resetIdle()` / `getState()`. Every route that talks to the model calls `ensureVLLM()` first; `getState()` backs `GET /api/health`'s `"stopped" | "starting" | "running"` response.
- `src/services/thermalImage.js` — `loadThermalImageContent(allocationId)`, fetches the per-allocation thermal map from OASIS for image-grounded prompts (returns `null`, never a stale local fallback, if unavailable).
- `src/routes/health.routes.js` — `GET /api/health`, `POST /api/start`, `POST /api/stop`.
- `src/routes/analyze.routes.js` — `POST /api/analyze`, `POST /api/analyze-thermal`. Owns the `multer` upload instance.
- `src/routes/simulation.routes.js` — `POST /api/predict-thermal`, `POST /api/analyze-simulation`. Both build an OpenAI-style `chat/completions` payload (image + text content parts) and POST it to `${VLLM_URL}/v1/chat/completions`, embedding live datacenter metrics (rack loads, row stats, ASHRAE thresholds) in hand-written prompts — when modifying prompt text, keep the strict output format expected by `predict-thermal`'s regex parser (`ROW_1_RISK:`, `PREDICTED_MAX_TEMP:`, etc.).
- `src/routes/oasis.routes.js` — `/api/oasis/*`, thin passthrough to an external allocation-management backend (`OASIS_API`) for allocation lists, thermal snapshots, power/temp summaries, 2D rack layouts, and the per-allocation thermal image. This is the *live data* source for the Simulation panel; static file routes for `/thermal`, `/powerdraw`, `/temperature`, `/config.json` were removed in favor of this proxy (see commented-out lines near the top of `server.js` — don't resurrect them without checking why they were removed).
- Express (in `server.js`) serves the built SPA (`client/dist`) as static files and falls back to `index.html` for any unmatched route (SPA routing).

### Frontend (`client/src`)

Plain React (no router, no state library) — `App.jsx` holds a `view` string (`'analyzer' | 'thermal' | 'simulation'`) and conditionally renders one of three top-level components, switched via `Header`.

- **Image Analyzer** (default view): `ImageInput` (file/URL) → `POST /api/analyze` → `ResultPanel`. Simple request/response, no persisted state.
- **Thermal Viewer** (`ThermalViewer.jsx`): raw Three.js scene (not react-three-fiber) for viewing `.glb` 3D models with `OrbitControls`/`GLTFLoader`, plus the same chat-analysis flow scoped to thermal images.
- **Simulation** (`SimulationPanel.jsx`, the most complex component): a client-side thermal physics simulator with an SVG floorplan, driven by:
  - **Load model**: idle/peak kW per rack, per-row multipliers, global/per-row load sliders, a cooling-fault toggle, and scenario presets — all combined in `simulate()` into per-rack temperatures via a linear formula (`AMBIENT_C + ΔkW × TEMP_PER_KW × rowFactor × overloadFactor × coolDerate`).
  - **Real baseline overlay**: on mount/allocation-change, fetches `/api/oasis/allocation/:id/layout` (rack positions + `configuration` block with rack count/power specs) and `/api/oasis/allocation/:id/thermal` (per-rack measured temp/power) in parallel. If a rack has real baseline data, `simulate()` computes temperature as *baseline + physics delta* instead of the pure formula — this is why `parseLayoutConfig`/`extractRackLayout`/`buildLayoutFromThermal` exist: `extractRackLayout` tries several field names (`layout_elements`, `racks`, `rack_list`, `components`) defensively, but the current live OASIS API puts racks in **`data.layout_elements[]`** specifically, using `tile_x`/`tile_y` (half-tile units) for display-safe SVG coordinates — if layout extraction silently stops finding racks, check that field name first before assuming the API changed shape. Baseline lookup (`baseline[r.rack_id]`) also requires the thermal and layout APIs to return matching rack ID formats (`RACK-001`, …) for the same allocation.
  - The default/sample allocation ID (`20230123-225659-UTC_DFW_375_2800_STD`) lives under datacenter `CHI1-CHI3` on the OASIS side (`/api/oasis/allocations/CHI1-CHI3`) — despite the `DFW` in the ID, don't assume `DFW` is a valid datacenter query param.
  - **Cosmos integration**, two independent modes:
    - "Live Prediction" toggle: 1.5s after any slider changes, POSTs current sim state to `/api/predict-thermal` and overlays the model's per-row SAFE/WARNING/CRITICAL verdict on the floorplan (debounced via `setTimeout` + `AbortController`).
    - "Compliance"/"Physics" buttons: one-shot deep analyses via `/api/analyze-simulation` with `mode: 'compliance' | 'physics'`, rendering the model's full text response.
  - The hardcoded `RACK_LAYOUT` array (52 racks, 3 rows) is only a fallback used before any API layout loads, or if both the layout and thermal fetches fail.

### Data flow summary

```
Simulation UI ⇄ server.js (/api/oasis/*)        ⇄ OASIS backend (allocations, layout, thermal)
Simulation UI ⇄ server.js (/api/predict-thermal, /api/analyze-simulation, /api/analyze-thermal)
                    ⇄ vLLM (/v1/chat/completions) ⇄ Cosmos3-Nano model
```

### Gotchas

- `client/src/App.jsx.clean` is a stray backup copy of `App.jsx`, not imported/built by Vite. Don't confuse it with the real entry point.
- Ports differ between docs: `README.md` mentions `:3000`, but the actual default (`server.js`, `vite.config.js` proxy) is `:7086`. Trust the code over the README on this.
- Repo root also contains standalone data snapshots (`powerdraw/`, `temperature/`, `thermal/`, `floorplan.png`, `model_3d.json`, `model_glb.glb`, `report.json`, `config.json`) that predate the OASIS API proxy and are no longer served directly by `server.js`; they're reference/sample data, not live inputs.
- **AI file-editing tools have previously truncated backend files** at trailing template literals (per `context.md`), back when `server.js` was one large file. Now that the backend is split under `src/` (see Architecture above), the risk is smaller per-file, but still run `node --check <file>` on whichever file you edited (and `node --check server.js`) before considering a backend change done.
- `ALLOC_BASE` must always be defined as at minimum `''` — several routes (e.g. `/api/analyze-simulation`) reference it unconditionally and will throw `ReferenceError` if the fallback is ever removed.
- Nullish-coalescing/OR mixing needs explicit parens under this Babel/Vite setup: write `a ?? (b || c)`, not `a ?? b || c` (raised as a real gotcha in past sessions, see `context.md`).
