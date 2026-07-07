#!/usr/bin/env bash
# Batch-runs the Cosmos compliance analysis (mode=compliance) across every
# allocation in the given datacenters and writes all 7 report sections to CSV —
# Item 4's test_allocation_reasoner_v1.xlsx (Sheet 1), minus the manual columns.
#
# Requires: curl, jq (https://jqlang.github.io/jq/download/)
#
# Usage:
#   ./batch_compliance.sh                       # full run, both datacenters
#   LIMIT=3 ./batch_compliance.sh                # only first 3 allocations per datacenter (dry run)
#   BACKEND_URL=http://103.204.95.220:7086 ./batch_compliance.sh
#   OUTFILE=results.csv LOGFILE=run.log DATACENTERS="CHI1-CHI3" ./batch_compliance.sh
#
# CSV columns:
#   datacenter, allocation_id, customer_name, result_summary,
#   compliance_status, equipment_class_risk, violation_report,
#   reportable_incidents, corrective_actions, asme_vv_gap,
#   compliance_risk_rating, actual_violations, actual_critical, actual_max_temp,
#   is_correct, comments
#
# actual_violations/actual_critical/actual_max_temp are the REAL numbers
# computed directly from the same OASIS thermal data sent to Cosmos — ground
# truth, not a Cosmos claim. is_correct/comments are normally left blank for
# manual review, EXCEPT when those real numbers directly contradict Cosmos's
# own compliance_status/risk_rating (e.g. real violations>0 but Cosmos said
# COMPLIANT) — that's auto-flagged FALSE with an explanatory comment so a
# human only has to review the genuinely ambiguous/qualitative rows.
#
# Two output files:
#   OUTFILE (CSV)  — one row per allocation, columns above
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

# Ordered to match the 7 numbered sections in the compliance prompt
# (simulation.controller.js). Each pattern also matches the older pre-rename
# heading text so this keeps working even if the model echoes stale phrasing.
SECTION_HEADS=(
  "COMPLIANCE STATUS"
  "(ENVELOPE RISK|EQUIPMENT CLASS RISK)"
  "(SLA VIOLATION REPORT|VIOLATION REPORT)"
  "REPORTABLE INCIDENTS"
  "CORRECTIVE ACTIONS"
  "ASME V&V 20 GAP"
  "COMPLIANCE RISK RATING"
)
SECTION_COLS=(compliance_status equipment_class_risk violation_report reportable_incidents corrective_actions asme_vv_gap compliance_risk_rating)

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

# Builds the alternation regex of every heading AFTER index $1, used as the
# "stop" boundary when extracting the section that starts at index $1-1.
build_stop_re() {
  local start_idx="$1" n=${#SECTION_HEADS[@]} parts=() j
  for ((j = start_idx; j < n; j++)); do
    parts+=("${SECTION_HEADS[$j]}")
  done
  if [ ${#parts[@]} -eq 0 ]; then
    printf ''
  else
    local IFS='|'
    printf '(%s)' "${parts[*]}"
  fi
}

# Extracts the text between a heading and the next one. Tolerant of Cosmos's
# inconsistent formatting: sometimes "**HEADING:** value" on one line,
# sometimes "**HEADING**" with the (also bolded) value on the next line,
# sometimes a plain numbered list with no bold/colon at all.
extract_section() {
  local text="$1" head_re="$2" stop_re="$3"
  printf '%s' "$text" | awk -v head="$head_re" -v stop="$stop_re" '
    $0 ~ head && !found {
      found = 1
      line = $0
      sub(".*" head "[:]?\\*{0,2}", "", line)
      if (line ~ /[A-Za-z0-9]/) print line
      next
    }
    found && stop != "" && $0 ~ stop { exit }
    found { print }
  ' | tr -d '*' | tr '\n' ' ' \
    | sed -E 's/  +/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^[-—:[:space:]]+//'
}

csv_escape() {
  printf '%s' "$1" | sed 's/"/""/g'
}

# Cross-checks Cosmos's stated result against the REAL numbers already
# computed from OASIS thermal data (not Cosmos's own claims). Sets globals
# AUTO_IS_CORRECT ("FALSE" or "") and AUTO_COMMENT. Only flags clear logical
# contradictions — silence (both left "") means "no objective contradiction
# found", NOT "confirmed correct" — qualitative columns still need a human.
auto_check() {
  local summary="$1" risk="$2" viol="$3" crit="$4"
  local risk_upper flags=() f joined=""
  risk_upper=$(printf '%s' "$risk" | tr '[:lower:]' '[:upper:]')

  if [[ "$viol" =~ ^[0-9]+$ ]]; then
    [ "$viol" -gt 0 ] && [ "$summary" = "COMPLIANT" ] \
      && flags+=("$viol rack(s) exceed 27C in real data but Cosmos reported COMPLIANT")
    [ "$viol" -eq 0 ] && [ "$summary" = "NON-COMPLIANT" ] \
      && flags+=("0 racks exceed 27C in real data but Cosmos reported NON-COMPLIANT")
  fi
  if [[ "$crit" =~ ^[0-9]+$ ]] && [ "$crit" -gt 0 ] && [[ "$risk_upper" == LOW* ]]; then
    flags+=("$crit rack(s) at/above 32C (critical) in real data but risk rating says LOW")
  fi

  if [ ${#flags[@]} -gt 0 ]; then
    AUTO_IS_CORRECT="FALSE"
    for f in "${flags[@]}"; do
      [ -z "$joined" ] && joined="$f" || joined="$joined; $f"
    done
    AUTO_COMMENT="Auto-flag: $joined"
  else
    AUTO_IS_CORRECT=""
    AUTO_COMMENT=""
  fi
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

echo "datacenter,allocation_id,customer_name,result_summary,compliance_status,equipment_class_risk,violation_report,reportable_incidents,corrective_actions,asme_vv_gap,compliance_risk_rating,actual_violations,actual_critical,actual_max_temp,is_correct,comments" > "$OUTFILE"

# Appends one CSV row.
# Args: dc alloc_id customer result_summary actual_violations actual_critical
#       actual_max_temp is_correct comments <7 section values...>
write_row() {
  local dc="$1" alloc_id="$2" customer="$3" result_summary="$4"
  local av="$5" ac="$6" amt="$7" is_correct="$8" comments="$9"
  shift 9
  local row="$dc,$alloc_id,\"$(csv_escape "$customer")\",\"$(csv_escape "$result_summary")\""
  local s
  for s in "$@"; do
    row+=",\"$(csv_escape "$s")\""
  done
  row+=",\"$(csv_escape "$av")\",\"$(csv_escape "$ac")\",\"$(csv_escape "$amt")\",\"$(csv_escape "$is_correct")\",\"$(csv_escape "$comments")\""
  echo "$row" >> "$OUTFILE"
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
      write_row "$dc" "$alloc_id" "" "ERROR: layout fetch failed" "" "" "" "" "" "" "" "" "" "" ""
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    thermal_json=$(curl -s --max-time 30 "$BACKEND_URL/api/oasis/allocation/$alloc_id/thermal")
    log_data "$alloc_id — GET /api/oasis/allocation/$alloc_id/thermal — response" "$thermal_json"
    if ! echo "$thermal_json" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: thermal fetch returned invalid/empty JSON — skipping"
      write_row "$dc" "$alloc_id" "" "ERROR: thermal fetch failed" "" "" "" "" "" "" "" "" "" "" ""
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
      write_row "$dc" "$alloc_id" "$customer_name" "ERROR: request body build failed" "" "" "" "" "" "" "" "" "" "" ""
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    # Ground truth — computed straight from the real thermal data, independent
    # of anything Cosmos says. Available for every path from here on, even if
    # the model call itself fails, since $body already has these baked in.
    actual_violations=$(echo "$body" | jq -r '.violations // ""' 2>/dev/null)
    actual_critical=$(echo "$body" | jq -r '.critical // ""' 2>/dev/null)
    actual_max_temp=$(echo "$body" | jq -r '.maxTemp // ""' 2>/dev/null)

    response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation" \
      -H "Content-Type: application/json" -d "$body")
    log_data "$alloc_id — POST /api/analyze-simulation — response" "$response"

    if ! echo "$response" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: analyze-simulation returned invalid/empty JSON — skipping"
      write_row "$dc" "$alloc_id" "$customer_name" "ERROR: invalid API response" \
        "$actual_violations" "$actual_critical" "$actual_max_temp" "" "" "" "" "" "" "" ""
      sleep "$SLEEP_BETWEEN"
      continue
    fi

    result_text=$(echo "$response" | jq -r '.result // ""')

    section_values=()
    for idx in "${!SECTION_HEADS[@]}"; do
      stop_re=$(build_stop_re $((idx + 1)))
      section_values+=("$(extract_section "$result_text" "${SECTION_HEADS[$idx]}" "$stop_re")")
    done
    compliance_status="${section_values[0]}"

    if [ -z "$compliance_status" ]; then
      api_error=$(echo "$response" | jq -r '.error // empty')
      if [ -n "$api_error" ]; then
        err_msg="ERROR: $api_error"
      elif [ -z "$result_text" ]; then
        err_msg="ERROR: empty result from model"
      else
        err_msg="PARSE_ERROR: heading not found in response (check prompt/heading text still matches)"
      fi
      log "     WARNING: $err_msg"
      write_row "$dc" "$alloc_id" "$customer_name" "$err_msg" \
        "$actual_violations" "$actual_critical" "$actual_max_temp" "" "" \
        "$err_msg" "" "" "" "" ""
    else
      result_summary=$(printf '%s' "$compliance_status" | grep -oiE 'NON-COMPLIANT|CONDITIONAL|COMPLIANT' | head -1)
      [ -z "$result_summary" ] && result_summary="UNKNOWN"

      auto_check "$result_summary" "${section_values[6]}" "$actual_violations" "$actual_critical"
      if [ -n "$AUTO_IS_CORRECT" ]; then
        log "     result_summary: $result_summary  [$AUTO_COMMENT]"
      else
        log "     result_summary: $result_summary"
      fi

      write_row "$dc" "$alloc_id" "$customer_name" "$result_summary" \
        "$actual_violations" "$actual_critical" "$actual_max_temp" \
        "$AUTO_IS_CORRECT" "$AUTO_COMMENT" "${section_values[@]}"
    fi

    sleep "$SLEEP_BETWEEN"
  done <<< "$alloc_ids"
done

log "Done. Results in $OUTFILE, full debug log in $LOGFILE"
