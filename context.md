# cosmos-ui — Session Context

> **Purpose:** Quick-load context for AI sessions working on this codebase.  
> **Last updated:** July 9, 2026 (Session 5)

---

## Project in One Line

`cosmos-ui` is a Node.js/React web app running on `103.204.95.220:7086` that renders a live 2D datacenter floorplan, simulates thermal loads, and lets NVIDIA Cosmos3-Nano AI analyze compliance and physics — with all allocation data pulled from the OASIS backend API.

---

## Servers & Ports

| Service                    | Address                             |
| -------------------------- | ----------------------------------- |
| cosmos-ui Express backend  | `http://103.204.95.220:7086`        |
| Vite dev server (frontend) | `http://103.204.95.220:5174`        |
| OASIS backend API          | `http://103.204.95.220:7040`        |
| vLLM (Cosmos3-Nano)        | `http://localhost:8001` (on-demand) |

---

## File Locations

| Purpose               | Windows path                                                  | Linux path         |
| --------------------- | ------------------------------------------------------------- | ------------------ |
| Primary repo          | `D:\ems\oasis\nvidia-cosmos\cosmos-ui\`                       | `~/nvidia-cosmos/` |
| Mirror (keep in sync) | `D:\ems\oasis\omniverse\cosmos-ui\`                           | —                  |
| Server entry point    | `backend/src/server.js` (backend code lives under `backend/`) | —                  |
| React frontend        | `client/src/`                                                 | —                  |
| Simulation component  | `client/src/components/SimulationPanel.jsx`                   | —                  |

**Always sync changes to both paths.**

---

## Key Constants (SimulationPanel.jsx)

```js
IDLE_KW   = 4.0       // kW per rack at idle
PEAK_KW   = 18.0      // kW per rack at peak (default; overridden by layout API)
AMBIENT_C = 18.0      // °C ambient (cold aisle inlet)
TEMP_PER_KW = 0.969   // °C rise per kW above idle
DESIGN_KW = 375       // kW IT design capacity (default; overridden by layout API)
ASHRAE_REC   = 27.0   // °C recommended limit
ASHRAE_ALLOW = 32.0   // °C allowable limit
SVG_W = 560, SVG_H = 310   // floorplan SVG dimensions (px)
SX = 8 px/ft,  SY = 7.75 px/ft   // room = 70×40 ft
RW = 2*SX-3,   RH = 4*SY-3       // rack rectangle size
```

---

## OASIS API Routes (proxied through cosmos-ui server)

All frontend calls go to `/api/oasis/...` on the cosmos-ui backend, which proxies to `http://103.204.95.220:7040`.

| Frontend endpoint                             | Proxies to OASIS                                                    | Returns                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/oasis/allocations/CHI1-CHI3`        | `GET /api/allocation/all/CHI1-CHI3`                                 | `[{allocationId, customerName, status}]`                                                                      |
| `GET /api/oasis/allocation/:id/layout`        | `GET /api/allocation/2d-layout/:id`                                 | `{data:{layout_elements:[…], configuration:{…}, aisles:[…]}}`                                                 |
| `GET /api/oasis/allocation/:id/thermal`       | `GET /api/allocation/thermal/:id`                                   | `{component_temperatures:[{id,type,temperature_c,power_kw}]}`                                                 |
| `GET /api/oasis/allocation/:id/power-temp`    | `GET /api/allocation/:id/power-temp-summary`                        | Calibration factors                                                                                           |
| `GET /api/oasis/allocation/:id/report`        | `GET /api/allocation/single/:id`                                    | Full report                                                                                                   |
| `GET /api/oasis/allocation/:id/thermal-image` | `GET /api/assets/simulation/allocation/:id/thermal/thermal_map.png` | Real per-allocation thermal map (Session 4) — sent to Cosmos in compliance/physics prompts, no local fallback |

**Datacenter ID:** `CHI1-CHI3` (NOT `DFW`)

---

## Layout API Response Shape

```json
{
  "success": true,
  "data": {
    "configuration": {
      "it_load_kw": 775,
      "rack_specs": { "count": 24, "power_per_rack_kw": 30, "type": "AI" },
      "num_rows": 2
    },
    "layout_elements": [
      { "id": "RACK-001", "x": 12, "y": 28, "row": 1, "tile_x": 6, "tile_y": 14, "power_kw": 30, "type": "AI" },
      { "id": "RACK-002", ... }
    ],
    "aisles": [ { "type": "cold", "x_start": 10, "x_end": 38, "y": 22, "height": 6, "serves_rows": [1] } ],
    "power_analysis": { "it_load_kw": 775, ... },
    "feasibility": { "status": "APPROVED", ... }
  }
}
```

- **Racks are in `data.layout_elements[]`** — NOT `data.racks`
- Use `tile_x` / `tile_y` for SVG coordinates (half-tile units, display-safe)
- `tile_x * SX` and `tile_y * SY` give pixel positions that fit within SVG bounds

---

## SimulationPanel Data Flow (on allocation change)

```
selectedAlloc changes
  │
  ├─ fetch /api/oasis/allocation/:id/layout
  │    ├─ parseLayoutConfig(data)  → setSimOpts({idleKW, peakKW, designKW})
  │    └─ extractRackLayout(data)  → setRackLayout(layout_elements mapped to {rack_id, row, position_ft})
  │         └─ if no layout_elements: fallback to buildLayoutFromThermal(thermalRacks, numRows)
  │
  └─ fetch /api/oasis/allocation/:id/thermal
       └─ loadThermal(data)
            └─ setBaseline(Map: rack_id → {temp_c, power_kw})
```

Key functions in `SimulationPanel.jsx`:

| Function                                                                | Purpose                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `parseLayoutConfig(data)`                                               | Reads `data.data.configuration` → returns `{count, numRows, peakKW, designKW, idleKW}` |
| `extractRackLayout(data)`                                               | Reads `data.data.layout_elements[]` → returns `[{rack_id, row, position_ft:{x,y}}]`    |
| `buildLayoutFromThermal(items, numRows)`                                | Fallback: distributes thermal rack IDs into grid rows                                  |
| `simulate(rowOverrides, globalLoad, coolingOk, baseline, opts, layout)` | Physics model: returns `{racks, totalKW, maxTemp, violations, critical, pue}`          |

---

## Physics Model

```
power_kw = idleKW + (peakKW - idleKW) × load_pct
totalKW  = sum of all rack power_kw
overload = max(1, totalKW / designKW)
coolDerate = coolingOk ? 1.0 : 2.0

if baseline exists for rack:
  temp = baseline.temp_c + (power_kw - baseline.power_kw) × TEMP_PER_KW × row_factor × overload × coolDerate
else:
  temp = AMBIENT_C + (power_kw - IDLE_KW) × TEMP_PER_KW × row_factor × overload × coolDerate

row_factor: {1: 1.000, 2: 1.002, 3: 1.004}
```

---

## Backend Key Facts

Backend now lives under `backend/` (`backend/src/app.js` + `server.js`, `config/`, `services/`, `controller/`, `routes/` — MVC-ish split, no more one giant `server.js`).

- `OASIS_API = process.env.OASIS_API || "http://103.204.95.220:7040"` (in `backend/src/config`)
- `ALLOC_BASE = process.env.ALLOC_BASE || ''` — empty by default. **Session 4: narrowed scope** — no longer used by `/api/predict-thermal` or `/api/analyze-simulation` at all (those now _only_ use the real per-allocation image from OASIS via `loadThermalImageContent()`, no local fallback — see OASIS routes table above). Only remaining use is `/api/analyze-thermal`'s fallback when called with no uploaded file, which the UI never does in practice.
- Static file routes (`/thermal`, `/powerdraw`, `/temperature`) are **commented out** in `app.js` — data comes from OASIS API
- **Session 5:** `backend/src/server.js` now loads `backend/.env` via `dotenv` at startup (see `backend/.env.example` for the full var list). `backend/.env` is gitignored — copy `.env.example` to `.env` and edit locally, doesn't affect anyone else.
- **Session 5:** `express.json()` limit raised app-wide from the 100kb default to `20mb` (in `app.js`) — needed because the testing-only `/api/analyze-simulation-local` route (below) embeds a base64 thermal image directly in the request body. Harmless increase for every other route; none of them send bodies anywhere near that size.
- **Recurring issue (historical, from the single-file era):** the old `server.js` used to truncate at its trailing `app.listen(...)` template literal when edited with file tools. Now that the backend is split into small files under `backend/src/`, run `node --check <file>` on whatever you edited:
  ```bash
  node --check backend/src/<path-to-file>.js
  ```
  If it fails, run the Python repair script (strips null bytes, repairs a truncated block).

---

## Session 4 —

All in `backend/src/controller/simulation.controller.js` unless noted. Status: 1/2/3/5 done, 4 partial.

1. **4-panel thermal image** — ✅ done (per-allocation OASIS thermal image, see routes table above)
2. **Co-location framing (compliance prompt)** — ✅ done. No longer "enterprise datacenter" — operator owns the facility, not tenant IT gear. Defaults to conservative **Class A1** unless tenant declared otherwise. Violations phrased as SLA/facility-delivery breaches, not equipment risk. Section 2 heading renamed `EQUIPMENT CLASS RISK` → `ENVELOPE RISK`, section 3 `VIOLATION REPORT` → `SLA VIOLATION REPORT`.
3. **Hardcoded `FACILITY:` line → dynamic** — ✅ done. `dataBlock` now built from a `facility` object the client sends (`rackCount`, `numRows`, `designKW`, `peakKW`, `idleKW`, `widthFt`, `lengthFt`, `customerName`, `allocationId`, `datacenterId`) — no more hardcoded `"DFW Datacenter — Vertex AI Systems, 70x40 ft, 52 racks..."`.
4. **Batch evaluation Excel** — 🟡 partial, now with two runner scripts (see Session 5). `is_correct`/`comments` logic superseded in Session 5 — see below. **Still open:** Sheet 1 facility columns (rack_count/num_rows/design_kw/rack_type), Sheet 2 (facility metadata), Sheet 3 (prompt-structure docs), real multi-sheet `.xlsx` output (currently CSV only — bash can't write `.xlsx` natively).
5. **Honest physics framing** — ✅ done. Prompt no longer claims Cosmos is a "thermal engineer with deep expertise in... CFD" (it's a spatial/robotics-trained model, no thermal physics training). Reframed as an operations analyst reasoning from patterns + rules of thumb, explicitly told to flag inference vs. real physics. Section renames: `POWER DENSITY ANALYSIS` → `...OBSERVATIONS`, `AIRFLOW ASSESSMENT` → `TEMPERATURE PATTERN ASSESSMENT`, `LOAD DELTA PREDICTION` → `...ESTIMATE`.

**Batch script gotchas** (learned the hard way, see script comments):

- Never use `set -e` in this script — `grep -o` returning exit 1 on no match will silently kill the whole run. Use explicit `if`/`continue` per allocation instead.
- `jq` on some platforms (confirmed on Windows `jq.exe`) emits CRLF for all but the last array element — strip a trailing `\r` off every value read from `jq -r` output before using it in a URL (`"${var%$'\r'}"`), or it silently corrupts the request and the server never even logs receiving it.
- Cosmos's heading format is **not consistent run-to-run** (`**HEADING:** value` vs `**HEADING**` + bolded value on next line vs plain numbered text) — extract sections by scanning for the next known heading as a boundary, not a fixed `**...**` shape.

Full detail synced to `OASIS_COSMOS_PROGRESS.md` (Session 4 entry) — that's the fuller writeup, this is the quick-reference version.

---

## Session 5 — Folder-driven batch testing + auto-verification

**Client request:** offer two modes for batch compliance testing — (1) API-driven (already existed, `batch_compliance.sh`), (2) folder-driven using the local `allocations/` sample data for dev/offline testing. Client will push the small backend code change to the server themselves; **the `allocations/` folder itself is never pushed to the server** — it only exists on the local Windows dev machine. Any folder-driven run always sources data locally and points `BACKEND_URL` at the remote backend (`http://103.204.95.220:7086`) for the actual Cosmos call.

**New testing-only endpoint** — `POST /api/analyze-simulation-local` (`backend/src/controller/batchTest.controller.js` + `routes/batchTest.routes.js`, mounted in `app.js`). Deliberately a **separate** controller/route from the real `simulation.controller.js`/`analyze-simulation` — client was explicit: don't touch the working production API for testing purposes. It duplicates the compliance/physics/general prompt text (keep both in sync if the prompt ever changes) but takes the thermal image as `imageBase64` in the body instead of fetching it live from OASIS, so it has zero OASIS/network dependency.

**New script** — `backend/scripts/batch_compliance_folder.sh`, folder-driven counterpart to `batch_compliance.sh`. Reads per-allocation `report.json`/`config.json` (facility config) + `temperature/temperature_summary.json` (per-rack row/temp/power — already has `row` baked in, so no join needed like the API version requires) + `thermal/thermal_map.png` (same file the live OASIS asset endpoint serves). Datacenter grouping (`CHI1-CHI3`/`DFW3-DFW5`) comes from `allocations/facility_allocation_table.json`'s `allocations[id].facility_id` (falls back to guessing from `_CHI_`/`_DFW_` in the allocation ID if that file is missing). `TEMP_FIELD` (default `mean_c`) picks which stat from the year-long summary counts as "current" temperature — it's a summary, not a live snapshot, so this is a real interpretive choice, not a live reading; `max_c` gives a worst-case stress test instead.

**Bugs hit and fixed, in order** (all in `batch_compliance_folder.sh`):
1. **413 PayloadTooLargeError** — Express's global `express.json()` (100kb default, in `app.js`) rejected the body before it ever reached a route-specific limit override. Fix: raise the *global* limit (`20mb`) — a route-level `express.json({limit:...})` registered after the global one is silently ineffective, since the global one already consumed/rejected the stream first.
2. **`Argument list too long`** — twice, same root cause: passing a ~700KB-1MB base64 string as a shell argument (`jq --arg img "$b64"` and `curl -d "$body"`) blows past the OS's `ARG_MAX`. Fix: write the large value to a temp file and use `jq --rawfile img "$file"` / `curl -d @"$file"` instead of passing it inline. **General rule: never pass a large (>~100KB) string via a bash command substitution into another command's argv — always route it through a temp file.**
3. **`Input length (8335) exceeds model's maximum context length (8192)`** — `thermal_map.png` is rendered proportional to each facility's real footprint, so wider facilities produce wider images, and image+text tokens together occasionally exceed vLLM's `--max-model-len 8192` (in `vllmProcess.js`). Fix: resize every image to `MAX_IMAGE_WIDTH` (default `1600`px, aspect preserved) before embedding — using `python3`/Pillow, both already present in the environment, no new dependency needed. Confirmed live: the exact allocation that previously 400'd now returns a full compliance report after resizing.

**`auto_check()` rewritten** (in both `batch_compliance.sh` and `batch_compliance_folder.sh`, kept in sync) — now **always** produces a definitive `is_correct` (`TRUE`/`FALSE`, not blank-by-default) plus a `comments` explanation, by checking two numerically-verifiable things against ground truth (`actual_violations`/`actual_critical`, computed straight from thermal data, never from Cosmos's own claims):
1. `compliance_status` vs. real violation count (expects `NON-COMPLIANT` iff `actual_violations > 0`).
2. `risk_rating` vs. real critical/violation count (a `LOW` rating is wrong if any rack is over 27°C, and definitely wrong if any is over 32°C/critical).
`is_correct` is left blank **only** when Cosmos's status is `CONDITIONAL`/`UNKNOWN`/unparseable — genuinely ambiguous, not a contradiction — with a comment saying so. Narrative sections (violation report, corrective actions, ASME V&V gap, etc.) are still never auto-graded — free text needs a human read, not string matching. Shared join logic extracted into a `join_semi()` helper (bash's `IFS`-based `[*]` array join only honors the first `IFS` character, silently dropping `"; "` down to `";"`).

**Not done in this session:** vLLM's own `--max-model-len` was left at `8192` (raising it needs GPU memory headroom to be verified, and would affect the live production model too, not just batch testing) — image resizing was the chosen fix instead, per explicit client choice.

---

## GPU Setup

```
GPU 0 — RTX A4000 (15 GB)   — Cosmos3-Nano primary
GPU 1 — RTX A4500 (20 GB)   — may have Ollama loaded (~11 GB)

COSMOS_TP=1  → single GPU mode (GPU 0 only, Ollama can stay)
COSMOS_TP=2  → dual GPU mode (kill Ollama first)
```

```bash
# Start (single GPU, safe)
COSMOS_TP=1 npm run dev

# Start (dual GPU, faster)
sudo pkill -f ollama && npm run dev
```

---

## How to Run

```bash
# SSH to server
ssh block2@103.204.95.220 -p 220

cd ~/nvidia-cosmos/backend   # Session 4: backend moved here, root npm run dev no longer exists

# Start backend
npm run dev          # dual GPU
COSMOS_TP=1 npm run dev   # single GPU

# (separate terminal, if running frontend dev server too)
cd ~/nvidia-cosmos/client && npm run dev

# UI
http://103.204.95.220:5174
```

---

## Known Issues / Watch-outs

1. **File truncation after AI edits** — historically hit the old single-file `server.js`; now that the backend is split under `backend/src/`, always `node --check <file>` after editing any of them.
2. **`ALLOC_BASE` must be defined** — even as `''` — used unconditionally in `analyze.controller.js`'s local-file fallback. (Session 4: `/api/analyze-simulation` no longer references `ALLOC_BASE` at all — it only uses the real per-allocation OASIS image now, so this specific `ReferenceError` risk moved to `/api/analyze-thermal` only.)
3. **Layout API key is `layout_elements`** — not `racks`, not `components`. If this ever changes, update `extractRackLayout`.
4. **`??` + `||` mixing** — requires explicit parens in Babel/Vite. Use `a ?? (b || c)` not `a ?? b || c`.
5. **Thermal rack IDs must match layout rack IDs** — baseline lookup `baseline[r.rack_id]` only works if both APIs return the same `RACK-001`...`RACK-N` format.
6. **Tailwind v4 conversion was tried and fully reverted** — an earlier attempt converted every component from CSS Modules to Tailwind utility classes. The user reverted it back to CSS Modules (`*.module.css` + `styles.x` imports) — that's the current, live styling approach. Don't re-attempt the conversion unless explicitly asked again; no Tailwind artifacts remain in the codebase.
7. **`allocations/` folder is local-only** — never pushed to the remote server (Session 5). Any script/feature reading from it must run on the local machine, pointed at the remote backend via `BACKEND_URL` for the actual Cosmos call — never assume it exists server-side.
