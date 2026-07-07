#!/usr/bin/env bash
# Batch-runs the Cosmos compliance analysis (mode=compliance) across every
# allocation in the given datacenters and writes just the COMPLIANCE STATUS
# field to CSV — a first slice of Item 4's full test_allocation_reasoner_v1.xlsx.
# Extend the jq filter + CSV columns once this shape is confirmed to work.
#
# Requires: curl, jq (https://jqlang.github.io/jq/download/)
#
# Usage:
#   ./batch_compliance.sh                       # full run, both datacenters
#   LIMIT=3 ./batch_compliance.sh                # only first 3 allocations per datacenter (dry run)
#   BACKEND_URL=http://103.204.95.220:7086 ./batch_compliance.sh
#   OUTFILE=results.csv DATACENTERS="CHI1-CHI3" ./batch_compliance.sh

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:7086}"
OUTFILE="${OUTFILE:-test_allocation_reasoner_v1_compliance_only.csv}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-1}"   # seconds between Cosmos calls
LIMIT="${LIMIT:-0}"                  # 0 = no limit; set e.g. LIMIT=3 for a dry run
read -r -a DATACENTERS <<< "${DATACENTERS:-CHI1-CHI3 DFW3-DFW5}"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required — install it (apt install jq / choco install jq / https://jqlang.github.io/jq/download/) and re-run." >&2
  exit 1
}

# ── Warm up vLLM before hammering it with ~100+ sequential requests ────────
echo "Warming up vLLM…"
curl -s -X POST "$BACKEND_URL/api/start" >/dev/null
status="starting"
for i in $(seq 1 60); do
  status=$(curl -s "$BACKEND_URL/api/health" | jq -r '.status')
  [ "$status" = "running" ] && break
  echo "  vLLM status: $status ($i/60)"
  sleep 5
done
if [ "$status" != "running" ]; then
  echo "vLLM never became ready — aborting." >&2
  exit 1
fi
echo "vLLM ready."

echo "datacenter,allocation_id,customer_name,compliance_status" > "$OUTFILE"

for dc in "${DATACENTERS[@]}"; do
  echo "== Datacenter: $dc =="
  alloc_ids=$(curl -s "$BACKEND_URL/api/oasis/allocations/$dc" \
    | jq -r 'if type=="array" then .[] else (.allocations // .data // [])[] end
             | if type=="string" then . else .allocationId end' 2>/dev/null || true)

  if [ -z "$alloc_ids" ]; then
    echo "  (no allocations found for $dc — skipping)"
    continue
  fi

  count=0
  while IFS= read -r alloc_id; do
    [ -z "$alloc_id" ] && continue
    if [ "$LIMIT" -gt 0 ] && [ "$count" -ge "$LIMIT" ]; then
      echo "  (LIMIT=$LIMIT reached for $dc, stopping this datacenter)"
      break
    fi
    count=$((count + 1))
    echo "  -> $alloc_id"

    layout_json=$(curl -s "$BACKEND_URL/api/oasis/allocation/$alloc_id/layout")
    thermal_json=$(curl -s "$BACKEND_URL/api/oasis/allocation/$alloc_id/thermal")

    cfg=$(echo "$layout_json" | jq '.data.configuration // .configuration // {}')
    customer_name=$(echo "$cfg" | jq -r '.customer_name // "unknown"')
    rack_count=$(echo "$cfg" | jq -r '.rack_specs.count // 52')
    num_rows=$(echo "$cfg" | jq -r '.num_rows // 3')
    design_kw=$(echo "$cfg" | jq -r '.it_load_kw // 375')
    peak_kw=$(echo "$cfg" | jq -r '.rack_specs.power_per_rack_kw // 18')

    # id -> row lookup, from whichever field the layout API actually used
    rows_lookup=$(echo "$layout_json" | jq -c '
      (.data // .) as $p |
      ($p.layout_elements // $p.racks // $p.rack_list // $p.components // [])
      | map({key: (.id // .rack_id), value: (.row // 1)}) | from_entries')

    # Join real thermal readings with row assignment, aggregate into the
    # rowStats/topRisks shape /api/analyze-simulation expects — using the
    # REAL measured baseline, not a client-side simulated scenario.
    body=$(echo "$thermal_json" | jq --argjson rows "$rows_lookup" \
      --arg allocId "$alloc_id" --arg dc "$dc" --arg customer "$customer_name" \
      --argjson rackCount "$rack_count" --argjson numRows "$num_rows" \
      --argjson designKW "$design_kw" --argjson peakKW "$peak_kw" '
      ((.component_temperatures // []) | map(select(.type=="rack"))) as $racks |
      ($racks | map(. + {row: ($rows[.id] // 1)})) as $withRow |
      (($withRow | map(.power_kw // 0) | add) // 0) as $totalKW |
      (($withRow | map(.temperature_c // 0) | max) // 0) as $maxTemp |
      (($withRow | map(select(.temperature_c > 27)) | length)) as $violations |
      (($withRow | map(select(.temperature_c > 32)) | length)) as $critical |
      ([range(1; $numRows + 1)] | map(. as $r |
        ($withRow | map(select(.row == $r))) as $rr |
        { row: $r, count: ($rr | length),
          avgTemp: (if ($rr | length) > 0 then ($rr | map(.temperature_c) | add / length) else 0 end),
          violations: ($rr | map(select(.temperature_c > 27)) | length) })) as $rowStats |
      ($withRow | sort_by(-.temperature_c) | .[0:8]
        | map({rack_id: .id, row, temp_c: .temperature_c, power_kw: (.power_kw // 0)})) as $topRisks |
      {
        mode: "compliance",
        facility: {
          datacenterId: $dc, allocationId: $allocId, customerName: $customer,
          rackCount: $rackCount, numRows: $numRows, designKW: $designKW, peakKW: $peakKW
        },
        scenario: "Real sensor baseline",
        totalKW: $totalKW, facilKW: ($totalKW * 1.4), pue: 1.4,
        maxTemp: $maxTemp, violations: $violations, critical: $critical,
        globalLoad: (if ($rackCount > 0 and $peakKW > 0)
                     then ([$totalKW / ($rackCount * $peakKW), 1] | min) else 0 end),
        coolingOk: true,
        rowStats: $rowStats, topRisks: $topRisks
      }')

    response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation" \
      -H "Content-Type: application/json" -d "$body")

    compliance_status=$(echo "$response" | jq -r '.result // ""' \
      | grep -o '\*\*COMPLIANCE STATUS:\*\*[^*]*' \
      | sed -E 's/\*\*COMPLIANCE STATUS:\*\*[[:space:]]*//' \
      | tr '\n' ' ' | sed -E 's/  +/ /g; s/[[:space:]]+$//')
    [ -z "$compliance_status" ] && compliance_status="PARSE_ERROR: $(echo "$response" | jq -c '.error // .result // "no response"' | head -c 200)"

    esc_customer=$(echo "$customer_name" | sed 's/"/""/g')
    esc_status=$(echo "$compliance_status" | sed 's/"/""/g')

    echo "$dc,$alloc_id,\"$esc_customer\",\"$esc_status\"" >> "$OUTFILE"
    sleep "$SLEEP_BETWEEN"
  done <<< "$alloc_ids"
done

echo "Done. Results in $OUTFILE"
