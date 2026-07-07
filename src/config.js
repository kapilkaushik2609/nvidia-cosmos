const VLLM_URL = process.env.VLLM_URL || "http://127.0.0.1:8001";
// ALLOC_BASE: only used for optional local thermal image overlay — falls back to empty string
// so fs.existsSync checks fail gracefully when no local files are present.
const ALLOC_BASE = process.env.ALLOC_BASE || "";
const MODEL = process.env.MODEL || "nvidia/Cosmos3-Nano";
const PORT = process.env.PORT || 7086;
const OASIS_API = process.env.OASIS_API || "http://103.204.95.220:7040"; // OASIS backend
const IDLE_TIMEOUT_MS = (process.env.IDLE_TIMEOUT_MIN || 10) * 60 * 1000;
const STARTUP_MAX_MS = 5 * 60 * 1000; // give up if model not ready in 5 min
const POLL_INTERVAL_MS = 5_000;
const COSMOS_TP = parseInt(process.env.COSMOS_TP || "2", 10);

module.exports = {
  VLLM_URL,
  ALLOC_BASE,
  MODEL,
  PORT,
  OASIS_API,
  IDLE_TIMEOUT_MS,
  STARTUP_MAX_MS,
  POLL_INTERVAL_MS,
  COSMOS_TP,
};
