require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
  quiet: true, // suppress dotenv's console "tip" banner on every boot
});

const app = require("./app");
const { PORT, VLLM_URL, OASIS_API, IDLE_TIMEOUT_MS } = require("./config");
const { stopVLLM } = require("./services/vllmProcess");

app.listen(PORT, () => {
  console.log(`\n  Backend  -> http://localhost:${PORT}`);
  console.log(`  vLLM   -> ${VLLM_URL}`);
  console.log(`  OASIS  -> ${OASIS_API}`);
  console.log(
    `  Mode     -> on-demand (idle timeout: ${IDLE_TIMEOUT_MS / 60000} min)\n`,
  );
});

process.on("SIGINT", () => {
  stopVLLM();
  process.exit(0);
});
