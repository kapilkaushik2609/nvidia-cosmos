const express = require("express");
const { analyzeSimulationLocal } = require("../controller/batchTest.controller");

// Testing-only routes for the folder-driven batch scripts (backend/scripts/) —
// separate from simulation.routes.js so the real analyze-simulation API is
// never touched by this. The larger body-size limit this route needs (for the
// inline base64 thermal image) is set globally in app.js — a route-level
// express.json() here would never run, since the app-wide one already
// consumes/rejects the body first.
const router = express.Router();

router.post("/analyze-simulation-local", analyzeSimulationLocal);

module.exports = router;
