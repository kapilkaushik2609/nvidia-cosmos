const fetch = require("node-fetch");
const { VLLM_URL, MODEL } = require("../config");
const { ensureVLLM, resetIdle } = require("../services/vllmProcess");
const { loadThermalImageContent } = require("../services/thermalImage");

// Structured thermal prediction — Cosmos returns per-row risk + hotspot for map overlay
async function predictThermal(req, res) {
  try {
    await ensureVLLM();
    const { totalKW, globalLoad, coolingOk, rowStats, topRisks, facility } =
      req.body;

    // Facility identity/specs come from the OASIS allocation the client is viewing —
    // allocationId/customerName identify the tenant allocation (a customer's leased
    // space), not the shared datacenter facility (datacenterId) that hosts it. Fall
    // back to generic placeholders (never a hardcoded name) if the client omits it.
    const rackCount = facility?.rackCount || 52;
    const numRows = facility?.numRows || 3;
    const designKW = facility?.designKW || 375;
    const facilityLabel = facility?.allocationId
      ? `allocation ${facility.allocationId}${facility.customerName ? ` (customer: ${facility.customerName})` : ""}${facility.datacenterId ? ` in datacenter ${facility.datacenterId}` : ""}`
      : "this datacenter allocation";

    const imageContent = await loadThermalImageContent(facility?.allocationId);

    const prompt = `You are a datacenter thermal AI. Analyze ${facilityLabel} (${rackCount} racks, ${numRows} rows, ${designKW} kW capacity).

CURRENT LOAD STATE:
- IT Load: ${Number(totalKW).toFixed(0)} kW / ${designKW} kW (${((totalKW / designKW) * 100).toFixed(0)}%)
- Global rack utilisation: ${Math.round(globalLoad * 100)}%
- Cooling: ${coolingOk ? "normal N+1" : "FAULT — 50% capacity"}
- Row 1: avg ${rowStats?.[0]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[0]?.violations}/${rowStats?.[0]?.count} racks exceed 27°C
- Row 2: avg ${rowStats?.[1]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[1]?.violations}/${rowStats?.[1]?.count} racks exceed 27°C
- Row 3: avg ${rowStats?.[2]?.avgTemp?.toFixed(1)}°C, ${rowStats?.[2]?.violations}/${rowStats?.[2]?.count} racks exceed 27°C
- Hottest racks: ${(topRisks || [])
      .slice(0, 3)
      .map((r) => `${r.rack_id}(${Number(r.temp_c).toFixed(1)}°C)`)
      .join(", ")}
${imageContent ? "\nThe image shows the actual thermal baseline of this datacenter." : "\nNo thermal baseline image is available for this allocation — base your analysis on the numbers above only."}

Respond ONLY in this exact format — no other text, no explanation outside the fields:
ROW_1_RISK: SAFE|WARNING|CRITICAL
ROW_2_RISK: SAFE|WARNING|CRITICAL
ROW_3_RISK: SAFE|WARNING|CRITICAL
PREDICTED_MAX_TEMP: XX.X
HOTSPOT_ZONE: [max 12 words describing the highest risk rack zone]
URGENT_ACTION: [max 12 words — most critical action ops team should take now]`;

    const content = imageContent
      ? [imageContent, { type: "text", text: prompt }]
      : [{ type: "text", text: prompt }];

    const payload = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 200,
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
    const text = data.choices?.[0]?.message?.content ?? "";

    // Parse structured response
    const get = (key) =>
      text.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim() ?? null;
    const prediction = {
      row1: get("ROW_1_RISK") ?? "UNKNOWN",
      row2: get("ROW_2_RISK") ?? "UNKNOWN",
      row3: get("ROW_3_RISK") ?? "UNKNOWN",
      maxTemp: get("PREDICTED_MAX_TEMP") ?? null,
      hotspot: get("HOTSPOT_ZONE") ?? null,
      action: get("URGENT_ACTION") ?? null,
      raw: text,
    };

    res.json({ prediction, usage: data.usage ?? {} });
  } catch (err) {
    console.error("[predict-thermal]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// Simulation AI analysis — mode: 'general' | 'compliance' | 'physics'
async function analyzeSimulation(req, res) {
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
    } = req.body;

    // Facility identity/specs come from the OASIS allocation the client is viewing —
    // allocationId/customerName identify the tenant allocation (a customer's leased
    // space), not the shared datacenter facility (datacenterId) that hosts it. Fall
    // back to generic placeholders (never a hardcoded name) if the client omits it.
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

    const imageContent = await loadThermalImageContent(facility?.allocationId);

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
      prompt = `You are a datacenter facility operator responsible for regulatory compliance reporting to external bodies.

APPLICABLE STANDARDS:

ASHRAE TC 9.9 — Thermal Guidelines for Data Processing Environments
  Equipment classes (based on installed IT hardware):
    Class A1 (enterprise servers):       Inlet 15-27 deg C recommended | 10-35 deg C allowable
    Class A2 (mainstream servers):       Inlet 10-35 deg C recommended | 10-35 deg C allowable
    Class A3 (high-density / telco):     Inlet  5-40 deg C recommended |  5-45 deg C allowable
    Class A4 (extended-range):           Inlet  5-45 deg C recommended |  5-45 deg C allowable
  This facility is assumed Class A1/A2 (enterprise datacenter).
  Operative limits applied: Recommended 18-27 deg C | Allowable maximum 32 deg C

TC 9.9 THREE-LEVEL RACK MEASUREMENT (mandatory measurement positions per cabinet):
    Level 1 — Bottom  (U1-U14,  floor to ~25 in):  cold aisle inlet, most critical
    Level 2 — Middle  (U15-U28, 25 in to ~50 in):  mid-rack compute zone
    Level 3 — Top     (U29-U42, 50 in to ~75 in):  upper exhaust return zone

ASME V&V 20 — Standard for Verification and Validation of CFD and Heat Transfer Simulations
  Requires: (a) thermal simulation validated against physical sensor data,
            (b) documented uncertainty bounds and mesh/model convergence evidence,
            (c) formal comparison of simulated vs measured values at the same spatial points.

${dataBlock}

Provide a structured compliance assessment:
1. COMPLIANCE STATUS — COMPLIANT or NON-COMPLIANT per ASHRAE TC 9.9. State which class (A1/A2/A3/A4) this facility is currently operating at and whether that matches the installed equipment class.
2. EQUIPMENT CLASS RISK — Is there a class downgrade risk? (e.g. A1 equipment exposed to A2/A3 inlet conditions.) Which rows or racks are forcing class migration?
3. VIOLATION REPORT — For each violating row/zone: location, estimated temperature at each of the 3 TC 9.9 measurement levels (bottom/middle/top), which limit is breached, and severity.
4. REPORTABLE INCIDENTS — Which violations require formal disclosure (to equipment vendors, insurers, or facility management)? At what temperature threshold does warranty/SLA exposure begin?
5. CORRECTIVE ACTIONS — Steps to restore compliance, ordered: immediate / within 24h / within 1 week.
6. ASME V&V 20 GAP — Identify discrepancies between formula-based simulation and the thermal image baseline that require documented validation with uncertainty quantification per ASME V&V 20.
7. COMPLIANCE RISK RATING — LOW / MEDIUM / HIGH / CRITICAL with justification referencing the specific TC 9.9 class threshold being approached or breached.`;
    } else if (mode === "physics") {
      prompt = `You are a datacenter thermal engineer with deep expertise in thermodynamics, computational fluid dynamics (CFD), heat transfer, and building management systems.

This facility uses hot-aisle/cold-aisle containment with N+1 precision CRAC cooling.
Physics model: idle power ${idleKW.toFixed(1)} kW/rack, peak ${peakKW.toFixed(1)} kW/rack, thermal coefficient 0.969 deg C/kW, ambient supply 18 deg C.

${dataBlock}

Provide a physics-based thermal engineering analysis:
1. THERMAL ENVELOPE — Current operating margin from thermal design limit. Which racks are approaching their design envelope? Express as percentage of headroom remaining.
2. POWER DENSITY ANALYSIS — Flag zones with dangerous power density (kW per rack footprint). Identify any thermal runaway risk zones where adjacent rack heat load compounds.
3. AIRFLOW ASSESSMENT — Based on the thermal image baseline and load distribution, identify likely hot-aisle/cold-aisle mixing issues, bypass airflow paths, or dead zones with poor convective cooling.
4. COOLING HEADROOM — Quantify remaining cooling capacity in kW. At what IT load percentage does the cooling system reach saturation? What is the thermal cascade failure threshold under current CRAC state?
5. OPERATING ENVELOPE — State the min/max safe power envelope per rack and total facility under current cooling conditions. What is the absolute ceiling before forced shutdown is required?
6. LOAD DELTA PREDICTION — If IT load increases from current by +10% / +20% / +30%, predict the temperature delta (deg C) per row and identify which row breaches the allowable limit first.`;
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
    console.error("[analyze-simulation]", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { predictThermal, analyzeSimulation };
