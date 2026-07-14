#!/usr/bin/env bash
# Multi-model counterpart to batch_compliance_folder.sh — runs the SAME
# compliance prompt (from backend/prompts/, versioned) against one or more
# models from backend/src/config/models.js (Cosmos via vLLM, or Gemma4/
# Qwen3-VL/Qwen3.5 via Ollama), for comparison purposes.
#
# batch_compliance.sh and batch_compliance_folder.sh are NOT modified by this
# work and remain exactly as they were — this is a separate, new script.
#
# Sources allocation data from the local allocations/ folder, same as
# batch_compliance_folder.sh (report.json/config.json +
# temperature/temperature_summary.json + thermal/thermal_map.png — see that
# script's header comment for the full data-shape notes). Posts to the
# testing-only /api/analyze-simulation-local endpoint, never the real
# /api/analyze-simulation.
#
# ── GPU constraint (IMPORTANT) ──────────────────────────────────────────────
# Ollama and Cosmos (vLLM) cannot run on the GPU at the same time on the
# deployment box. This script does NOT try to stop/start either service for
# you — it only refuses to run if $MODELS mixes the "vllm" and "ollama"
# provider families in the same invocation, since that combination can never
# succeed. Run once per family, manually swapping which service is up
# in between:
#   MODELS=cosmos ./batch_multi_model.sh                    # vLLM must be up (default anyway)
#   ... stop vLLM, start Ollama ...
#   MODELS="qwen3vl qwen35 gemma4" ./batch_multi_model.sh    # Ollama must be up
#
# Requires: curl, jq, base64, node (to read the model registry), python3/PIL
# (for image resizing — see batch_compliance_folder.sh)
#
# Usage:
#   MODELS=cosmos ./batch_multi_model.sh
#   MODELS="qwen3vl gemma4" ./batch_multi_model.sh
#   LIMIT=2 MODELS=qwen3vl ./batch_multi_model.sh            # dry run
#   PROMPT_VERSION=R1 BACKEND_URL=http://103.204.95.220:7086 ./batch_multi_model.sh
#
# One CSV per model, written to backend/evaluations/results/, following the
# team's naming convention (date_model_promptVersion_modelId.csv):
#   results/<RUN_DATE>_model_<promptVersion>_<modelId>.csv
# e.g. results/2026-07-13_model_R1_qwen36.csv
# One log file per model, next to the script (unchanged):
#   batch_multi_model_<modelId>.log
# CSV columns: same as batch_compliance_folder.sh, plus model + model_label.
#
# RUN_DATE defaults to today (YYYY-MM-DD) and can be overridden — set it to an
# earlier date to resume/append to that day's file instead of starting a new
# one for today.
#
# RESUMABLE: if the script is interrupted (Ctrl+C, backend crash, etc.) partway
# through a model, just re-run the exact same command on the SAME DAY — for
# each model, any allocation_id already present in that day's CSV is skipped,
# and the run continues with whatever's left (LIMIT counts only
# newly-processed allocations, not skipped ones). Resuming on a later day
# requires passing the original RUN_DATE explicitly, since the filename is
# date-stamped. To force a clean re-run of a model instead of resuming,
# delete its CSV first, or set RESET=1 to have the script delete it for you
# before starting.
#
# NOTE: deliberately does NOT use `set -e` — same reasoning as the other two
# batch scripts (one allocation's failure must not kill the whole run).

set -u

BACKEND_URL="${BACKEND_URL:-http://localhost:7086}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOCATIONS_DIR="${ALLOCATIONS_DIR:-$SCRIPT_DIR/../../allocations}"
LIMIT="${LIMIT:-0}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-1}"
TEMP_FIELD="${TEMP_FIELD:-mean_c}"
IMAGE_FILE="${IMAGE_FILE:-thermal_map.png}"
MAX_IMAGE_WIDTH="${MAX_IMAGE_WIDTH:-1600}"
PROMPT_VERSION="${PROMPT_VERSION:-R1}"
RESET="${RESET:-0}"
RUN_DATE="${RUN_DATE:-$(date +%Y-%m-%d)}"
RESULTS_DIR="${RESULTS_DIR:-$SCRIPT_DIR/results}"
mkdir -p "$RESULTS_DIR"
read -r -a DATACENTERS <<< "${DATACENTERS:-CHI1-CHI3 DFW3-DFW5}"
read -r -a MODELS_ARR <<< "${MODELS:-cosmos}"

FACILITY_TABLE="$ALLOCATIONS_DIR/facility_allocation_table.json"
MODELS_JS="$SCRIPT_DIR/../src/config/models.js"

SECTION_HEADS=(
  "COMPLIANCE STATUS"
  "(ENVELOPE RISK|EQUIPMENT CLASS RISK)"
  "(SLA VIOLATION REPORT|VIOLATION REPORT)"
  "REPORTABLE INCIDENTS"
  "CORRECTIVE ACTIONS"
  "ASME V&V 20 GAP"
  "COMPLIANCE RISK RATING"
)

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$CURRENT_LOGFILE"
}

log_data() {
  local label="$1" data="$2"
  {
    echo "----- $label -----"
    echo "$data"
    echo "-------------------"
  } >> "$CURRENT_LOGFILE"
}

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required." >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "ERROR: base64 is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required (to read the model registry)." >&2; exit 1; }
[ -d "$ALLOCATIONS_DIR" ] || { echo "ERROR: ALLOCATIONS_DIR not found: $ALLOCATIONS_DIR" >&2; exit 1; }
[ -f "$MODELS_JS" ] || { echo "ERROR: model registry not found: $MODELS_JS" >&2; exit 1; }

PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "from PIL import Image" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "ERROR: python3 (or python) with Pillow is required for image resizing." >&2; exit 1; }

# ── Load the model registry once, straight from the backend's own source of
#    truth — no duplicated model list to drift out of sync in this script. ──
REGISTRY_JSON=$(node -e "console.log(JSON.stringify(require(process.argv[1])))" "$MODELS_JS")
[ -n "$REGISTRY_JSON" ] || { echo "ERROR: failed to load model registry from $MODELS_JS" >&2; exit 1; }

# ── Validate every requested model exists, and enforce the GPU-safety rule:
#    a single invocation may only target one provider family. ─────────────
providers_seen=()
for model_id in "${MODELS_ARR[@]}"; do
  provider=$(echo "$REGISTRY_JSON" | jq -r --arg id "$model_id" '.[$id].provider // empty')
  if [ -z "$provider" ]; then
    echo "ERROR: unknown model \"$model_id\" — must be one of: $(echo "$REGISTRY_JSON" | jq -r 'keys | join(", ")')" >&2
    exit 1
  fi
  providers_seen+=("$provider")
done
unique_providers=$(printf '%s\n' "${providers_seen[@]}" | sort -u)
if [ "$(echo "$unique_providers" | wc -l)" -gt 1 ]; then
  echo "ERROR: MODELS=\"${MODELS_ARR[*]}\" mixes provider families (${unique_providers//$'\n'/, }) in one run." >&2
  echo "       Ollama and Cosmos/vLLM cannot run on the GPU at the same time — run once per family," >&2
  echo "       swapping which service is up on the server in between. See this script's header comment." >&2
  exit 1
fi

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

join_semi() {
  local out="" first=1 s
  for s in "$@"; do
    if [ "$first" -eq 1 ]; then out="$s"; first=0; else out="$out; $s"; fi
  done
  printf '%s' "$out"
}

auto_check() {
  local summary="$1" risk="$2" viol="$3" crit="$4" rack_count="${5:-}"
  local risk_upper pass=() fail=() denom=""
  risk_upper=$(printf '%s' "$risk" | tr '[:lower:]' '[:upper:]')
  [ -n "$rack_count" ] && denom="/$rack_count"

  local nums_ok=0
  [[ "$viol" =~ ^[0-9]+$ ]] && [[ "$crit" =~ ^[0-9]+$ ]] && nums_ok=1

  if [ "$nums_ok" -eq 1 ]; then
    local expected_status
    if [ "$viol" -gt 0 ]; then expected_status="NON-COMPLIANT"; else expected_status="COMPLIANT"; fi
    case "$summary" in
      COMPLIANT|NON-COMPLIANT)
        if [ "$summary" = "$expected_status" ]; then
          pass+=("compliance status '$summary' matches real data ($viol$denom racks exceed 27C)")
        else
          fail+=("compliance status says $summary but real data shows $viol$denom rack(s) exceed 27C (expected $expected_status)")
        fi
        ;;
    esac

    if [ "$crit" -gt 0 ] && [[ "$risk_upper" == LOW* ]]; then
      fail+=("risk rating '$risk' but $crit$denom rack(s) at/above 32C (critical) — should not be LOW")
    elif [ "$viol" -gt 0 ] && [ "$crit" -eq 0 ] && [[ "$risk_upper" == LOW* ]]; then
      fail+=("risk rating '$risk' but $viol$denom rack(s) exceed 27C (recommended limit) — should not be LOW")
    elif [ "$viol" -eq 0 ] && [ "$crit" -eq 0 ] && [ -n "$risk_upper" ]; then
      pass+=("risk rating '$risk' is consistent with 0 violations and 0 critical racks")
    elif [ "$crit" -gt 0 ] && [ -n "$risk_upper" ] && [[ "$risk_upper" != LOW* ]]; then
      pass+=("risk rating '$risk' is consistent with $crit$denom critical rack(s)")
    fi
  fi

  if [ "$nums_ok" -ne 1 ] || [ -z "$summary" ] || [ "$summary" = "CONDITIONAL" ] || [ "$summary" = "UNKNOWN" ]; then
    if [ ${#fail[@]} -gt 0 ]; then
      AUTO_IS_CORRECT="FALSE"
      AUTO_COMMENT="Auto-flag: $(join_semi "${fail[@]}")"
    else
      AUTO_IS_CORRECT=""
      AUTO_COMMENT="Not auto-verifiable: compliance_status is '${summary:-empty}' (ambiguous) or real violation/critical counts unavailable — needs manual review."
    fi
    return
  fi

  if [ ${#fail[@]} -gt 0 ]; then
    AUTO_IS_CORRECT="FALSE"
    AUTO_COMMENT="Auto-flag: $(join_semi "${fail[@]}")"
  elif [ ${#pass[@]} -gt 0 ]; then
    AUTO_IS_CORRECT="TRUE"
    AUTO_COMMENT="Auto-verified: $(join_semi "${pass[@]}")"
  else
    AUTO_IS_CORRECT=""
    AUTO_COMMENT="Not auto-verifiable from the numeric fields alone — needs manual review."
  fi
}

resize_and_b64() {
  local src="$1" dest="$2"
  "$PYTHON_BIN" -c '
import sys, base64
from io import BytesIO
from PIL import Image

src, dest, max_w = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = Image.open(src)
orig = img.size
if img.width > max_w:
    ratio = max_w / img.width
    img = img.resize((max_w, max(1, round(img.height * ratio))), Image.LANCZOS)
print(f"{orig[0]}x{orig[1]} -> {img.width}x{img.height}", file=sys.stderr)
buf = BytesIO()
img.save(buf, format="PNG")
with open(dest, "w") as f:
    f.write(base64.b64encode(buf.getvalue()).decode("ascii"))
' "$src" "$dest" "$MAX_IMAGE_WIDTH"
}

write_row() {
  local dc="$1" alloc_id="$2" customer="$3" result_summary="$4"
  local av="$5" ac="$6" amt="$7" is_correct="$8" comments="$9"
  shift 9
  local model_id="$1" model_label="$2" model_probe="$3"
  shift 3
  local row="$dc,$alloc_id,\"$(csv_escape "$customer")\",\"$(csv_escape "$result_summary")\""
  local s
  for s in "$@"; do
    row+=",\"$(csv_escape "$s")\""
  done
  row+=",\"$(csv_escape "$av")\",\"$(csv_escape "$ac")\",\"$(csv_escape "$amt")\",\"$(csv_escape "$is_correct")\",\"$(csv_escape "$comments")\",\"$(csv_escape "$model_id")\",\"$(csv_escape "$model_label")\",\"$(csv_escape "$model_probe")\""
  echo "$row" >> "$CURRENT_OUTFILE"
}

if [ -f "$FACILITY_TABLE" ]; then
  facility_map=$(jq -c '.allocations | to_entries | map({key: .key, value: .value.facility_id}) | from_entries' "$FACILITY_TABLE" 2>/dev/null)
else
  facility_map='{}'
fi
[ -z "$facility_map" ] && facility_map='{}'

echo "=== Multi-model batch run — models=${MODELS_ARR[*]} backend=$BACKEND_URL prompt_version=$PROMPT_VERSION limit=$LIMIT ==="

for model_id in "${MODELS_ARR[@]}"; do
  model_label=$(echo "$REGISTRY_JSON" | jq -r --arg id "$model_id" '.[$id].label')
  provider=$(echo "$REGISTRY_JSON" | jq -r --arg id "$model_id" '.[$id].provider')

  CURRENT_OUTFILE="$RESULTS_DIR/${RUN_DATE}_model_${PROMPT_VERSION}_${model_id}.csv"
  CURRENT_LOGFILE="$SCRIPT_DIR/batch_multi_model_${model_id}.log"

  if [ "$RESET" = "1" ]; then
    rm -f "$CURRENT_OUTFILE" "$CURRENT_LOGFILE"
  fi

  # Resume support: any allocation_id already written to this model's CSV from
  # a prior (possibly interrupted) run is skipped below instead of re-sent.
  # dc/alloc_id are always unquoted, comma-free fields (see write_row), so a
  # plain cut on column 2 is safe even though later columns may contain commas.
  declare -A done_ids=()
  resumed=0
  if [ -f "$CURRENT_OUTFILE" ]; then
    resumed=1
    while IFS= read -r prev_id; do
      [ -n "$prev_id" ] && done_ids["$prev_id"]=1
    done < <(tail -n +2 "$CURRENT_OUTFILE" | cut -d',' -f2)
  fi

  log "=== Model: $model_id ($model_label, provider=$provider) — outfile=$CURRENT_OUTFILE ==="
  if [ "$resumed" -eq 1 ]; then
    log "Resuming — ${#done_ids[@]} allocation(s) already in $CURRENT_OUTFILE will be skipped."
  fi

  if [ "$provider" = "vllm" ]; then
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
      log "ERROR: vLLM never became ready — skipping model $model_id."
      continue
    fi
    log "vLLM ready."
  else
    log "Ollama-served model — no warm-up step, requests go straight through."
  fi

  if [ "$resumed" -eq 0 ]; then
    echo "datacenter,allocation_id,customer_name,result_summary,compliance_status,equipment_class_risk,violation_report,reportable_incidents,corrective_actions,asme_vv_gap,compliance_risk_rating,actual_violations,actual_critical,actual_max_temp,is_correct,comments,model,model_label,model_probe" > "$CURRENT_OUTFILE"
  fi

  for dc in "${DATACENTERS[@]}"; do
    log "== Datacenter: $dc =="

    alloc_ids=$(find "$ALLOCATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | while IFS= read -r id; do
      fid=$(echo "$facility_map" | jq -r --arg id "$id" '.[$id] // empty')
      if [ -n "$fid" ]; then
        [ "$fid" = "$dc" ] && echo "$id"
      else
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
      if [ -n "${done_ids[$alloc_id]:-}" ]; then
        log "  (already processed, skipping) $alloc_id"
        continue
      fi
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

      # write_row args after model_label: model_probe, then the 7 compliance
      # section values (compliance_status .. compliance_risk_rating) — see
      # write_row()'s definition above. All blank on these early-exit error paths.
      if [ ! -f "$report_file" ] || [ ! -f "$temp_file" ]; then
        log "     ERROR: missing report/config.json or temperature_summary.json — skipping"
        write_row "$dc" "$alloc_id" "" "ERROR: missing local data files" "" "" "" "" "" "$model_id" "$model_label" "" "" "" "" "" "" "" ""
        continue
      fi

      cfg=$(jq '.configuration // .' "$report_file" 2>/dev/null)
      if [ -z "$cfg" ] || [ "$cfg" = "null" ]; then
        log "     ERROR: report/config.json is invalid JSON — skipping"
        write_row "$dc" "$alloc_id" "" "ERROR: invalid config JSON" "" "" "" "" "" "$model_id" "$model_label" "" "" "" "" "" "" "" ""
        continue
      fi
      customer_name=$(echo "$cfg" | jq -r '.customer_name // "unknown"')
      rack_count=$(echo "$cfg" | jq -r '.rack_specs.count // 52')
      num_rows=$(echo "$cfg" | jq -r '.num_rows // 3')
      design_kw=$(echo "$cfg" | jq -r '.it_load_kw // 375')
      peak_kw=$(echo "$cfg" | jq -r '.rack_specs.power_per_rack_kw // 18')
      width_ft=$(echo "$cfg" | jq -r '.alloc_width_ft // empty')
      length_ft=$(echo "$cfg" | jq -r '.alloc_length_ft // empty')

      body=$(jq --arg tempField "$TEMP_FIELD" \
        --arg allocId "$alloc_id" --arg dc "$dc" --arg customer "$customer_name" \
        --argjson rackCount "$rack_count" --argjson numRows "$num_rows" \
        --argjson designKW "$design_kw" --argjson peakKW "$peak_kw" \
        --arg widthFt "$width_ft" --arg lengthFt "$length_ft" \
        --arg modelId "$model_id" --arg promptVersion "$PROMPT_VERSION" '
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
          modelId: $modelId,
          promptVersion: $promptVersion,
          facility: ({
            datacenterId: $dc, allocationId: $allocId, customerName: $customer,
            rackCount: $rackCount, numRows: $numRows, designKW: $designKW, peakKW: $peakKW
          } + (if $widthFt != "" then {widthFt: ($widthFt | tonumber)} else {} end)
            + (if $lengthFt != "" then {lengthFt: ($lengthFt | tonumber)} else {} end)),
          scenario: ("Real sensor baseline (" + $tempField + ", folder-driven, model=" + $modelId + ")"),
          totalKW: $totalKW, facilKW: ($totalKW * 1.4), pue: 1.4,
          maxTemp: $maxTemp, violations: $violations, critical: $critical,
          globalLoad: (if ($rackCount > 0 and $peakKW > 0)
                       then ([$totalKW / ($rackCount * $peakKW), 1] | min) else 0 end),
          coolingOk: true,
          rowStats: $rowStats, topRisks: $topRisks
        }' "$temp_file" 2>/dev/null)

      if [ -z "$body" ]; then
        log "     ERROR: failed to build request body (see $CURRENT_LOGFILE for jq errors) — skipping"
        write_row "$dc" "$alloc_id" "$customer_name" "ERROR: request body build failed" "" "" "" "" "" "$model_id" "$model_label" "" "" "" "" "" "" "" ""
        continue
      fi

      if [ -f "$image_file" ]; then
        b64_tmp=$(mktemp)
        resize_msg=$(resize_and_b64 "$image_file" "$b64_tmp" 2>&1 >/dev/null)
        [ -n "$resize_msg" ] && log "     image resized: $resize_msg"
        body=$(echo "$body" | jq --rawfile img "$b64_tmp" '. + {imageBase64: $img}')
        rm -f "$b64_tmp"
      else
        log "     WARNING: $image_file not found — sending without an image"
      fi

      log_data "$alloc_id — built request body for /api/analyze-simulation-local (image omitted from log)" \
        "$(echo "$body" | jq 'del(.imageBase64)')"

      # Model probing: a SEPARATE call with its own minimal prompt (backend/prompts/probe_R1.txt)
      # — pure visual description of the same image, no facility numbers or compliance framing.
      # Reuses $body (same image already attached) with mode overridden to "probe".
      model_probe_text=""
      probe_body=$(echo "$body" | jq '.mode = "probe"' 2>/dev/null)
      if [ -n "$probe_body" ]; then
        probe_body_tmp=$(mktemp)
        printf '%s' "$probe_body" > "$probe_body_tmp"
        probe_response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation-local" \
          -H "Content-Type: application/json" -d @"$probe_body_tmp")
        rm -f "$probe_body_tmp"
        log_data "$alloc_id — POST /api/analyze-simulation-local (mode=probe) — response" "$probe_response"
        model_probe_text=$(echo "$probe_response" | jq -r '.result // ""' 2>/dev/null)
      fi

      actual_violations=$(echo "$body" | jq -r '.violations // ""' 2>/dev/null)
      actual_critical=$(echo "$body" | jq -r '.critical // ""' 2>/dev/null)
      actual_max_temp=$(echo "$body" | jq -r '.maxTemp // ""' 2>/dev/null)

      body_tmp=$(mktemp)
      printf '%s' "$body" > "$body_tmp"
      response=$(curl -s --max-time 120 -X POST "$BACKEND_URL/api/analyze-simulation-local" \
        -H "Content-Type: application/json" -d @"$body_tmp")
      rm -f "$body_tmp"
      log_data "$alloc_id — POST /api/analyze-simulation-local — response" "$response"

      if ! echo "$response" | jq -e . >/dev/null 2>&1; then
        log "     ERROR: analyze-simulation-local returned invalid/empty JSON — skipping"
        write_row "$dc" "$alloc_id" "$customer_name" "ERROR: invalid API response" \
          "$actual_violations" "$actual_critical" "$actual_max_temp" "" "" "$model_id" "$model_label" \
          "$model_probe_text" "" "" "" "" "" "" ""
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
          "$model_id" "$model_label" \
          "$model_probe_text" "$err_msg" "" "" "" "" "" ""
      else
        result_summary=$(printf '%s' "$compliance_status" | grep -oiE 'NON-COMPLIANT|CONDITIONAL|COMPLIANT' | head -1)
        [ -z "$result_summary" ] && result_summary="UNKNOWN"

        auto_check "$result_summary" "${section_values[6]}" "$actual_violations" "$actual_critical" "$rack_count"
        if [ -n "$AUTO_IS_CORRECT" ]; then
          log "     result_summary: $result_summary  [$AUTO_COMMENT]"
        else
          log "     result_summary: $result_summary"
        fi

        write_row "$dc" "$alloc_id" "$customer_name" "$result_summary" \
          "$actual_violations" "$actual_critical" "$actual_max_temp" \
          "$AUTO_IS_CORRECT" "$AUTO_COMMENT" "$model_id" "$model_label" "$model_probe_text" "${section_values[@]}"
      fi

      sleep "$SLEEP_BETWEEN"
    done <<< "$alloc_ids"
  done

  log "Done with model $model_id. Results in $CURRENT_OUTFILE, full debug log in $CURRENT_LOGFILE"
done

echo "=== All requested models complete. ==="
