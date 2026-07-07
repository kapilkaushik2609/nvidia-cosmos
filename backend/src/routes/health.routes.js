const express = require("express");
const { getHealth, startModel, stopModel } = require("../controller/health.controller");

const router = express.Router();

router.get("/health", getHealth);
router.post("/start", startModel);
router.post("/stop", stopModel);

module.exports = router;
