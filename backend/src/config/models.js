const { VLLM_URL, MODEL, OLLAMA_URL } = require("./index");

// Registry of models the testing-only batch pipeline (batchTest.controller.js +
// backend/scripts/batch_multi_model.sh) can target — the real product API
// (simulation.controller.js) always uses VLLM_URL/MODEL directly and never
// consults this file.
//
// `provider` tells the controller which lifecycle applies:
//   "vllm"   — Cosmos, via the on-demand vLLM subprocess (ensureVLLM/resetIdle)
//   "ollama" — served by Ollama, already running independently, no start/stop
//              needed — but see the GPU note in config/index.js: Ollama and
//              vLLM cannot run on the GPU at the same time on the deployment
//              box, so a batch run must only ever target one provider family.
//
// Both providers speak the same OpenAI-compatible /v1/chat/completions shape
// (Ollama exposes this natively), so the controller's request-building code
// is identical regardless of which entry is selected here.
module.exports = {
  cosmos: {
    label: "Cosmos3-Nano",
    provider: "vllm",
    baseUrl: VLLM_URL,
    model: MODEL,
  },
  qwen3vl: {
    label: "Qwen3-VL 8B",
    provider: "ollama",
    baseUrl: OLLAMA_URL,
    model: "qwen3-vl:8b",
  },
  qwen35: {
    label: "Qwen3.5 9B",
    provider: "ollama",
    baseUrl: OLLAMA_URL,
    model: "qwen3.5:9b",
  },
  gemma4: {
    label: "Gemma4 e4b",
    provider: "ollama",
    baseUrl: OLLAMA_URL,
    model: "gemma4:e4b",
  },
  qwen36: {
    label: "Qwen3.6 35B",
    provider: "ollama",
    baseUrl: OLLAMA_URL,
    model: "qwen3.6:35b",
  },
};
