const VLLM_URL = process.env.VLLM_URL || "http://127.0.0.1:8001";
// Ollama server (multi-model comparison testing only — see config/models.js).
// Note: Ollama and vLLM/Cosmos cannot run on the GPU at the same time on the
// deployment box; this is a manual handoff, not something the code manages.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
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
// Default prompt template version loaded from backend/prompts/<mode>_<version>.txt
// (see services/promptLoader.js) — bump this when the prompt text changes, and
// keep the old version's file around so past batch results stay reproducible.
const PROMPT_VERSION = process.env.PROMPT_VERSION || "R1";

module.exports = {
  VLLM_URL,
  OLLAMA_URL,
  ALLOC_BASE,
  MODEL,
  PORT,
  OASIS_API,
  IDLE_TIMEOUT_MS,
  STARTUP_MAX_MS,
  POLL_INTERVAL_MS,
  COSMOS_TP,
  PROMPT_VERSION,
};
