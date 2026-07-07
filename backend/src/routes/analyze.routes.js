const express = require("express");
const multer = require("multer");
const { analyzeImage, analyzeThermal } = require("../controller/analyze.controller");

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

router.post("/analyze", upload.single("image"), analyzeImage);
router.post("/analyze-thermal", upload.single("image"), analyzeThermal);

module.exports = router;
