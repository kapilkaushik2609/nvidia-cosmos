const express = require("express");
const { predictThermal, analyzeSimulation } = require("../controller/simulation.controller");

const router = express.Router();

router.post("/predict-thermal", predictThermal);
router.post("/analyze-simulation", analyzeSimulation);

module.exports = router;
