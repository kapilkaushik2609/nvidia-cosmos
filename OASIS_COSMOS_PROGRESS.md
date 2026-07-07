# OASIS × Cosmos — Project Progress

> **Last updated:** July 7, 2026 (Session 4)  
> **Project:** `cosmos-ui` — datacenter simulation & AI analysis interface powered by NVIDIA Cosmos3-Nano  
> **Linux server:** `block2@103-204-95-220` (SSH port 220)  
> **Repo location:** `~/nvidia-cosmos/` on Linux | `D:\ems\oasis\nvidia-cosmos\cosmos-ui\` on Windows  
> **Mirror:** `D:\ems\oasis\omniverse\cosmos-ui\` (kept in sync)

---

## What Is This?

`cosmos-ui` is a web application that runs on the datacenter's own server and lets ops/engineering teams:

1. **Analyze images** using NVIDIA Cosmos3-Nano (a visual reasoning AI model)
2. **View real thermal data** from any OASIS allocation — rack count, layout, and temperatures loaded live from API
3. **Run load simulations** on a 2D SVG floorplan with physics-based temperature modeling
4. **Ask Cosmos AI** two types of questions about the current thermal state:
   - Compliance (ASHRAE TC 9.9 + ASME V&V 20, co-location-tenant framing)
   - Physics / pattern-based thermal observations (thermal envelopes, cooling headroom, power density — explicitly not CFD-grade, since Cosmos has no thermal-physics training)
5. **Live AI prediction** — overlay Cosmos risk assessment (SAFE / WARNING / CRITICAL) directly on the floorplan as you move load sliders
6. **Switch allocations** — dropdown lists all CHI1-CHI3 allocations; selecting one reloads layout, racks, and thermal baseline

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express — MVC split under `backend/` (Session 4; was one `server.js` file before) |
| Frontend | React + Vite (`client/`) |
| AI Model | NVIDIA Cosmos3-Nano via vLLM v0.21.0 (port 8001) |
| GPU | RTX A4000 (15 GB) + RTX A4500 (20 GB) |
| Dev server | `npm run dev` → nodemon auto-restart |
| Proxy | Vite dev proxy: all `/api/*`, `/powerdraw`, `/thermal`, `/temperature` → Express port 7086 |

---

## What We Built

### 1. Image Analyzer Tab
The original feature. Upload any image, write a prompt, Cosmos3-Nano responds with visual reasoning. Model starts on-demand and shuts down after 10 min idle.

### 2. Thermal Viewer Tab
Drag-and-drop image viewer for actual thermal camera images from the datacenter. Upload `.png` / `.jpg` thermal maps, view them inline. `/api/analyze-thermal` accepts multipart file upload and sends image to Cosmos for analysis.

### 3. Simulation Panel Tab (`⚡ Simulation`)
The main new feature. A 2D interactive datacenter floorplan with:

**Floorplan**
- SVG rendering of racks — count and positions loaded dynamically from the 2D layout API per allocation
- Layout comes from `GET /api/oasis/allocation/{id}/layout` → `data.layout_elements[]`
- Uses `tile_x` / `tile_y` for display coordinates (half-tile grid, safe within SVG bounds)
- Row count and per-row distribution set from `data.configuration.num_rows`
- Color-coded by temperature: blue (cool 18°C) → green → yellow → orange → red (hot 33°C+)
- Hover any rack to see ID, temperature, power draw, ASHRAE status
- Cosmos risk overlay bands (animated pulse on WARNING/CRITICAL rows)
- Header shows live rack count: `Datacenter Floorplan · N Racks`

**Physics Model** (calibrated from real sensor data)
```
power(load%)  = 4.0 + 14.0 × load_pct   kW per rack
temp          = 18.0 + (power - 4.0) × 0.969 × row_factor × overload_factor × cool_derate   °C
```
- `row_factor`: Row 1 = 1.000, Row 2 = 1.002, Row 3 = 1.004 (heat accumulates downstream)
- `cool_derate`: 1.0 (normal) or 2.0 (cooling fault — N+1 offline)
- `overload_factor`: kicks in when total IT load exceeds 375 kW design capacity

**Controls**
- Global load slider (all 52 racks together)
- Per-row override sliders (Row 1 / 2 / 3 independently)
- Cooling system toggle (Normal N+1 ↔ FAULT 50% capacity)
- 5 scenario presets: Current / Low Night / High Load / Peak / Cooling Fault

**Metrics bar** (live, updates with every slider move)
- IT Load (kW vs 375 kW design)
- Facility power + PUE
- Peak rack temperature
- ASHRAE violation count (recommended 27°C / allowable 32°C)

---

## Cosmos AI Integration

### Mode 1 — Live Prediction (floorplan overlay)
- Toggle: "🔮 Cosmos Live Prediction"
- After 1.5s of slider stillness → sends scenario data to `/api/predict-thermal`
- Cosmos responds in strict key:value format (no JSON — too unreliable)
- Parsed with regex to extract per-row risk + hotspot + action
- Risk bands appear on floorplan: green SAFE / amber WARNING / red CRITICAL (pulsing)
- In-flight requests cancelled via `AbortController` when user moves slider again

### Mode 2 — Compliance Analysis
- Button: "📋 Run Compliance Check"
- Endpoint: `POST /api/analyze-simulation` with `{ mode: "compliance" }`
- **Standard: ASHRAE TC 9.9** (Thermal Guidelines for Data Processing Environments)
  - Class A1 (enterprise): 15–27°C recommended | 10–35°C allowable
  - Class A2 (mainstream): 10–35°C recommended | 10–35°C allowable
  - Class A3 / A4: extended ranges for high-density / telco
- **Measurement: 3 levels per rack** (TC 9.9 methodology)
  - Level 1 — Bottom U1–U14 (~0–25 in): cold aisle inlet, most critical
  - Level 2 — Middle U15–U28 (~25–50 in): mid-rack compute zone
  - Level 3 — Top U29–U42 (~50–75 in): upper exhaust return
- **Also covers ASME V&V 20**: validation of CFD/simulation models against measured data
- Output: compliance status, envelope risk, SLA violation report, reportable incidents, corrective actions, V&V gap, risk rating
- **Co-location framing (Session 4):** the prompt no longer assumes an "enterprise datacenter" that owns its IT equipment. OASIS is a co-location provider — it owns the facility (power/cooling/security) but not the tenant's hardware, so:
  - Defaults to the most conservative **Class A1** envelope unless the tenant has contractually declared otherwise (since the operator can't verify installed equipment class)
  - Violations are phrased as **SLA/facility-delivery breaches** ("exceeds the contracted thermal envelope for Tenant X"), never as equipment risk
  - ASME V&V 20 section reframed: the model being validated is the *facility's* ability to deliver the contracted envelope, not an enterprise IT team's own CFD model
- **`FACILITY:` line is now fully dynamic (Session 4, was hardcoded):** rack count, row count, design kW, dimensions, and customer/allocation name are pulled from the `facility` object the client sends (built from the layout API's `configuration` block), not a hardcoded `"DFW Datacenter — Vertex AI Systems, 70x40 ft, 52 racks..."` string.

### Mode 3 — Physics / Pattern-Based Thermal Analysis
- Button: "⚙️ Run Physics Analysis"
- Endpoint: `POST /api/analyze-simulation` with `{ mode: "physics" }`
- **Reframed to be honest about Cosmos's actual training (Session 4):** Cosmos3-Nano is a spatial/robotics-trained model with no CFD or thermal-physics training. The prompt no longer claims Cosmos is a "thermal engineer with deep expertise in... CFD" — it's now framed as an operations analyst reasoning from temperature/power patterns and industry rules of thumb, explicitly instructed to flag pattern-based inference vs. real physics and recommend actual CFD/sensor validation where needed.
- Output sections renamed to match the honest framing: THERMAL ENVELOPE, POWER DENSITY OBSERVATIONS (was "...ANALYSIS"), TEMPERATURE PATTERN ASSESSMENT (was "AIRFLOW ASSESSMENT"), COOLING HEADROOM, OPERATING ENVELOPE, LOAD DELTA ESTIMATE (was "...PREDICTION")

> **Note:** GL-14 was the original reference (from the Rahul meeting) but is incorrect — GL-14 covers energy M&V. We corrected this to **ASHRAE TC 9.9** which is the proper datacenter thermal standard.

### Per-allocation thermal image (Session 4, replaces old local-file fallback)
Both compliance and physics prompts now send Cosmos the **real per-allocation thermal map**, fetched live from OASIS (`loadThermalImageContent()` → `GET {OASIS_API}/api/assets/simulation/allocation/{id}/thermal/thermal_map.png`). If unavailable, no image is sent and the prompt explicitly tells Cosmos "No thermal baseline image is available — base your analysis on the numbers above only." The old fallback to a single local `ALLOC_BASE/thermal/thermal_map_composite.png` file (same image for every allocation, never actually correct for whichever allocation was selected) was removed entirely — no fallback to a generic file, since that silently showed the wrong allocation's image.

---

## Backend Endpoints

### Cosmos AI
| Endpoint | Method | What it does |
|---|---|---|
| `/api/health` | GET | Model state: stopped / starting / running |
| `/api/start` | POST | Start vLLM process on-demand |
| `/api/stop` | POST | Kill vLLM process |
| `/api/analyze` | POST | Image + prompt → Cosmos (general image analysis) |
| `/api/analyze-thermal` | POST | Multipart upload → thermal image analysis |
| `/api/predict-thermal` | POST | Structured per-row risk prediction (SAFE/WARNING/CRITICAL) |
| `/api/analyze-simulation` | POST | Full AI analysis, mode: `compliance` / `physics` / `general` |

### OASIS API Proxies (added Session 2)
All data routes now proxy through to `http://103.204.95.220:7040` — no static files.

| Endpoint | Proxies to | What it returns |
|---|---|---|
| `/api/oasis/allocations/:datacenter` | `GET /api/allocation/all/{datacenter}` | Array of `{allocationId, customerName, status}` |
| `/api/oasis/allocation/:id/layout` | `GET /api/allocation/2d-layout/{id}` | `{data: {layout_elements:[…], configuration:{…}, aisles:[…]}}` |
| `/api/oasis/allocation/:id/thermal` | `GET /api/allocation/{id}/thermal-overlay` | `{component_temperatures:[{id, type, temperature_c, power_kw}]}` |
| `/api/oasis/allocation/:id/power-temp` | `GET /api/allocation/{id}/power-temp-summary` | Calibration factors, allocation stats |
| `/api/oasis/allocation/:id/report` | `GET /api/allocation/single/{id}` | Full allocation report |
| `/api/oasis/allocation/:id/thermal-image` | `GET /api/assets/simulation/allocation/{id}/thermal/thermal_map.png` | Real per-allocation thermal map image (Session 4) |

**Datacenter ID in use:** `CHI1-CHI3` (not `DFW` — corrected in Session 2)

---

## Real Data

All allocation data now comes from the OASIS API — no local static files needed.

```
OASIS backend:  http://103.204.95.220:7040
Datacenter:     CHI1-CHI3
```

Local static folders (`powerdraw/`, `thermal/`, `temperature/`, plus `config.json`/`report.json`/`floorplan.png`/`model_3d.json`/`model_glb.glb`) were removed from the repo entirely in Session 4 — they predated the OASIS API proxy and were reference/sample data only, unreferenced by any live code path. `ALLOC_BASE` is still kept as an env var (`''` by default) for `/api/analyze-thermal`'s local-file fallback (only reachable if that endpoint is called with no uploaded file, which the UI never does) — everything else now sources thermal imagery live from OASIS per-allocation (see "Per-allocation thermal image" above).

**Layout API response shape:**
```json
{
  "data": {
    "configuration": { "it_load_kw": N, "rack_specs": { "count": N, "power_per_rack_kw": N }, "num_rows": N },
    "layout_elements": [ { "id": "RACK-001", "row": 1, "tile_x": 6, "tile_y": 14, ... } ],
    "aisles": [ ... ]
  }
}
```

---

## vLLM / GPU Management

```
GPU 0 — RTX A4000  (15 GB)  — usually idle
GPU 1 — RTX A4500  (20 GB)  — Ollama may use this
```

**Conflict:** Ollama holds ~11 GB on GPU 1 when running. vLLM (TP=2 mode) needs ~18 GB on each GPU → crash.

**Solutions:**
```bash
# Option A: Kill Ollama, run both GPUs (TP=2, full speed)
sudo pkill -f ollama && npm run dev

# Option B: Keep Ollama, run Cosmos on GPU 0 only (TP=1)
COSMOS_TP=1 npm run dev
```

`COSMOS_TP` is read at startup — no code change needed. Default is `2`.

---

## Files Changed / Created

### Session 1 (original build)
| File | What changed |
|---|---|
| `server.js` | Added `/api/analyze-thermal` (multer), `/api/predict-thermal`, `/api/analyze-simulation` (3 modes), vLLM on-demand manager, `COSMOS_TP` GPU switching |
| `client/src/App.jsx` | Removed duplicate health poll, added Simulation tab route |
| `client/src/components/Header.jsx` | 15s health poll, `onStatusChange` prop, 3 nav tabs |
| `client/src/components/ThermalViewer.jsx` | Full rewrite — drag & drop, file upload, analyze button |
| `client/src/components/SimulationPanel.jsx` | New — full floorplan, sliders, physics model, 3 Cosmos modes |
| `client/src/components/SimulationPanel.module.css` | New — dark NVIDIA theme, risk band animations, physics button blue accent |
| `client/vite.config.js` | Added proxy rules for `/powerdraw`, `/thermal`, `/temperature` |

### Session 2 (OASIS API integration)
| File | What changed |
|---|---|
| `server.js` | Removed static file routes; added 5 OASIS proxy routes; fixed datacenter ID `DFW` → `CHI1-CHI3`; `ALLOC_BASE` restored as empty-string default |
| `SimulationPanel.jsx` | Allocation dropdown wired to `GET /api/oasis/allocations/CHI1-CHI3`; fixed React key error (API returns objects not strings); dynamic `rackLayout` state replacing hardcoded `RACK_LAYOUT`; `simulate()` accepts layout as param; `useEffect` on `selectedAlloc` fetches layout + thermal in parallel |

### Session 3 (layout parsing fix)
| File | What changed |
|---|---|
| `SimulationPanel.jsx` | Replaced broken `normaliseLayout` with `parseLayoutConfig` (reads `data.configuration` for simOpts) + `extractRackLayout` (reads `data.layout_elements[]` for real rack positions/IDs); fixed `??`/`\|\|` operator precedence syntax error; `buildLayoutFromThermal` kept as fallback when layout API has no rack items |
| `server.js` | Fixed repeated file truncation (Python script strips null bytes + repairs incomplete template literal at EOF); `ALLOC_BASE` un-commented to fix `ReferenceError` in `/api/analyze-simulation` |

### Session 4 (hardcoded-value audit, Rahul's feedback items, backend restructure)
| File | What changed |
|---|---|
| `server.js` (root) | Removed all hardcoded facility values (`52 racks, 3 rows, 375 kW, "DFW datacenter"`) — replaced with a `facility` object the client now sends; added `loadThermalImageContent()` fetching the real per-allocation thermal image from OASIS with no local-file fallback |
| `SimulationPanel.jsx` | Removed the hardcoded 52-rack `RACK_LAYOUT` fallback array entirely — floorplan now shows a loading spinner / retry-on-error state instead of ever showing a fabricated layout; `facility` object (datacenterId, allocationId, customerName, rackCount, numRows, designKW, peakKW, idleKW, widthFt, lengthFt) threaded into every Cosmos request; `facilityLabel` correctly distinguishes the allocation/tenant from the shared datacenter facility |
| **Backend restructured into `backend/`** | Moved off root-level `server.js` entirely into `backend/` (own `package.json`) with an MVC-ish split: `src/app.js` (Express app, no listen), `src/server.js` (listen + SIGINT), `src/config/`, `src/services/` (`vllmProcess.js`, `thermalImage.js`), `src/controller/` (route handler logic), `src/routes/` (path → controller wiring only). `npm start`/`npm run dev` from `backend/` unchanged in spirit. |
| `backend/src/controller/simulation.controller.js` | **Item 2:** compliance prompt reframed enterprise → co-location (conservative Class A1 default, SLA-breach language, ASME V&V 20 reframed to facility-delivery validation). **Item 5:** physics prompt reframed from "thermal engineer with CFD expertise" to "operations analyst — NOT CFD-trained, pattern-based inference only," with matching section renames (POWER DENSITY OBSERVATIONS, TEMPERATURE PATTERN ASSESSMENT, LOAD DELTA ESTIMATE) |
| `backend/scripts/batch_compliance.sh` (new) | **Item 4 (partial):** bash+`jq` batch runner — loops every allocation across `CHI1-CHI3` and `DFW3-DFW5`, builds compliance requests from real OASIS layout+thermal data (not simulated sliders), extracts all 7 report sections into CSV (`result_summary`, `compliance_status`, `equipment_class_risk`, `violation_report`, `reportable_incidents`, `corrective_actions`, `asme_vv_gap`, `compliance_risk_rating`, blank `is_correct`/`comments`). Format-tolerant section extraction (Cosmos's heading style isn't consistent run-to-run) verified against real transcripts. Full request/response JSON logged per allocation to a separate debug log file. Still open: Sheet 2 (facility metadata), Sheet 3 (prompt docs), real multi-sheet `.xlsx` output (currently CSV) |
| Root-level data folders removed | `config.json`, `floorplan.png`, `model_3d.json`, `model_glb.glb`, `powerdraw/`, `report.json`, `temperature/`, `thermal/` deleted by the user — confirmed safe, all were unreferenced reference/sample data predating the OASIS proxy |
| `client/src/components/*.jsx` + `*.module.css` | A full Tailwind CSS v4 conversion was done and then **reverted by the user** back to CSS Modules — current state is CSS Modules, not Tailwind |

---

## Pending / Deferred

| Item | Status | Notes |
|---|---|---|
| Allocation selector | ✅ Done | Wired to `GET /api/oasis/allocations/CHI1-CHI3` |
| Dynamic floorplan per allocation | ✅ Done | `layout_elements[]` from 2D layout API, real rack count + positions |
| Thermal baseline per allocation | ✅ Done | `component_temperatures[]` from thermal-overlay API, keyed by rack ID |
| simOpts per allocation | ✅ Done | `configuration.it_load_kw` / `rack_specs.power_per_rack_kw` from layout API |
| `plan.md` for OSS data layer | Not started | Document telemetry MQ subscription, Redis cache, shared data layer |
| ASHRAE 3-level actual measurement | Prompt only | Real 3-level measurement would need sensor at 3 heights per rack |
| Aisles / cold-hot aisle overlay on floorplan | Not started | API returns `aisles[]` — could render cold/hot aisle bands behind racks |
| server.js truncation root cause | Mitigated (Session 4) | Backend split into many small files under `backend/src/` — each file is now small enough that the old truncation-at-`app.listen()` failure mode is much less likely; still run `node --check <file>` after any backend edit as a habit |

---

## Rahul's Feedback Items (`NewChamges.md`, Session 4)

| # | Item | Status |
|---|---|---|
| 1 | Use the 4-panel thermal image, not the single composite | ✅ Done |
| 2 | Compliance prompt: enterprise → co-location framing | ✅ Done — see Mode 2 above |
| 3 | Hardcoded `FACILITY:` dataBlock → dynamic from real allocation data | ✅ Done — see Mode 2 above |
| 4 | Batch evaluation Excel (`test_allocation_reasoner_v1.xlsx`) across all CHI1-CHI3 + DFW3-DFW5 allocations | 🟡 Partial — `backend/scripts/batch_compliance.sh` runs the batch and produces Sheet 1's data as CSV (all 7 compliance sections + result_summary + blank is_correct/comments). **Still open:** Sheet 1's facility columns (rack_count, num_rows, design_kw, rack_type), Sheet 2 (facility metadata), Sheet 3 (static prompt-structure documentation), and a real multi-sheet `.xlsx` writer (bash can't write `.xlsx` natively — needs a small Node/Python step on top of the CSV) |
| 5 | Physics prompt: honest about no CFD training (spatial/robotics model, not thermal physics) | ✅ Done — see Mode 3 above |

---

## Meeting Context (Rahul — Oasis Discussion 18)

- Rahul asked for **two separate Cosmos analysis modes** (not one generic button)
- Wanted compliance framed as "facility operator reporting to external bodies"
- Wanted physics framed as "engineer understanding thermal bounds and operating envelopes"
- Mentioned ASHRAE 3-level measurement (ground / middle / top)
- Allocation selector deferred — Shubham has the APIs already
- `plan.md` for the OSS data layer is a separate Oasis backend task

---

## How to Run

```bash
# On Linux server
cd ~/nvidia-cosmos/backend      # Session 4: backend now lives under backend/, not repo root

# Normal start (both GPUs — Ollama must be off)
npm run dev

# Single GPU start (GPU 0 only — Ollama can run on GPU 1)
COSMOS_TP=1 npm run dev

# Access UI
http://localhost:7086          # direct
http://localhost:5173          # via Vite dev server (proxied)
```

First request after startup takes ~2–3 minutes (model loading). Subsequent requests are fast. Model auto-shuts down after 10 min idle.
