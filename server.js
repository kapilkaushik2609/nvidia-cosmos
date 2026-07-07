const express = require("express");
const cors = require("cors");
const path = require("path");

const { PORT, VLLM_URL, OASIS_API, IDLE_TIMEOUT_MS } = require("./src/config");
const { stopVLLM } = require("./src/services/vllmProcess");

const healthRoutes = require("./src/routes/health.routes");
const analyzeRoutes = require("./src/routes/analyze.routes");
const simulationRoutes = require("./src/routes/simulation.routes");
const oasisRoutes = require("./src/routes/oasis.routes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "client", "dist")));

// Static allocation file routes removed — data now served via OASIS API proxy
// app.use("/thermal",      express.static(path.join(ALLOC_BASE, "thermal")));
// app.use("/powerdraw",    express.static(path.join(ALLOC_BASE, "powerdraw")));
// app.use("/temperature",  express.static(path.join(ALLOC_BASE, "temperature")));
// app.get("/config.json",  (_, res) => res.sendFile(path.join(ALLOC_BASE, "config.json")));
// app.get("/report.json",  (_, res) => res.sendFile(path.join(ALLOC_BASE, "report.json")));

/* ─── Routes ─────────────────────────────────────────────────────────── */

app.use("/api", healthRoutes);
app.use("/api", analyzeRoutes);
app.use("/api", simulationRoutes);
app.use("/api/oasis", oasisRoutes);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

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
