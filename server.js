const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const VLLM_URL = process.env.VLLM_URL || "http://127.0.0.1:8001";
// const ALLOC_BASE = process.env.ALLOC_BASE || __dirname; // replaced by OASIS API
const MODEL = process.env.MODEL || "nvidia/Cosmos3-Nano";
const PORT = process.env.PORT || 7086;
const OASIS_API = process.env.OASIS_API || "http://103.204.95.220:7040"; // OASIS backend
const IDLE_TIMEOUT_MS = (process.env.IDLE_TIMEOUT_MIN || 10) * 60 * 1000;
const STARTUP_MAX_MS = 5 * 60 * 1000; // give up if model not ready in 5 min
const POLL_INTERVAL_MS = 5_000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "client", "dist")));

// Static allocation file routes removed — data now served via OASIS API proxy
// app.use("/thermal",      express.static(path.join(ALLOC_BASE, "thermal")));
// app.use("/powerdraw",    express.static(path.join(ALLOC_BASE, "powerdraw")));
// app.use("/temperature",  express.static(path.join(ALLOC_BASE, "temperature")));
// app.get("/config.json",  (_, res) => res.sendFile(path.join(ALLOC_BASE, "config.json")));
// app.get("/report.json",  (_, res) => res.sendFile(path.join(ALLOC_BASE, "report.json")));

/* ─── vLLM On-Demand Process Manager ────────────────────────────────── */

let vllmProc = null;
let vllmState = "stopped"; // "stopped" | "starting" | "running"
let idleTimer = null;
let startPromise = null;

// Direct path inside the virtualenv — no shell activation needed
const VLLM_BIN = "/home/block2/cosmos-reasoner/bin/vllm";
// GPU strategy:
//   TP2 mode  → both GPUs (0,1) — needs GPU 1 to be mostly free (Ollama must be stopped)
//   TP1 mode  → GPU 0 only (A4000 15 GB, always idle) — works even while Ollama runs on GPU 1
//
// Set COSMOS_TP=1 in the environment to force single-GPU mode, e.g.:
//   COSMOS_TP=1 npm run dev
const TP = parseInt(process.env.COSMOS_TP || "2", 10);
const VLLM_ARGS_BASE = [
  "serve",
  "nvidia/Cosmos3-Nano",
  "--hf-overrides",
  '{"architectures":["Cosmos3ReasonerForConditionalGeneration"]}',
  "--tensor-parallel-size",
  String(TP),
  "--async-scheduling",
  "--allowed-local-media-path",
  "/",
  "--media-io-kwargs",
  '{"video":{"num_frames":-1}}',
  "--gpu-memory-utilization",
  TP === 1 ? "0.90" : "0.92",
  "--max-model-len",
  "8192",
  "--port",
  "8001",
];
// --mm-encoder-tp-mode is only valid when TP > 1
const VLLM_ARGS =
  TP > 1
    ? [
        ...VLLM_ARGS_BASE.slice(0, 6),
        "--mm-encoder-tp-mode",
        "data",
        ...VLLM_ARGS_BASE.slice(6),
      ]
    : VLLM_ARGS_BASE;

const VLLM_ENV = {
  ...process.env,
  CUDA_DEVICE_ORDER: "PCI_BUS_ID",
  CUDA_VISIBLE_DEVICES: TP === 1 ? "0" : "0,1",
  HF_HUB_OFFLINE: "1",
  VLLM_USE_FLASHINFER_SAMPLER: "0",
  VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS: "0",
};

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`[vLLM] Idle ${IDLE_TIMEOUT_MS / 60000} min — shutting down`);
    stopVLLM();
  }, IDLE_TIMEOUT_MS);
}

function stopVLLM() {
  clearTimeout(idleTimer);
  idleTimer = null;
  startPromise = null;
  if (vllmProc) {
    try {
      process.kill(-vllmProc.pid, "SIGKILL");
    } catch {
      vllmProc.kill("SIGKILL");
    }
    vllmProc = null;
  }
  vllmState = "stopped";
  console.log("[vLLM] Stopped");
}

async function pollReady() {
  const deadline = Date.now() + STARTUP_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${VLLM_URL}/health`, { timeout: 3000 });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function _doStart() {
  vllmState = "starting";
  console.log("[vLLM] Starting on-demand…");

  vllmProc = spawn(VLLM_BIN, VLLM_ARGS, { env: VLLM_ENV, detached: true });
  vllmProc.stdout.on("data", (d) => process.stdout.write(`[vLLM] ${d}`));
  vllmProc.stderr.on("data", (d) => process.stderr.write(`[vLLM] ${d}`));
  vllmProc.on("exit", (code) => {
    console.log(`[vLLM] Exited (${code})`);
    vllmProc = null;
    vllmState = "stopped";
    startPromise = null;
    clearTimeout(idleTimer);
    idleTimer = null;
  });

  const ready = await pollReady();
  if (!ready) {
    stopVLLM();
    throw new Error("vLLM failed to start within 5 minutes");
  }

  vllmState = "running";
  resetIdle();
  console.log("[vLLM] Ready ✓");
}

function ensureVLLM() {
  if (vllmState === "running") {
    resetIdle();
    return Promise.resolve();
  }
  if (!startPromise) {
    startPromise = _doStart().catch((e) => {
      startPromise = null;
      throw e;
    });
  }
  return startPromise;
}

/* ─── Routes ─────────────────────────────────────────────────────────── */

// Status — returns "stopped" | "starting" | "running"
app.get("/api/health", async (_req, res) => {
  let vllmOk = false;
  if (vllmState === "running") {
    try {
      const r = await fetch(`${VLLM_URL}/health`, { timeout: 3000 });
      vllmOk = r.ok;
    } catch {}
  }
  res.json({
    status: vllmState,
    vllm: vllmOk ? "ok" : vllmState,
    url: VLLM_URL,
  });
});

// Pre-warm the model manually
app.post("/api/start", async (_req, res) => {
  try {
    await ensureVLLM();
    res.json({ status: "running" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stop the model manually
app.post("/api/stop", (_req, res) => {
  stopVLLM();
  res.json({ status: "stopped" });
});

// Analyze — auto-starts vLLM if stopped, waits for it to be ready
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    await ensureVLLM();

    const prompt =
      req.body.prompt?.trim() || "Describe what you see in this image.";
    let imageContent;
    if (req.file) {
      const b64 = req.file.buffer.toString("base64");
      const mime = req.file.mimetype || "image/jpeg";
      imageContent = {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
      };
    } else if (req.body.image_url) {
      imageContent = {
        type: "image_url",
        image_url: { url: req.body.image_url },
      };
    } else {
      return res
        .status(400)
        .json({ error: "Provide an image file or image_url." });
    }

    const payload = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [imageContent, { type: "text", text: prompt }],
        },
      ],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({
      result: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? {},
    });
  } catch (err) {
    console.error("[analyze]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Thermal image analysis — reads from ALLOC_BASE, sends directly to vLLM
app.post("/api/analyze-thermal", upload.single("image"), async (req, res) => {
  try {
    await ensureVLLM();

    let b64,
      mime = "image/png";

    if (req.file) {
      // Uploaded file from client
      b64 = req.file.buffer.toString("base64");
      mime = req.file.mimetype || "image/jpeg";
    } else {
      // Fall back to reading from allocation thermal folder
      const { thermal_file = "thermal_map_composite.png" } = req.body;
      const filePath = path.join(ALLOC_BASE, "thermal", thermal_file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: `File not found: ${thermal_file}. Use the upload button to send an image directly.`,
        });
      }
      b64 = fs.readFileSync(filePath).toString("base64");
    }

    const analysisPrompt =
      req.body.prompt ||
      "Analyze this thermal map of a datacenter. Identify hot spots, cold zones, " +
        "hot aisle vs cold aisle temperature patterns, and ASHRAE compliance concerns.";

    const payload = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b64}` },
            },
            { type: "text", text: analysisPrompt },
          ],
        },
      ],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({
      result: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? {},
    });
  } catch (err) {
    console.error("[analyze-thermal]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Structured thermal prediction — Cosmos returns per-row risk + hotspot for map overlay
app.post("/api/predict-thermal", async (req, res) => {
  try {
    await ensureVLLM();
    const { totalKW, globalLoad, coolingOk, rowStats, topRisks } = req.body;

    const thermalImg = path.join(
      ALLOC_BASE,
      "thermal",
      "thermal_map_composite.png",
    );
    let imageContent = null;
    if (fs.existsSync(thermalImg)) {
      const b64 = fs.readFileSync(thermalImg).toString("base64");
      imageContent = {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b64}` },
      };
    }

    const prompt = `You are a datacenter thermal AI. Analyze the DFW datacenter (52 racks, 3 rows, 375 kW capacity).

CURRENT LOAD STATE:
- IT Load: ${Number(totalKW).toFixed(0)} kW / 375 kW (${((totalKW / 375) * 100).toFixed(0)}%)
- Global rack utilisation: ${Math.round(globalLoad * 100)}%
- Cooling: ${coolingOk ? "normal N+1" : "FAULT — 50% capacity"}
- Row 1: avg ${rowStats?.[0]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[0]?.violations}/${rowStats?.[0]?.count} racks exceed 27°C
- Row 2: avg ${rowStats?.[1]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[1]?.violations}/${rowStats?.[1]?.count} racks exceed 27°C
- Row 3: avg ${rowStats?.[2]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[2]?.violations}/${rowStats?.[2]?.count} racks exceed 27°C
- Hottest racks: ${(topRisks || [])
      .slice(0, 3)
      .map((r) => `${r.rack_id}(${Number(r.temp_c).toFixed(1)}°C)`)
      .join(", ")}
${imageContent ? "\nThe image shows the actual thermal baseline of this datacenter." : ""}

Respond ONLY in this exact format — no other text, no explanation outside the fields:
ROW_1_RISK: SAFE|WARNING|CRITICAL
ROW_2_RISK: SAFE|WARNING|CRITICAL
ROW_3_RISK: SAFE|WARNING|CRITICAL
PREDICTED_MAX_TEMP: XX.X
HOTSPOT_ZONE: [max 12 words describing the highest risk rack zone]
URGENT_ACTION: [max 12 words — most critical action ops team should take now]`;

    const content = imageContent
      ? [imageContent, { type: "text", text: prompt }]
      : [{ type: "text", text: prompt }];

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 200,
    };
    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    const text = data.choices?.[0]?.message?.content ?? "";

    // Parse structured response
    const get = (key) =>
      text.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim() ?? null;
    const prediction = {
      row1: get("ROW_1_RISK") ?? "UNKNOWN",
      row2: get("ROW_2_RISK") ?? "UNKNOWN",
      row3: get("ROW_3_RISK") ?? "UNKNOWN",
      maxTemp: get("PREDICTED_MAX_TEMP") ?? null,
      hotspot: get("HOTSPOT_ZONE") ?? null,
      action: get("URGENT_ACTION") ?? null,
      raw: text,
    };

    res.json({ prediction, usage: data.usage ?? {} });
  } catch (err) {
    console.error("[predict-thermal]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simulation AI analysis — mode: 'general' | 'compliance' | 'physics'
app.post("/api/analyze-simulation", async (req, res) => {
  try {
    await ensureVLLM();

    const {
      mode = "general",
      scenario,
      totalKW,
      facilKW,
      pue,
      maxTemp,
      violations,
      critical,
      globalLoad,
      coolingOk,
      rowStats,
      topRisks,
    } = req.body;

    // Try to load the actual thermal composite image
    const thermalImg = path.join(
      ALLOC_BASE,
      "thermal",
      "thermal_map_composite.png",
    );
    let imageContent = null;
    if (fs.existsSync(thermalImg)) {
      const b64 = fs.readFileSync(thermalImg).toString("base64");
      imageContent = {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b64}` },
      };
    }

    // Shared data block used in all prompts
    const dataBlock = `FACILITY: DFW Datacenter — Vertex AI Systems, 70x40 ft, 52 racks, 3 rows, 375 kW IT design capacity
SCENARIO:  ${scenario || "Custom"}
IT Load:   ${Number(totalKW).toFixed(0)} kW / 375 kW design (${((totalKW / 375) * 100).toFixed(0)}%)
Facility:  ${Number(facilKW).toFixed(0)} kW  |  PUE ${Number(pue).toFixed(2)}
Load:      ${Math.round(globalLoad * 100)}% global rack utilisation
Peak Temp: ${Number(maxTemp).toFixed(1)} deg C
ASHRAE Recommended (27 deg C): ${violations}/52 racks exceed limit
ASHRAE Allowable  (32 deg C): ${critical}/52 racks at or above critical threshold
Cooling:   ${coolingOk ? "Normal — N+1 CRAC units online" : "FAULT — 50% cooling capacity (one CRAC offline)"}

ROW BREAKDOWN:
${(rowStats || []).map((r) => `  Row ${r.row}: avg ${Number(r.avgTemp).toFixed(1)} deg C | ${r.violations}/${r.count} racks exceed 27 deg C`).join("\n")}

TOP AT-RISK RACKS (hottest):
${(topRisks || [])
  .slice(0, 6)
  .map(
    (r, i) =>
      `  ${i + 1}. ${r.rack_id} (Row ${r.row}): ${Number(r.temp_c).toFixed(1)} deg C  ${Number(r.power_kw).toFixed(1)} kW`,
  )
  .join("\n")}
${imageContent ? "\nThe attached image is the real thermal baseline map of this datacenter." : ""}`;

    let prompt;
    let max_tokens = 1500;

    if (mode === "compliance") {
      prompt = `You are a datacenter facility operator responsible for regulatory compliance reporting to external bodies.

APPLICABLE STANDARDS:

ASHRAE TC 9.9 — Thermal Guidelines for Data Processing Environments
  Equipment classes (based on installed IT hardware):
    Class A1 (enterprise servers):       Inlet 15-27 deg C recommended | 10-35 deg C allowable
    Class A2 (mainstream servers):       Inlet 10-35 deg C recommended | 10-35 deg C allowable
    Class A3 (high-density / telco):     Inlet  5-40 deg C recommended |  5-45 deg C allowable
    Class A4 (extended-range):           Inlet  5-45 deg C recommended |  5-45 deg C allowable
  This facility is assumed Class A1/A2 (enterprise datacenter).
  Operative limits applied: Recommended 18-27 deg C | Allowable maximum 32 deg C

TC 9.9 THREE-LEVEL RACK MEASUREMENT (mandatory measurement positions per cabinet):
    Level 1 — Bottom  (U1-U14,  floor to ~25 in):  cold aisle inlet, most critical
    Level 2 — Middle  (U15-U28, 25 in to ~50 in):  mid-rack compute zone
    Level 3 — Top     (U29-U42, 50 in to ~75 in):  upper exhaust return zone

ASME V&V 20 — Standard for Verification and Validation of CFD and Heat Transfer Simulations
  Requires: (a) thermal simulation validated against physical sensor data,
            (b) documented uncertainty bounds and mesh/model convergence evidence,
            (c) formal comparison of simulated vs measured values at the same spatial points.

${dataBlock}

Provide a structured compliance assessment:
1. COMPLIANCE STATUS — COMPLIANT or NON-COMPLIANT per ASHRAE TC 9.9. State which class (A1/A2/A3/A4) this facility is currently operating at and whether that matches the installed equipment class.
2. EQUIPMENT CLASS RISK — Is there a class downgrade risk? (e.g. A1 equipment exposed to A2/A3 inlet conditions.) Which rows or racks are forcing class migration?
3. VIOLATION REPORT — For each violating row/zone: location, estimated temperature at each of the 3 TC 9.9 measurement levels (bottom/middle/top), which limit is breached, and severity.
4. REPORTABLE INCIDENTS — Which violations require formal disclosure (to equipment vendors, insurers, or facility management)? At what temperature threshold does warranty/SLA exposure begin?
5. CORRECTIVE ACTIONS — Steps to restore compliance, ordered: immediate / within 24h / within 1 week.
6. ASME V&V 20 GAP — Identify discrepancies between formula-based simulation and the thermal image baseline that require documented validation with uncertainty quantification per ASME V&V 20.
7. COMPLIANCE RISK RATING — LOW / MEDIUM / HIGH / CRITICAL with justification referencing the specific TC 9.9 class threshold being approached or breached.`;
    } else if (mode === "physics") {
      prompt = `You are a datacenter thermal engineer with deep expertise in thermodynamics, computational fluid dynamics (CFD), heat transfer, and building management systems.

This facility uses hot-aisle/cold-aisle containment with N+1 precision CRAC cooling.
Physics model: idle power 4.0 kW/rack, peak 18.0 kW/rack, thermal coefficient 0.969 deg C/kW, ambient supply 18 deg C.

${dataBlock}

Provide a physics-based thermal engineering analysis:
1. THERMAL ENVELOPE — Current operating margin from thermal design limit. Which racks are approaching their design envelope? Express as percentage of headroom remaining.
2. POWER DENSITY ANALYSIS — Flag zones with dangerous power density (kW per rack footprint). Identify any thermal runaway risk zones where adjacent rack heat load compounds.
3. AIRFLOW ASSESSMENT — Based on the thermal image baseline and load distribution, identify likely hot-aisle/cold-aisle mixing issues, bypass airflow paths, or dead zones with poor convective cooling.
4. COOLING HEADROOM — Quantify remaining cooling capacity in kW. At what IT load percentage does the cooling system reach saturation? What is the thermal cascade failure threshold under current CRAC state?
5. OPERATING ENVELOPE — State the min/max safe power envelope per rack and total facility under current cooling conditions. What is the absolute ceiling before forced shutdown is required?
6. LOAD DELTA PREDICTION — If IT load increases from current by +10% / +20% / +30%, predict the temperature delta (deg C) per row and identify which row breaches the allowable limit first.`;
    } else {
      // General / legacy mode
      prompt = `You are a datacenter thermal management AI analyzing the DFW datacenter (Vertex AI Systems, 70x40 ft, 52 racks, 3 rows, 375 kW IT design capacity).

${dataBlock}

Provide a concise analysis:
1. RISK ASSESSMENT — What are the critical thermal risks in this scenario?
2. HOT SPOT PREDICTION — Which zones or racks are most likely to develop dangerous hot spots, and why?
3. COOLING HEADROOM — How much headroom does the cooling system have before failure?
4. LOAD REDISTRIBUTION — Which racks should be throttled first to restore thermal balance?
5. TOP 3 ACTIONS — Specific steps the operations team should take right now.`;
    }

    const content = imageContent
      ? [imageContent, { type: "text", text: prompt }]
      : [{ type: "text", text: prompt }];

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({
      result: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? {},
      used_image: !!imageContent,
      mode,
    });
  } catch (err) {
    console.error("[analyze-simulation]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── OASIS Backend Proxy ─────────────────────────────────────────────────────
// Proxies allocation API endpoints from the OASIS backend (port 7040)

app.get("/api/oasis/allocations/:datacenter", async (req, res) => {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/all/${req.params.datacenter}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/allocations]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
});

app.get("/api/oasis/allocation/:id/power-temp", async (req, res) => {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/${req.params.id}/power-temp-summary`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/power-temp]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
});

app.get("/api/oasis/allocation/:id/thermal", async (req, res) => {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/thermal/${req.params.id}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/thermal]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
});

app.get("/api/oasis/allocation/:id/report", async (req, res) => {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/single/${req.params.id}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/report]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
});
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  Backend  → http://localhost:${PORT}`);
  console.log(`  vLLM   → ${VLLM_URL}`);
  console.log(`  OASIS  → ${OASIS_API}`);
  console.log(
    `  Mode     → on-demand (idle timeout: ${IDLE_TIMEOUT_MS / 60000} min)\n`,
  );
});

process.on("SIGINT", () => {
  stopVLLM();
  process.exit(0);
});
