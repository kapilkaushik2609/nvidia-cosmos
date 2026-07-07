# cosmos-ui — Session Context

> **Purpose:** Quick-load context for AI sessions working on this codebase.  
> **Last updated:** July 7, 2026 (Session 3)

---

## Project in One Line

`cosmos-ui` is a Node.js/React web app running on `103.204.95.220:7086` that renders a live 2D datacenter floorplan, simulates thermal loads, and lets NVIDIA Cosmos3-Nano AI analyze compliance and physics — with all allocation data pulled from the OASIS backend API.

---

## Servers & Ports

| Service | Address |
|---|---|
| cosmos-ui Express backend | `http://103.204.95.220:7086` |
| Vite dev server (frontend) | `http://103.204.95.220:5174` |
| OASIS backend API | `http://103.204.95.220:7040` |
| vLLM (Cosmos3-Nano) | `http://localhost:8001` (on-demand) |

---

## File Locations

| Purpose | Windows path | Linux path |
|---|---|---|
| Primary repo | `D:\ems\oasis\nvidia-cosmos\cosmos-ui\` | `~/nvidia-cosmos/` |
| Mirror (keep in sync) | `D:\ems\oasis\omniverse\cosmos-ui\` | — |
| Server entry point | `server.js` | — |
| React frontend | `client/src/` | — |
| Simulation component | `client/src/components/SimulationPanel.jsx` | — |

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

| Frontend endpoint | Proxies to OASIS | Returns |
|---|---|---|
| `GET /api/oasis/allocations/CHI1-CHI3` | `GET /api/allocation/all/CHI1-CHI3` | `[{allocationId, customerName, status}]` |
| `GET /api/oasis/allocation/:id/layout` | `GET /api/allocation/2d-layout/:id` | `{data:{layout_elements:[…], configuration:{…}, aisles:[…]}}` |
| `GET /api/oasis/allocation/:id/thermal` | `GET /api/allocation/:id/thermal-overlay` | `{component_temperatures:[{id,type,temperature_c,power_kw}]}` |
| `GET /api/oasis/allocation/:id/power-temp` | `GET /api/allocation/:id/power-temp-summary` | Calibration factors |
| `GET /api/oasis/allocation/:id/report` | `GET /api/allocation/:id/report` | Full report |

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

| Function | Purpose |
|---|---|
| `parseLayoutConfig(data)` | Reads `data.data.configuration` → returns `{count, numRows, peakKW, designKW, idleKW}` |
| `extractRackLayout(data)` | Reads `data.data.layout_elements[]` → returns `[{rack_id, row, position_ft:{x,y}}]` |
| `buildLayoutFromThermal(items, numRows)` | Fallback: distributes thermal rack IDs into grid rows |
| `simulate(rowOverrides, globalLoad, coolingOk, baseline, opts, layout)` | Physics model: returns `{racks, totalKW, maxTemp, violations, critical, pue}` |

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

## server.js Key Facts

- `OASIS_API = process.env.OASIS_API || "http://103.204.95.220:7040"`
- `ALLOC_BASE = process.env.ALLOC_BASE || ''` — empty by default; only used to optionally load a local `thermal_map_composite.png` as visual context for Cosmos analysis
- Static file routes (`/thermal`, `/powerdraw`, `/temperature`) are **commented out** — data comes from OASIS API
- **Recurring issue:** `server.js` truncates at `app.listen(...)` template literal when edited with file tools. After any edit, run:
  ```bash
  node --check server.js
  ```
  If it fails, run the Python repair script (strips null bytes, repairs the truncated `app.listen` block).

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

cd ~/nvidia-cosmos

# Start backend + Vite dev server
npm run dev          # dual GPU
COSMOS_TP=1 npm run dev   # single GPU

# UI
http://103.204.95.220:5174
```

---

## Known Issues / Watch-outs

1. **server.js truncation** — file loses its last ~8 lines after edits via AI tools. Always `node --check` after editing.
2. **`ALLOC_BASE` must be defined** — even as `''` — or `/api/analyze-simulation` throws `ReferenceError`.
3. **Layout API key is `layout_elements`** — not `racks`, not `components`. If this ever changes, update `extractRackLayout`.
4. **`??` + `||` mixing** — requires explicit parens in Babel/Vite. Use `a ?? (b || c)` not `a ?? b || c`.
5. **Thermal rack IDs must match layout rack IDs** — baseline lookup `baseline[r.rack_id]` only works if both APIs return the same `RACK-001`...`RACK-N` format.
