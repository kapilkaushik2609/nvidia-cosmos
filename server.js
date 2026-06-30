const express   = require("express");
const multer    = require("multer");
const fetch     = require("node-fetch");
const cors      = require("cors");
const path      = require("path");
const fs        = require("fs");
const { spawn } = require("child_process");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const VLLM_URL         = process.env.VLLM_URL          || "http://127.0.0.1:8001";
const ALLOC_BASE       = process.env.ALLOC_BASE        || path.resolve(
  __dirname, "..", "..",
  "oasis_backend", "src", "simulation", "sim-alloc-designer",
  "allocations", "20230123-225659-UTC_DFW_375_2800_STD"
);
const MODEL            = process.env.MODEL             || "nvidia/Cosmos3-Nano";
const PORT             = process.env.PORT              || 3000;
const IDLE_TIMEOUT_MS  = (process.env.IDLE_TIMEOUT_MIN || 10) * 60 * 1000;
const STARTUP_MAX_MS   = 5 * 60 * 1000;   // give up if model not ready in 5 min
const POLL_INTERVAL_MS = 5_000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "client", "dist")));

// Serve allocation data files for the viewer
app.use("/thermal",     express.static(path.join(ALLOC_BASE, "thermal")));
app.use("/powerdraw",   express.static(path.join(ALLOC_BASE, "powerdraw")));
app.use("/temperature", express.static(path.join(ALLOC_BASE, "temperature")));
app.get("/config.json", (_, res) => res.sendFile(path.join(ALLOC_BASE, "config.json")));
app.get("/report.json", (_, res) => res.sendFile(path.join(ALLOC_BASE, "report.json")));

/* ─── vLLM On-Demand Process Manager ────────────────────────────────── */

let vllmProc     = null;
let vllmState    = "stopped";   // "stopped" | "starting" | "running"
let idleTimer    = null;
let startPromise = null;

// Direct path inside the virtualenv — no shell activation needed
const VLLM_BIN  = "/home/block2/cosmos-reasoner/bin/vllm";
const VLLM_ARGS = [
  "serve", "nvidia/Cosmos3-Nano",
  "--hf-overrides", '{"architectures":["Cosmos3ReasonerForConditionalGeneration"]}',
  "--tensor-parallel-size", "2",
  "--mm-encoder-tp-mode", "data",
  "--async-scheduling",
  "--allowed-local-media-path", "/",
  "--media-io-kwargs", '{"video":{"num_frames":-1}}',
  "--gpu-memory-utilization", "0.92",
  "--max-model-len", "8192",
  "--port", "8001",
];
const VLLM_ENV = {
  ...process.env,
  CUDA_DEVICE_ORDER:                        "PCI_BUS_ID",
  CUDA_VISIBLE_DEVICES:                     "0,1",
  HF_HUB_OFFLINE:                           "1",
  VLLM_USE_FLASHINFER_SAMPLER:              "0",
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
  idleTimer    = null;
  startPromise = null;
  if (vllmProc) {
    try { process.kill(-vllmProc.pid, "SIGKILL"); } catch { vllmProc.kill("SIGKILL"); }
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
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function _doStart() {
  vllmState = "starting";
  console.log("[vLLM] Starting on-demand…");

  vllmProc = spawn(VLLM_BIN, VLLM_ARGS, { env: VLLM_ENV, detached: true });
  vllmProc.stdout.on("data", d => process.stdout.write(`[vLLM] ${d}`));
  vllmProc.stderr.on("data", d => process.stderr.write(`[vLLM] ${d}`));
  vllmProc.on("exit", code => {
    console.log(`[vLLM] Exited (${code})`);
    vllmProc = null; vllmState = "stopped"; startPromise = null;
    clearTimeout(idleTimer); idleTimer = null;
  });

  const ready = await pollReady();
  if (!ready) { stopVLLM(); throw new Error("vLLM failed to start within 5 minutes"); }

  vllmState = "running";
  resetIdle();
  console.log("[vLLM] Ready ✓");
}

function ensureVLLM() {
  if (vllmState === "running") { resetIdle(); return Promise.resolve(); }
  if (!startPromise) {
    startPromise = _doStart().catch(e => { startPromise = null; throw e; });
  }
  return startPromise;
}

/* ─── Routes ─────────────────────────────────────────────────────────── */

// Status — returns "stopped" | "starting" | "running"
app.get("/api/health", async (_req, res) => {
  let vllmOk = false;
  if (vllmState === "running") {
    try { const r = await fetch(`${VLLM_URL}/health`, { timeout: 3000 }); vllmOk = r.ok; } catch {}
  }
  res.json({ status: vllmState, vllm: vllmOk ? "ok" : vllmState, url: VLLM_URL });
});

// Pre-warm the model manually
app.post("/api/start", async (_req, res) => {
  try { await ensureVLLM(); res.json({ status: "running" }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

    const prompt = req.body.prompt?.trim() || "Describe what you see in this image.";
    let imageContent;
    if (req.file) {
      const b64  = req.file.buffer.toString("base64");
      const mime = req.file.mimetype || "image/jpeg";
      imageContent = { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
    } else if (req.body.image_url) {
      imageContent = { type: "image_url", image_url: { url: req.body.image_url } };
    } else {
      return res.status(400).json({ error: "Provide an image file or image_url." });
    }

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content: [imageContent, { type: "text", text: prompt }] }],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({ result: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? {} });
  } catch (err) {
    console.error("[analyze]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Thermal image analysis — reads from ALLOC_BASE, sends directly to vLLM
app.post("/api/analyze-thermal", upload.single("image"), async (req, res) => {
  try {
    await ensureVLLM();

    let b64, mime = "image/png";

    if (req.file) {
      // Uploaded file from client
      b64  = req.file.buffer.toString("base64");
      mime = req.file.mimetype || "image/jpeg";
    } else {
      // Fall back to reading from allocation thermal folder
      const { thermal_file = "thermal_map_composite.png" } = req.body;
      const filePath = path.join(ALLOC_BASE, "thermal", thermal_file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: `File not found: ${thermal_file}. Use the upload button to send an image directly.`
        });
      }
      b64 = fs.readFileSync(filePath).toString("base64");
    }

    const analysisPrompt = req.body.prompt ||
      "Analyze this thermal map of a datacenter. Identify hot spots, cold zones, " +
      "hot aisle vs cold aisle temperature patterns, and ASHRAE compliance concerns.";

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        { type: "text", text: analysisPrompt },
      ]}],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: JSON.stringify(data) });

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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  Backend  → http://localhost:${PORT}`);
  console.log(`  vLLM     → ${VLLM_URL}`);
  console.log(`  Mode     → on-demand (idle timeout: ${IDLE_TIMEOUT_MS / 60000} min)\n`);
});

process.on("SIGINT",  () => { stopVLLM(); process.exit(0); });
process.on("SIGTERM", () => { stopVLLM(); process.exit(0); });
