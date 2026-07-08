#!/usr/bin/env bash
# Folder-driven counterpart to batch_compliance.sh — sources everything from
# the local allocations/ folder instead of the live OASIS API, and posts to
# the testing-only /api/analyze-simulation-local endpoint (see
# backend/src/controller/batchTest.controller.js) instead of the real
# /api/analyze-simulation, so the production API is never touched by this.
#
# Per-allocation folder (allocations/<allocation_id>/) is expected to contain
# the same files the API version reads, just as local files:
#   report.json (or config.json)        — facility configuration
#   temperature/temperature_summary.json — per-rack row/position/stats (mean/max/p95 over
#                                          the whole recorded period — see NOTE below)
#   thermal/thermal_map.png              — the 4-panel combined thermal image
#
# allocations/facility_allocation_table.json (one level up from each allocation
# folder) maps allocation_id -> facility_id (CHI1-CHI3 / DFW3-DFW5), used to
# filter which allocations belong to which requested datacenter.
#
# NOTE on "real" data here: temperature_summary.json is a full-year time
# series SUMMARY (min/max/mean/p95 per rack), not a live instantaneous
# reading like the OASIS thermal API returns. TEMP_FIELD picks which stat to
# treat as the "current" temperature sent to Cosmos — default mean_c (typical
# operating condition). Set TEMP_FIELD=max_c for a worst-case stress test instead.
#
# Requires: curl, jq, base64 (https://jqlang.github.io/jq/download/)
#
# Usage:
#   ./batch_compliance_folder.sh                      # full run, both datacenters
#   LIMIT=3 ./batch_compliance_folder.sh               # only first 3 allocations per datacenter (dry run)
#   TEMP_FIELD=max_c ./batch_compliance_folder.sh      # worst-case instead of mean
#   ALLOCATIONS_DIR=/path/to/allocations ./batch_compliance_folder.sh
#   BACKEND_URL=http://103.204.95.220:7086 ./batch_compliance_folder.sh
#   OUTFILE=results.csv LOGFILE=run.log DATACENTERS="CHI1-CHI3" ./batch_compliance_folder.sh
#
# CSV columns: same as batch_compliance.sh (see that file's header comment).
#
# NOTE: deliberately does NOT use `set -e` — one allocation's bad/missing file
# must not silently kill the whole run. Every failure is caught and written as
# an ERROR row so the loop always continues to the next allocation.

set -u

BACKEND_URL="${BACKEND_URL:-http://localhost:7086}"
# Default: ../../allocations relative to this script (backend/scripts/ -> repo root/allocations)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOCATIONS_DIR="${ALLOCATIONS_DIR:-$SCRIPT_DIR/../../allocations}"
OUTFILE="${OUTFILE:-test_allocation_reasoner_v1_compliance_only_folder.csv}"
LOGFILE="${LOGFILE:-batch_compliance_folder.log}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-1}"   # seconds between Cosmos calls
LIMIT="${LIMIT:-0}"                  # 0 = no limit; set e.g. LIMIT=3 for a dry run
TEMP_FIELD="${TEMP_FIELD:-mean_c}"    # mean_c | max_c | p95_c — which stat = "current" temp
IMAGE_FILE="${IMAGE_FILE:-thermal_map.png}"  # the 4-panel combined image, per allocation's thermal/ dir
read -r -a DATACENTERS <<< "${DATACENTERS:-CHI1-CHI3 DFW3-DFW5}"

FACILITY_TABLE="$ALLOCATIONS_DIR/facility_allocation_table.json"

# Same 7-section layout as batch_compliance.sh — keep these two files' section
# lists in sync if the compliance prompt's numbered headings ever change.
SECTION_HEADS=(
  "COMPLIANCE STATUS"
  "(ENVELOPE RISK|EQUIPMENT CLASS RISK)"
  "(SLA VIOLATION REPORT|VIOLATION REPORT)"
  "REPORTABLE INCIDENTS"
  "CORRECTIVE ACTIONS"
  "ASME V&V 20 GAP"
  "COMPLIANCE RISK RATING"
)

: > "$LOGFILE"

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOGFILE"
}

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
command -v base64 >/dev/null 2>&1 || {
  log "ERROR: base64 is required (should ship with coreutils/git-bash) and re-run."
  exit 1
}
[ -d "$ALLOCATIONS_DIR" ] || {
  log "ERROR: ALLOCATIONS_DIR not found: $ALLOCATIONS_DIR"
  exit 1
}

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

log "=== Folder-driven batch compliance run starting — allocations_dir=$ALLOCATIONS_DIR backend=$BACKEND_URL datacenters=${DATACENTERS[*]} temp_field=$TEMP_FIELD limit=$LIMIT ==="

# ── Warm up vLLM before hammering it with many sequential requests ─────────
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

# ── Build the allocation_id -> facility_id map once ─────────────────────────
if [ -f "$FACILITY_TABLE" ]; then
  facility_map=$(jq -c '.allocations | to_entries | map({key: .key, value: .value.facility_id}) | from_entries' "$FACILITY_TABLE" 2>/dev/null)
else
  log "WARNING: $FACILITY_TABLE not found — falling back to guessing datacenter from the _CHI_/_DFW_ substring in each allocation folder name."
  facility_map='{}'
fi
[ -z "$facility_map" ] && facility_map='{}'

for dc in "${DATACENTERS[@]}"; do
  log "== Datacenter: $dc =="

  alloc_ids=$(find "$ALLOCATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | while IFS= read -r id; do
    fid=$(echo "$facility_map" | jq -r --arg id "$id" '.[$id] // empty')
    if [ -n "$fid" ]; then
      [ "$fid" = "$dc" ] && echo "$id"
    else
      # No facility table — guess from the CHI/DFW substring against the requested datacenter's own prefix
      case "$dc" in
        *CHI*) [[ "$id" == *_CHI_* ]] && echo "$id" ;;
        *DFW*) [[ "$id" == *_DFW_* ]] && echo "$id" ;;
      esac
    fi
  done)

  if [ -z "$alloc_ids" ]; then
    log "  (no local allocation folders found for $dc — skipping)"
    continue
  fi

  count=0
  while IFS= read -r alloc_id; do
    [ -z "$alloc_id" ] && continue
    if [ "$LIMIT" -gt 0 ] && [ "$count" -ge "$LIMIT" ]; then
      log "  (LIMIT=$LIMIT reached for $dc, stopping this datacenter)"
      break
    fi
    count=$((count + 1))
    log "  -> $alloc_id"

    alloc_dir="$ALLOCATIONS_DIR/$alloc_id"
    report_file="$alloc_dir/report.json"
    [ -f "$report_file" ] || report_file="$alloc_dir/config.json"
    temp_file="$alloc_dir/temperature/temperature_summary.json"
    image_file="$alloc_dir/thermal/$IMAGE_FILE"

    if [ ! -f "$report_file" ] || [ ! -f "$temp_file" ]; then
      log "     ERROR: missing report/config.json or temperature_summary.json — skipping"
      write_row "$dc" "$alloc_id" "" "ERROR: missing local data files" "" "" "" "" "" "" "" "" "" "" ""
      continue
    fi

    cfg=$(jq '.configuration // .' "$report_file" 2>/dev/null)
    if [ -z "$cfg" ] || [ "$cfg" = "null" ]; then
      log "     ERROR: report/config.json is invalid JSON — skipping"
      write_row "$dc" "$alloc_id" "" "ERROR: invalid config JSON" "" "" "" "" "" "" "" "" "" "" ""
      continue
    fi
    customer_name=$(echo "$cfg" | jq -r '.customer_name // "unknown"')
    rack_count=$(echo "$cfg" | jq -r '.rack_specs.count // 52')
    num_rows=$(echo "$cfg" | jq -r '.num_rows // 3')
    design_kw=$(echo "$cfg" | jq -r '.it_load_kw // 375')
    peak_kw=$(echo "$cfg" | jq -r '.rack_specs.power_per_rack_kw // 18')
    width_ft=$(echo "$cfg" | jq -r '.alloc_width_ft // empty')
    length_ft=$(echo "$cfg" | jq -r '.alloc_length_ft // empty')

    # temperature_summary.json's series[] already carries row + position_ft per
    # rack — no separate layout join needed, unlike the API-driven script.
    body=$(jq --arg tempField "$TEMP_FIELD" \
      --arg allocId "$alloc_id" --arg dc "$dc" --arg customer "$customer_name" \
      --argjson rackCount "$rack_count" --argjson numRows "$num_rows" \
      --argjson designKW "$design_kw" --argjson peakKW "$peak_kw" \
      --arg widthFt "$width_ft" --arg lengthFt "$length_ft" '
      (.series // []) as $racks |
      ($racks | map({id: .rack_id, row: (.row // 1),
                     temp: (.stats[$tempField] // .stats.mean_c // 0),
                     power: (.power_kw // 0)})) as $withRow |
      (($withRow | map(.power) | add) // 0) as $totalKW |
      (($withRow | map(.temp) | max) // 0) as $maxTemp |
      (($withRow | map(select(.temp > 27)) | length)) as $violations |
      (($withRow | map(select(.temp > 32)) | length)) as $critical |
      ([range(1; $numRows + 1)] | map(. as $r |
        ($withRow | map(select(.row == $r))) as $rr |
        { row: $r, count: ($rr | length),
          avgTemp: (if ($rr | length) > 0 then ($rr | map(.temp) | add / length) else 0 end),
          violations: ($rr | map(select(.temp > 27)) | length) })) as $rowStats |
      ($withRow | sort_by(-.temp) | .[0:8]
        | map({rack_id: .id, row, temp_c: .temp, power_kw: .power})) as $topRisks |
      {
        mode: "compliance",
        facility: ({
          datacenterId: $dc, allocationId: $allocId, customerName: $customer,
          rackCount: $rackCount, numRows: $numRows, designKW: $designKW, peakKW: $peakKW
        } + (if $widthFt != "" then {widthFt: ($widthFt | tonumber)} else {} end)
          + (if $lengthFt != "" then {lengthFt: ($lengthFt | tonumber)} else {} end)),
        scenario: ("Real sensor baseline (" + $tempField + ", folder-driven)"),
        totalKW: $totalKW, facilKW: ($totalKW * 1.4), pue: 1.4,
        maxTemp: $maxTemp, violations: $violations, critical: $critical,
        globalLoad: (if ($rackCount > 0 and $peakKW > 0)
                     then ([$totalKW / ($rackCount * $peakKW), 1] | min) else 0 end),
        coolingOk: true,
        rowStats: $rowStats, topRisks: $topRisks
      }' "$temp_file" 2>/dev/null)

    if [ -z "$body" ]; then
      log "     ERROR: failed to build request body (see $LOGFILE for jq errors) — skipping"
      write_row "$dc" "$alloc_id" "$customer_name" "ERROR: request body build failed" "" "" "" "" "" "" "" "" "" "" ""
      continue
    fi

    if [ -f "$image_file" ]; then
      # base64 of a ~1-2MB PNG is well past the OS's argv length limit, so it
      # can't go through jq via --arg — route it through a temp file instead.
      b64_tmp=$(mktemp)
      base64 -w0 "$image_file" > "$b64_tmp" 2>/dev/null
      body=$(echo "$body" | jq --rawfile img "$b64_tmp" '. + {imageBase64: $img}')
      rm -f "$b64_tmp"
    else
      log "     WARNING: $image_file not found — sending without an image"
    fi

    log_data "$alloc_id — built request body for /api/analyze-simulation-local (image omitted from log)" \
      "$(echo "$body" | jq 'del(.imageBase64)')"

    actual_violations=$(echo "$body" | jq -r '.violations // ""' 2>/dev/null)
    actual_critical=$(echo "$body" | jq -r '.critical // ""' 2>/dev/null)
    actual_max_temp=$(echo "$body" | jq -r '.maxTemp // ""' 2>/dev/null)

    response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation-local" \
      -H "Content-Type: application/json" -d "$body")
    log_data "$alloc_id — POST /api/analyze-simulation-local — response" "$response"

    if ! echo "$response" | jq -e . >/dev/null 2>&1; then
      log "     ERROR: analyze-simulation-local returned invalid/empty JSON — skipping"
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
