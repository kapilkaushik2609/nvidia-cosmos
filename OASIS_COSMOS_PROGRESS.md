# OASIS × Cosmos — Project Progress

> **Last updated:** July 6, 2026 (Session 3)  
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
   - Compliance (ASHRAE TC 9.9 + ASME V&V 20)
   - Physics / CFD (thermal envelopes, cooling headroom, power density)
5. **Live AI prediction** — overlay Cosmos risk assessment (SAFE / WARNING / CRITICAL) directly on the floorplan as you move load sliders
6. **Switch allocations** — dropdown lists all CHI1-CHI3 allocations; selecting one reloads layout, racks, and thermal baseline

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express (`server.js`) |
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
- Output: compliance status, equipment class downgrade risk, violation report, reportable incidents, corrective actions, V&V gap, risk rating

### Mode 3 — Physics / CFD Analysis
- Button: "⚙️ Run Physics Analysis"
- Endpoint: `POST /api/analyze-simulation` with `{ mode: "physics" }`
- System prompt frames Cosmos as a thermal engineer (thermodynamics + fluid dynamics + BMS)
- Output: thermal envelope margin, power density hotspots, airflow dead zones, cooling headroom (kW), operating envelope bounds, load-delta predictions (+10%/+20%/+30% scenarios)

> **Note:** GL-14 was the original reference (from the Rahul meeting) but is incorrect — GL-14 covers energy M&V. We corrected this to **ASHRAE TC 9.9** which is the proper datacenter thermal standard.

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
| `/api/oasis/allocation/:id/report` | `GET /api/allocation/{id}/report` | Full allocation report |

**Datacenter ID in use:** `CHI1-CHI3` (not `DFW` — corrected in Session 2)

---

## Real Data

All allocation data now comes from the OASIS API — no local static files needed.

```
OASIS backend:  http://103.204.95.220:7040
Datacenter:     CHI1-CHI3
```

Local static folders (`powerdraw/`, `thermal/`, `temperature/`) are no longer served by Express. `ALLOC_BASE` is kept as an env var (`''` by default) only to optionally load a local `thermal_map_composite.png` as visual context for Cosmos analysis — if absent, Cosmos works from text data only.

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
| server.js truncation root cause | Recurring | File repeatedly truncates at `app.listen` template literal when edited via tools; workaround: Python EOF-repair script after every server.js edit |

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
cd ~/nvidia-cosmos

# Normal start (both GPUs — Ollama must be off)
npm run dev

# Single GPU start (GPU 0 only — Ollama can run on GPU 1)
COSMOS_TP=1 npm run dev

# Access UI
http://localhost:7086          # direct
http://localhost:5173          # via Vite dev server (proxied)
```

First request after startup takes ~2–3 minutes (model loading). Subsequent requests are fast. Model auto-shuts down after 10 min idle.
