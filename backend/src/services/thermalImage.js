const fetch = require("node-fetch");
const { OASIS_API } = require("../config");

// Real per-allocation thermal map, served by OASIS. Returns null (no image sent to
// Cosmos) if the allocation has no image yet or OASIS is unreachable — no fallback
// to a generic local file, since that would show the wrong allocation's image.
async function loadThermalImageContent(allocationId) {
  if (!allocationId) return null;
  try {
    const upstream = await fetch(
      `${OASIS_API}/api/assets/simulation/allocation/${allocationId}/thermal/thermal_map.png`,
    );
    if (upstream.ok) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
      };
    }
  } catch (err) {
    console.warn("[thermal-image] OASIS fetch failed:", err.message);
  }
  return null;
}

module.exports = { loadThermalImageContent };
