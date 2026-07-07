const { spawn } = require("child_process");
const fetch = require("node-fetch");
const {
  VLLM_URL,
  IDLE_TIMEOUT_MS,
  STARTUP_MAX_MS,
  POLL_INTERVAL_MS,
  COSMOS_TP,
} = require("../config");

/* ─── vLLM On-Demand Process Manager ────────────────────────────────── */

let vllmProc = null;
let vllmState = "stopped"; // "stopped" | "starting" | "running"
let idleTimer = null;
let startPromise = null;

// Direct path inside the virtualenv — no shell activation needed
const VLLM_BIN = "/home/block2/cosmos-reasoner/bin/vllm";
// GPU strategy:
//   TP2 mode  -> both GPUs (0,1) — needs GPU 1 to be mostly free (Ollama must be stopped)
//   TP1 mode  -> GPU 0 only (A4000 15 GB, always idle) — works even while Ollama runs on GPU 1
//
// Set COSMOS_TP=1 in the environment to force single-GPU mode, e.g.:
//   COSMOS_TP=1 npm run dev
const TP = COSMOS_TP;
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

function getState() {
  return vllmState;
}

module.exports = { ensureVLLM, stopVLLM, resetIdle, getState };
