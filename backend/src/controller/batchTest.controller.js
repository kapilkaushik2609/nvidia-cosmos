const fetch = require("node-fetch");
const { VLLM_URL, MODEL, PROMPT_VERSION } = require("../config");
const { ensureVLLM, resetIdle } = require("../services/vllmProcess");
const { loadPrompt } = require("../services/promptLoader");

// Testing-only endpoint for the folder-driven batch scripts (backend/scripts/).
// Deliberately a SEPARATE controller/route from analyze-simulation — that one
// is the real product API and stays untouched. This one takes the thermal
// image directly as base64 (imageBase64) instead of fetching it live from
// OASIS, so batch runs can source everything from the local allocations/
// folder with no network dependency on OASIS. Prompt text is intentionally
// kept identical to analyze-simulation's so results are comparable — if you
// change one, check whether the other needs the same change.

// Simulation AI analysis (local/offline variant) — mode: 'general' | 'compliance' | 'physics'
async function analyzeSimulationLocal(req, res) {
  try {
    await ensureVLLM();

    const {
      mode = "general",
      scenario,
      totalKW,
      facilKW,
      pue,
      maxTemp,
      violations,
      critical,
      globalLoad,
      coolingOk,
      rowStats,
      topRisks,
      facility,
      imageBase64,
      promptVersion = PROMPT_VERSION,
    } = req.body;

    const rackCount = facility?.rackCount || 52;
    const numRows = facility?.numRows || 3;
    const designKW = facility?.designKW || 375;
    const idleKW = facility?.idleKW || 4.0;
    const peakKW = facility?.peakKW || 18.0;
    const dims =
      facility?.widthFt && facility?.lengthFt
        ? `${facility.widthFt}x${facility.lengthFt} ft, `
        : "";
    const facilityLabel = facility?.allocationId
      ? `allocation ${facility.allocationId}${facility.customerName ? ` (customer: ${facility.customerName})` : ""}${facility.datacenterId ? ` in datacenter ${facility.datacenterId}` : ""}`
      : "this datacenter allocation";

    const imageContent = imageBase64
      ? {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageBase64}` },
        }
      : null;

    // Shared data block used in all prompts
    const dataBlock = `ALLOCATION: ${facilityLabel} — ${dims}${rackCount} racks, ${numRows} rows, ${designKW} kW IT design capacity
SCENARIO:  ${scenario || "Custom"}
IT Load:   ${Number(totalKW).toFixed(0)} kW / ${designKW} kW design (${((totalKW / designKW) * 100).toFixed(0)}%)
Facility:  ${Number(facilKW).toFixed(0)} kW  |  PUE ${Number(pue).toFixed(2)}
Load:      ${Math.round(globalLoad * 100)}% global rack utilisation
Peak Temp: ${Number(maxTemp).toFixed(1)} deg C
ASHRAE Recommended (27 deg C): ${violations}/${rackCount} racks exceed limit
ASHRAE Allowable  (32 deg C): ${critical}/${rackCount} racks at or above critical threshold
Cooling:   ${coolingOk ? "Normal — N+1 CRAC units online" : "FAULT — 50% cooling capacity (one CRAC offline)"}

ROW BREAKDOWN:
${(rowStats || []).map((r) => `  Row ${r.row}: avg ${Number(r.avgTemp).toFixed(1)} deg C | ${r.violations}/${r.count} racks exceed 27 deg C`).join("\n")}

TOP AT-RISK RACKS (hottest):
${(topRisks || [])
  .slice(0, 6)
  .map(
    (r, i) =>
      `  ${i + 1}. ${r.rack_id} (Row ${r.row}): ${Number(r.temp_c).toFixed(1)} deg C  ${Number(r.power_kw).toFixed(1)} kW`,
  )
  .join("\n")}
${imageContent ? "\nThe attached image is the real thermal baseline map of this datacenter." : "\nNo thermal baseline image is available for this allocation — base your analysis on the numbers above only."}`;

    let prompt;
    let max_tokens = 1500;

    if (mode === "compliance") {
      prompt = loadPrompt("compliance", promptVersion, { DATA_BLOCK: dataBlock });
    } else if (mode === "physics") {
      prompt = loadPrompt("physics", promptVersion, {
        IDLE_KW: idleKW.toFixed(1),
        PEAK_KW: peakKW.toFixed(1),
        DATA_BLOCK: dataBlock,
      });
    } else {
      // General / legacy mode
      prompt = loadPrompt("general", promptVersion, {
        FACILITY_LABEL: facilityLabel,
        DIMS: dims,
        RACK_COUNT: String(rackCount),
        NUM_ROWS: String(numRows),
        DESIGN_KW: String(designKW),
        DATA_BLOCK: dataBlock,
      });
    }

    const content = imageContent
      ? [imageContent, { type: "text", text: prompt }]
      : [{ type: "text", text: prompt }];

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens,
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
      used_image: !!imageContent,
      mode,
      promptVersion,
    });
  } catch (err) {
    console.error("[analyze-simulation-local]", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeSimulationLocal };
