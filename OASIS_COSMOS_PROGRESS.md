# OASIS × Cosmos — Project Progress

> **Last updated:** July 6, 2026  
> **Project:** `cosmos-ui` — datacenter simulation & AI analysis interface powered by NVIDIA Cosmos3-Nano  
> **Linux server:** `block2@103-204-95-220` (SSH port 220)  
> **Repo location:** `~/nvidia-cosmos/` on Linux | `D:\ems\oasis\nvidia-cosmos\cosmos-ui\` on Windows  
> **Mirror:** `D:\ems\oasis\omniverse\cosmos-ui\` (kept in sync)

---

## What Is This?

`cosmos-ui` is a web application that runs on the datacenter's own server and lets ops/engineering teams:

1. **Analyze images** using NVIDIA Cosmos3-Nano (a visual reasoning AI model)
2. **View real thermal data** from the DFW datacenter allocation (52 racks, 3 rows)
3. **Run load simulations** on a 2D SVG floorplan with physics-based temperature modeling
4. **Ask Cosmos AI** two types of questions about the current thermal state:
   - Compliance (ASHRAE TC 9.9 + ASME V&V 20)
   - Physics / CFD (thermal envelopes, cooling headroom, power density)
5. **Live AI prediction** — overlay Cosmos risk assessment (SAFE / WARNING / CRITICAL) directly on the floorplan as you move load sliders

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
- SVG rendering of all 52 racks across 3 rows (hardcoded from `powerdraw_summary.json`)
- Row 1: 18 racks | Row 2: 17 racks | Row 3: 17 racks
- Color-coded by temperature: blue (cool 18°C) → green → yellow → orange → red (hot 33°C+)
- Hover any rack to see ID, temperature, power draw, ASHRAE status
- Cosmos risk overlay bands (animated pulse on WARNING/CRITICAL rows)

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

| Endpoint | Method | What it does |
|---|---|---|
| `/api/health` | GET | Model state: stopped / starting / running |
| `/api/start` | POST | Start vLLM process on-demand |
| `/api/stop` | POST | Kill vLLM process |
| `/api/analyze` | POST | Image + prompt → Cosmos (general image analysis) |
| `/api/analyze-thermal` | POST | Multipart upload → thermal image analysis |
| `/api/predict-thermal` | POST | Structured per-row risk prediction (SAFE/WARNING/CRITICAL) |
| `/api/analyze-simulation` | POST | Full AI analysis, mode: `compliance` / `physics` / `general` |
| `/thermal/*` | GET | Serve real thermal images from `thermal/` folder |
| `/powerdraw/*` | GET | Serve powerdraw JSON data |
| `/temperature/*` | GET | Serve temperature data |

---

## Real Data

Three data folders sit alongside `server.js` (set via `ALLOC_BASE = __dirname`):

```
~/nvidia-cosmos/
  powerdraw/     ← powerdraw_summary.json (52 racks, actual power readings)
  thermal/       ← thermal_map_composite.png (real thermal camera image)
  temperature/   ← temperature sensor data
```

The simulation reads this image and sends it to Cosmos as visual context in analysis modes. Without the image, Cosmos works from text data only (fallback).

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

| File | What changed |
|---|---|
| `server.js` | Added `/api/analyze-thermal` (multer), `/api/predict-thermal`, `/api/analyze-simulation` (3 modes), vLLM on-demand manager, ALLOC_BASE fix, `COSMOS_TP` GPU switching |
| `client/src/App.jsx` | Removed duplicate health poll, added Simulation tab route |
| `client/src/components/Header.jsx` | 15s health poll, `onStatusChange` prop, 3 nav tabs |
| `client/src/components/ThermalViewer.jsx` | Full rewrite — drag & drop, file upload, analyze button |
| `client/src/components/SimulationPanel.jsx` | New — full floorplan, sliders, physics model, 3 Cosmos modes |
| `client/src/components/SimulationPanel.module.css` | New — dark NVIDIA theme, risk band animations, physics button blue accent |
| `client/vite.config.js` | Added proxy rules for `/powerdraw`, `/thermal`, `/temperature` |

---

## Pending / Deferred

| Item | Status | Notes |
|---|---|---|
| Allocation selector | Deferred | Shubham will provide APIs — skip for now |
| `plan.md` for OSS data layer | Not started | Document telemetry MQ subscription, Redis cache, shared data layer |
| Real per-rack temperature from sensors | Not wired | Currently physics formula only; sensor data in `temperature/` folder not yet parsed per-rack |
| ASHRAE 3-level actual measurement | Prompt only | Real 3-level measurement would need sensor at 3 heights per rack |

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
