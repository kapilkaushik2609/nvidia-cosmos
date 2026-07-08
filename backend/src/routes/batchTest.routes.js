const express = require("express");
const { analyzeSimulationLocal } = require("../controller/batchTest.controller");

// Testing-only routes for the folder-driven batch scripts (backend/scripts/) —
// separate from simulation.routes.js so the real analyze-simulation API is
// never touched by this.
const router = express.Router();

// Base64 thermal images can be several hundred KB — larger than the app-wide
// express.json() default (100kb). Scoped to just this route so the existing
// API's body-size limit is left exactly as it was.
router.post(
  "/analyze-simulation-local",
  express.json({ limit: "15mb" }),
  analyzeSimulationLocal,
);

module.exports = router;
