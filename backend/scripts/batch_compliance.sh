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
#   OUTFILE=results.csv LOGFILE=run.log DATACENTERS="CHI1-CHI3" ./batch_compliance.sh
#
# Two output files:
#   OUTFILE (CSV)  — one row per allocation: datacenter, allocation_id, customer_name, compliance_status
#   LOGFILE (text) — every console progress line PLUS the full raw request/response
#                    JSON for every API call, per allocation, for debugging failures
#
# NOTE: deliberately does NOT use `set -e` — this is a long batch job over many
# allocations, and one allocation's API hiccup (bad JSON, no compliance match,
# timeout) must not silently kill the whole run. Every failure is caught and
# written as an ERROR row so the loop always continues to the next allocation.

set -u

BACKEND_URL="${BACKEND_URL:-http://localhost:7086}"
OUTFILE="${OUTFILE:-test_allocation_reasoner_v1_compliance_only.csv}"
LOGFILE="${LOGFILE:-batch_compliance.log}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-1}"   # seconds between Cosmos calls
LIMIT="${LIMIT:-0}"                  # 0 = no limit; set e.g. LIMIT=3 for a dry run
read -r -a DATACENTERS <<< "${DATACENTERS:-CHI1-CHI3 DFW3-DFW5}"

: > "$LOGFILE"

# Prints to console AND appends to the log file (timestamped) — use for
# progress/status/error messages.
log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOGFILE"
}

# Appends verbose data (raw API request/response JSON) to the log file ONLY —
# keeps the console readable while the log file has full detail per allocation.
log_data() {
  local label="$1" data="$2"
  {
    echo "----- $label -----"
    echo "$data"
    echo "-------------------"
  } >> "$LOGFILE"
}

command -v jq >/dev/null 2>&1 || {
  log "ERROR: jq is required — install it (apt install jq / choco install jq / https://jqlang.github.io/jq/download/) and re-run."
  exit 1
}

log "=== Batch compliance run starting — backend=$BACKEND_URL datacenters=${DATACENTERS[*]} limit=$LIMIT ==="

# ── Warm up vLLM before hammering it with ~100+ sequential requests ────────
log "Warming up vLLM…"
curl -s --max-time 30 -X POST "$BACKEND_URL/api/start" >/dev/null
status="starting"
for i in $(seq 1 60); do
  status=$(curl -s --max-time 10 "$BACKEND_URL/api/health" | jq -r '.status // "unknown"' 2>/dev/null)
  [ "$status" = "running" ] && break
  log "  vLLM status: ${status:-unknown} ($i/60)"
  sleep 5
done
if [ "$status" != "running" ]; then
  log "ERROR: vLLM never became ready — aborting."
  exit 1
fi
log "vLLM ready."

echo "datacenter,allocation_id,customer_name,compliance_status" > "$OUTFILE"

# Appends one CSV row, CSV-escaping the two free-text fields. Never fails.
write_row() {
  local dc="$1" alloc_id="$2" customer="$3" status_text="$4"
  local esc_customer esc_status
  esc_customer=$(printf '%s' "$customer" | sed 's/"/""/g')
  esc_status=$(printf '%s' "$status_text" | sed 's/"/""/g')
  echo "$dc,$alloc_id,\"$esc_customer\",\"$esc_status\"" >> "$OUTFILE"
}

for dc in "${DATACENTERS[@]}"; do
  log "== Datacenter: $dc =="
  alloc_ids=$(curl -s --max-time 30 "$BACKEND_URL/api/oasis/allocations/$dc" \
    | jq -r 'if type=="array" then .[] else (.allocations // .data // [])[] end
             | if type=="string" then . else .allocationId end' 2>/dev/null)

  if [ -z "$alloc_ids" ]; then
    log "  (no allocations found for $dc — skipping)"
    continue
  fi

  count=0
  while IFS= read -r alloc_id; do
    alloc_id="${alloc_id%$'\r'}"  # strip a stray trailing CR (e.g. CRLF from jq on some platforms) —
                                  # left in, it gets embedded straight into every URL built below
    [ -z "$alloc_id" ] && continue
    if [ "$LIMIT" -gt 0 ] && [ "$count" -ge "$LIMIT" ]; then
      log "  (LIMIT=$LIMIT reached for $dc, stopping this datacenter)"
      break
    fi
    count=$((count + 1))
    log "  -> $alloc_id"
    log_data "$dc / $alloc_id — START" ""

    layout_json=$(curl -s --max-time 30 "$BACKEND_URL/api/oasis/allocation/$alloc_id/layout")
    log_data "$alloc_id — GET /api/oasis/allocation/$alloc_id/layout — response" "$layout_json"
    if ! echo "$layout_json" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: layout fetch returned invalid/empty JSON — skipping"
      write_row "$dc" "$alloc_id" "" "ERROR: layout fetch failed"
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    thermal_json=$(curl -s --max-time 30 "$BACKEND_URL/api/oasis/allocation/$alloc_id/thermal")
    log_data "$alloc_id — GET /api/oasis/allocation/$alloc_id/thermal — response" "$thermal_json"
    if ! echo "$thermal_json" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: thermal fetch returned invalid/empty JSON — skipping"
      write_row "$dc" "$alloc_id" "" "ERROR: thermal fetch failed"
      sleep "$SLEEP_BETWEEN"
      continue
    fi

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
      | map({key: (.id // .rack_id), value: (.row // 1)}) | from_entries' 2>/dev/null)
    [ -z "$rows_lookup" ] && rows_lookup='{}'

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
      }' 2>/dev/null)

    log_data "$alloc_id — built request body for /api/analyze-simulation" "$body"

    if [ -z "$body" ]; then
      log "     ERROR: failed to build request body (see $LOGFILE for jq errors) — skipping"
      write_row "$dc" "$alloc_id" "$customer_name" "ERROR: request body build failed"
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation" \
      -H "Content-Type: application/json" -d "$body")
    log_data "$alloc_id — POST /api/analyze-simulation — response" "$response"

    if ! echo "$response" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: analyze-simulation returned invalid/empty JSON — skipping"
      write_row "$dc" "$alloc_id" "$customer_name" "ERROR: invalid API response"
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    result_text=$(echo "$response" | jq -r '.result // ""')
    compliance_status=$(printf '%s' "$result_text" \
      | grep -o '\*\*COMPLIANCE STATUS:\*\*[^*]*' \
      | sed -E 's/\*\*COMPLIANCE STATUS:\*\*[[:space:]]*//' \
      | tr '\n' ' ' | sed -E 's/  +/ /g; s/[[:space:]]+$//')

    if [ -z "$compliance_status" ]; then
      api_error=$(echo "$response" | jq -r '.error // empty')
      if [ -n "$api_error" ]; then
        compliance_status="ERROR: $api_error"
      elif [ -z "$result_text" ]; then
        compliance_status="ERROR: empty result from model"
      else
        compliance_status="PARSE_ERROR: heading not found in response (check prompt/heading text still matches)"
      fi
      log "     WARNING: $compliance_status"
    else
      log "     compliance_status: $compliance_status"
    fi

    write_row "$dc" "$alloc_id" "$customer_name" "$compliance_status"
    sleep "$SLEEP_BETWEEN"
  done <<< "$alloc_ids"
done

log "Done. Results in $OUTFILE, full debug log in $LOGFILE"
