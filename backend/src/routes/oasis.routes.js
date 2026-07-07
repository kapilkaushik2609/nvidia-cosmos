const express = require("express");
const {
  getAllocations,
  getPowerTemp,
  getThermal,
  getReport,
  getLayout,
  getThermalImage,
} = require("../controller/oasis.controller");

const router = express.Router();

router.get("/allocations/:datacenter", getAllocations);
router.get("/allocation/:id/power-temp", getPowerTemp);
router.get("/allocation/:id/thermal", getThermal);
router.get("/allocation/:id/report", getReport);
router.get("/allocation/:id/layout", getLayout);
router.get("/allocation/:id/thermal-image", getThermalImage);

module.exports = router;
