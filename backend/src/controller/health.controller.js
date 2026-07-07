const fetch = require("node-fetch");
const { VLLM_URL } = require("../config");
const { ensureVLLM, stopVLLM, getState } = require("../services/vllmProcess");

// Status — returns "stopped" | "starting" | "running"
async function getHealth(_req, res) {
  const vllmState = getState();
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
}

// Pre-warm the model manually
async function startModel(_req, res) {
  try {
    await ensureVLLM();
    res.json({ status: "running" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Stop the model manually
function stopModel(_req, res) {
  stopVLLM();
  res.json({ status: "stopped" });
}

module.exports = { getHealth, startModel, stopModel };
