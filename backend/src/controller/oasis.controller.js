const fetch = require("node-fetch");
const { OASIS_API } = require("../config");

// Proxies allocation API endpoints from the OASIS backend (port 7040)

async function getAllocations(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/all/${req.params.datacenter}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/allocations]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

async function getPowerTemp(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/${req.params.id}/power-temp-summary`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/power-temp]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

async function getThermal(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/thermal/${req.params.id}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/thermal]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

async function getReport(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/single/${req.params.id}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/report]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

async function getLayout(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/allocation/2d-layout/${req.params.id}`,
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oasis/layout]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

async function getThermalImage(req, res) {
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/assets/simulation/allocation/${req.params.id}/thermal/thermal_map.png`,
    );
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set("Content-Type", upstream.headers.get("content-type") || "image/png");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error("[oasis/thermal-image]", err.message);
    res.status(502).json({ error: `OASIS API unreachable: ${err.message}` });
  }
}

module.exports = {
  getAllocations,
  getPowerTemp,
  getThermal,
  getReport,
  getLayout,
  getThermalImage,
};
