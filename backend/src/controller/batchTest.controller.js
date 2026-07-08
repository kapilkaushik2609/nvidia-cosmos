const fetch = require("node-fetch");
const { VLLM_URL, MODEL } = require("../config");
const { ensureVLLM, resetIdle } = require("../services/vllmProcess");

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
      prompt = `You are a co-location datacenter facility operator responsible for regulatory compliance reporting to external bodies and to tenants. You own and operate the facility infrastructure (power, cooling, physical security) but do NOT own or control the IT equipment inside tenant racks — your compliance obligation is delivering the contracted environmental conditions (inlet temperature/humidity), not protecting the tenant's specific hardware. Frame every finding as facility/SLA compliance, never as equipment risk.

APPLICABLE STANDARDS:

ASHRAE TC 9.9 — Thermal Guidelines for Data Processing Environments
  Equipment classes (based on installed IT hardware):
    Class A1 (enterprise servers):       Inlet 15-27 deg C recommended | 10-35 deg C allowable
    Class A2 (mainstream servers):       Inlet 10-35 deg C recommended | 10-35 deg C allowable
    Class A3 (high-density / telco):     Inlet  5-40 deg C recommended |  5-45 deg C allowable
    Class A4 (extended-range):           Inlet  5-45 deg C recommended |  5-45 deg C allowable
  Co-location context: the operator cannot verify exactly what equipment class each tenant has installed. Unless the tenant has contractually declared a less conservative class, assess against the most conservative default — Class A1 (15-27 deg C recommended, 10-35 deg C allowable).
  Operative limits applied: Recommended 18-27 deg C | Allowable maximum 32 deg C

TC 9.9 THREE-LEVEL RACK MEASUREMENT (mandatory measurement positions per cabinet):
    Level 1 — Bottom  (U1-U14,  floor to ~25 in):  cold aisle inlet, most critical
    Level 2 — Middle  (U15-U28, 25 in to ~50 in):  mid-rack compute zone
    Level 3 — Top     (U29-U42, 50 in to ~75 in):  upper exhaust return zone

ASME V&V 20 — Standard for Verification and Validation of CFD and Heat Transfer Simulations
  In this co-location context, the model being validated is the FACILITY's ability to maintain the contracted inlet envelope for each tenant — not an enterprise IT team's own CFD model. Requires: (a) thermal simulation validated against physical sensor data, (b) documented uncertainty bounds and mesh/model convergence evidence, (c) formal comparison of simulated vs measured values at the same spatial points.

${dataBlock}

Provide a structured compliance assessment. Where the allocation has a named tenant/customer, reference them by name in violation and incident language (e.g. "exceeds the contracted thermal envelope for Tenant X") — never describe findings as equipment risk, since the operator doesn't own the IT hardware:
1. COMPLIANCE STATUS — COMPLIANT or NON-COMPLIANT against the assumed Class A1 (or tenant-declared class) envelope. State which class this facility is currently delivering conditions for.
2. ENVELOPE RISK — Which rows or racks are operating outside the A1 (or declared) envelope? Is there risk that the tenant's actual equipment requires more conservative conditions than are currently being delivered?
3. SLA VIOLATION REPORT — For each violating row/zone: location, estimated temperature at each of the 3 TC 9.9 measurement levels (bottom/middle/top), which contracted limit is breached, and severity — phrased as a facility delivery breach (e.g. "Row 2 exceeds the contracted 27 deg C inlet temperature"), not equipment risk.
4. REPORTABLE INCIDENTS — Which violations require formal disclosure to the tenant (per SLA/contract), insurers, or regulators? At what temperature threshold does SLA credit/penalty exposure begin?
5. CORRECTIVE ACTIONS — Facility-side steps to restore the contracted envelope, ordered: immediate / within 24h / within 1 week.
6. ASME V&V 20 GAP — Identify discrepancies between formula-based simulation and the thermal image baseline that require documented validation of the facility's environmental delivery, with uncertainty quantification per ASME V&V 20.
7. COMPLIANCE RISK RATING — LOW / MEDIUM / HIGH / CRITICAL with justification referencing SLA/contractual exposure and the specific TC 9.9 class threshold being approached or breached.`;
    } else if (mode === "physics") {
      prompt = `You are a datacenter operations analyst with access to rack-level temperature and power readings. You do NOT have CFD (computational fluid dynamics) simulation data, and you were not trained on thermal physics or airflow modeling. Your analysis must be based on the observed temperature/power patterns below and standard industry rules of thumb — not fluid dynamics simulation. Be explicit whenever a statement is a pattern-based observation rather than a physics-grounded calculation, and recommend physical CFD or a sensor sweep wherever real validation would be needed.

This facility uses hot-aisle/cold-aisle containment with N+1 precision CRAC cooling.
Physics model (linear approximation, not a CFD model): idle power ${idleKW.toFixed(1)} kW/rack, peak ${peakKW.toFixed(1)} kW/rack, thermal coefficient 0.969 deg C/kW, ambient supply 18 deg C.

${dataBlock}

Provide a pattern-based thermal observation report — not a CFD simulation:
1. THERMAL ENVELOPE — Current operating margin from thermal design limit, based on the reported temperatures. Which racks are approaching their design envelope? Express as percentage of headroom remaining.
2. POWER DENSITY OBSERVATIONS — Flag zones with high reported power density (kW per rack footprint). Identify rows where adjacent rack heat load appears to compound, based on the temperature/power numbers — not an airflow simulation.
3. TEMPERATURE PATTERN ASSESSMENT — Based on the temperature readings and thermal image (if provided), describe patterns consistent with hot-aisle/cold-aisle mixing, bypass airflow, or poor cooling coverage. State explicitly that this is inference from temperature patterns, not a CFD airflow model, and recommend physical CFD or a sensor sweep to confirm.
4. COOLING HEADROOM — Quantify remaining cooling capacity in kW from the reported numbers. At what IT load percentage does the cooling system reach saturation? What is the thermal cascade failure threshold under current CRAC state?
5. OPERATING ENVELOPE — State the min/max safe power envelope per rack and total facility under current cooling conditions, based on the provided thermal coefficient. What is the absolute ceiling before forced shutdown is required?
6. LOAD DELTA ESTIMATE — If IT load increases from current by +10% / +20% / +30%, extrapolate the temperature delta (deg C) per row using the provided linear thermal coefficient — flag this as an estimate from the linear model, not a validated CFD prediction, and identify which row would breach the allowable limit first.`;
    } else {
      // General / legacy mode
      prompt = `You are a datacenter thermal management AI analyzing ${facilityLabel} (${dims}${rackCount} racks, ${numRows} rows, ${designKW} kW IT design capacity).

${dataBlock}

Provide a concise analysis:
1. RISK ASSESSMENT — What are the critical thermal risks in this scenario?
2. HOT SPOT PREDICTION — Which zones or racks are most likely to develop dangerous hot spots, and why?
3. COOLING HEADROOM — How much headroom does the cooling system have before failure?
4. LOAD REDISTRIBUTION — Which racks should be throttled first to restore thermal balance?
5. TOP 3 ACTIONS — Specific steps the operations team should take right now.`;
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
    });
  } catch (err) {
    console.error("[analyze-simulation-local]", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeSimulationLocal };
