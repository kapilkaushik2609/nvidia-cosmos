const express = require("express");
const cors = require("cors");
const path = require("path");

const healthRoutes = require("./routes/health.routes");
const analyzeRoutes = require("./routes/analyze.routes");
const simulationRoutes = require("./routes/simulation.routes");
const oasisRoutes = require("./routes/oasis.routes");
const batchTestRoutes = require("./routes/batchTest.routes");

// client/dist lives at the repo root, two levels up from backend/src/
const CLIENT_DIST = path.join(__dirname, "..", "..", "client", "dist");

const app = express();

app.use(cors());
// 20mb (default is 100kb): the testing-only /api/analyze-simulation-local route
// (see batchTest.routes.js) sends a base64 thermal image inline in the body.
// Harmless increase for every other route — none of them send bodies anywhere
// close to 100kb today.
app.use(express.json({ limit: "20mb" }));
app.use(express.static(CLIENT_DIST));

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
app.use("/api", batchTestRoutes);

app.get("*", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

module.exports = app;
