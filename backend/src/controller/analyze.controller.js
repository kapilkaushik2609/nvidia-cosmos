const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const { VLLM_URL, MODEL, ALLOC_BASE } = require("../config");
const { ensureVLLM, resetIdle } = require("../services/vllmProcess");

// Analyze — auto-starts vLLM if stopped, waits for it to be ready
async function analyzeImage(req, res) {
  try {
    await ensureVLLM();

    const prompt =
      req.body.prompt?.trim() || "Describe what you see in this image.";
    let imageContent;
    if (req.file) {
      const b64 = req.file.buffer.toString("base64");
      const mime = req.file.mimetype || "image/jpeg";
      imageContent = {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
      };
    } else if (req.body.image_url) {
      imageContent = {
        type: "image_url",
        image_url: { url: req.body.image_url },
      };
    } else {
      return res
        .status(400)
        .json({ error: "Provide an image file or image_url." });
    }

    const payload = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [imageContent, { type: "text", text: prompt }],
        },
      ],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({
      result: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? {},
    });
  } catch (err) {
    console.error("[analyze]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// Thermal image analysis — reads from ALLOC_BASE, sends directly to vLLM
async function analyzeThermal(req, res) {
  try {
    await ensureVLLM();

    let b64,
      mime = "image/png";

    if (req.file) {
      // Uploaded file from client
      b64 = req.file.buffer.toString("base64");
      mime = req.file.mimetype || "image/jpeg";
    } else {
      // Fall back to reading from allocation thermal folder
      const { thermal_file = "thermal_map_composite.png" } = req.body;
      const filePath = path.join(ALLOC_BASE, "thermal", thermal_file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: `File not found: ${thermal_file}. Use the upload button to send an image directly.`,
        });
      }
      b64 = fs.readFileSync(filePath).toString("base64");
    }

    const analysisPrompt =
      req.body.prompt ||
      "Analyze this thermal map of a datacenter. Identify hot spots, cold zones, " +
        "hot aisle vs cold aisle temperature patterns, and ASHRAE compliance concerns.";

    const payload = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b64}` },
            },
            { type: "text", text: analysisPrompt },
          ],
        },
      ],
      max_tokens: 1024,
    };

    const upstream = await fetch(`${VLLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok)
      return res.status(upstream.status).json({ error: JSON.stringify(data) });

    resetIdle();
    res.json({
      result: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? {},
    });
  } catch (err) {
    console.error("[analyze-thermal]", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeImage, analyzeThermal };
