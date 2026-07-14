#!/usr/bin/env python3
"""
Perception scorer -- Method 2: LLM-as-judge.

Method 1 (score_perception_factual.py) can only check facts reducible to a
regex (counts, temperatures). This asks a judge model to grade the
*qualitative* parts too -- layout description, completeness, whether it
invents things not supported by the real facility data (hallucination).
Costs one extra inference call per (allocation, model) row, and its scores
are the judge's opinion, not ground truth -- treat this as a complement to
Method 1, not a replacement.

Talks DIRECTLY to the judge model's own API (Ollama native /api/chat, or
vLLM's /v1/chat/completions for Cosmos) -- NOT through the backend's
analyze-simulation-local endpoint, so this script needs no backend changes
to use. If the judge host isn't reachable from your machine (e.g. Ollama's
port isn't opened externally), SSH-tunnel it or run this script on the
server itself:
    ssh -L 11434:localhost:11434 user@103.204.95.220

GPU note: same constraint as batch_multi_model.sh -- an Ollama judge can't
run at the same time as vLLM/Cosmos on the deployment box.

Usage:
    JUDGE_BASE_URL=http://103.204.95.220:11434 JUDGE_MODEL=qwen3.6:35b \\
      python3 score_perception_llm_judge.py [results/*.csv ...]

Env vars:
    JUDGE_PROVIDER      ollama | vllm            (default: ollama)
    JUDGE_BASE_URL      default: http://localhost:11434 (ollama) / :8001 (vllm)
    JUDGE_MODEL         default: qwen3.6:35b
    JUDGE_PROMPT_VERSION  default: R1 -- loads judge_prompt_<version>.txt
    LIMIT               cap total graded rows, 0 = no limit (default 0)
    SLEEP_BETWEEN       seconds between judge calls (default 1)
"""
import csv
import glob
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ALLOCATIONS_DIR = os.environ.get(
    "ALLOCATIONS_DIR", os.path.join(SCRIPT_DIR, "..", "..", "allocations")
)
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")

JUDGE_PROVIDER = os.environ.get("JUDGE_PROVIDER", "ollama")
JUDGE_BASE_URL = os.environ.get(
    "JUDGE_BASE_URL", "http://localhost:11434" if JUDGE_PROVIDER == "ollama" else "http://localhost:8001"
)
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "qwen3.6:35b")
JUDGE_PROMPT_VERSION = os.environ.get("JUDGE_PROMPT_VERSION", "R1")
LIMIT = int(os.environ.get("LIMIT", "0"))
SLEEP_BETWEEN = float(os.environ.get("SLEEP_BETWEEN", "1"))

PROMPT_PATH = os.path.join(SCRIPT_DIR, f"judge_prompt_{JUDGE_PROMPT_VERSION}.txt")
with open(PROMPT_PATH, encoding="utf-8") as f:
    JUDGE_PROMPT_TEMPLATE = f.read()


def http_post_json(url, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_judge(prompt):
    if JUDGE_PROVIDER == "ollama":
        payload = {
            "model": JUDGE_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "think": False,
            "stream": False,
        }
        data = http_post_json(f"{JUDGE_BASE_URL}/api/chat", payload)
        return data.get("message", {}).get("content", "")
    else:
        payload = {
            "model": JUDGE_MODEL,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            "max_tokens": 500,
        }
        data = http_post_json(f"{JUDGE_BASE_URL}/v1/chat/completions", payload)
        choices = data.get("choices") or [{}]
        return choices[0].get("message", {}).get("content", "")


def load_ground_truth_text(allocation_id):
    cfg_path = os.path.join(ALLOCATIONS_DIR, allocation_id, "config.json")
    if not os.path.isfile(cfg_path):
        return None
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    rack_count = cfg.get("rack_specs", {}).get("count")
    num_rows = cfg.get("num_rows")
    return f"- {rack_count} racks across {num_rows} rows/aisles\n- customer: {cfg.get('customer_name', 'n/a')}"


def parse_judge_json(text):
    text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def main():
    csv_paths = sys.argv[1:] or glob.glob(os.path.join(RESULTS_DIR, "*.csv"))
    per_row = []
    graded = 0
    limit_hit = False

    for path in csv_paths:
        if limit_hit:
            break
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if "model_probe" not in (reader.fieldnames or []):
                continue
            for row in reader:
                if LIMIT and graded >= LIMIT:
                    limit_hit = True
                    break
                probe_text = row.get("model_probe", "")
                if not probe_text:
                    continue
                gt_text = load_ground_truth_text(row["allocation_id"])
                if gt_text is None:
                    continue

                prompt = JUDGE_PROMPT_TEMPLATE.format(ground_truth=gt_text, candidate_text=probe_text)
                model_label = row.get("model_label") or row.get("model") or "unknown"
                print(f"Judging {row['allocation_id']} / {model_label}...")

                raw, parsed = "", None
                try:
                    raw = call_judge(prompt)
                    parsed = parse_judge_json(raw)
                except Exception as e:
                    print(f"  ERROR calling judge: {e}")

                if parsed is None:
                    print(f"  WARNING: judge response not parseable JSON: {raw[:200]}")
                    per_row.append(
                        {
                            "allocation_id": row["allocation_id"],
                            "model": model_label,
                            "factual_accuracy": "",
                            "completeness": "",
                            "hallucination": "",
                            "justification": "PARSE_ERROR",
                        }
                    )
                else:
                    per_row.append({"allocation_id": row["allocation_id"], "model": model_label, **parsed})

                graded += 1
                time.sleep(SLEEP_BETWEEN)

    os.makedirs(RESULTS_DIR, exist_ok=True)

    out_detail = os.path.join(RESULTS_DIR, "perception_llm_judge_detail.csv")
    with open(out_detail, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["allocation_id", "model", "factual_accuracy", "completeness", "hallucination", "justification"]
        )
        writer.writeheader()
        writer.writerows(per_row)
    print(f"\nWrote per-row detail: {out_detail}")

    per_model = defaultdict(lambda: {"factual_accuracy": [], "completeness": [], "hallucination_count": 0, "n": 0})
    for r in per_row:
        m = per_model[r["model"]]
        m["n"] += 1
        if isinstance(r.get("factual_accuracy"), (int, float)):
            m["factual_accuracy"].append(r["factual_accuracy"])
        if isinstance(r.get("completeness"), (int, float)):
            m["completeness"].append(r["completeness"])
        if r.get("hallucination") is True:
            m["hallucination_count"] += 1

    out_summary = os.path.join(RESULTS_DIR, "perception_llm_judge_summary.csv")
    with open(out_summary, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["model", "n_graded", "avg_factual_accuracy", "avg_completeness", "hallucination_rate"])
        writer.writeheader()
        for model, stats in per_model.items():
            n = stats["n"]
            avg_acc = sum(stats["factual_accuracy"]) / len(stats["factual_accuracy"]) if stats["factual_accuracy"] else ""
            avg_comp = sum(stats["completeness"]) / len(stats["completeness"]) if stats["completeness"] else ""
            hall_rate = stats["hallucination_count"] / n if n else 0
            writer.writerow(
                {
                    "model": model,
                    "n_graded": n,
                    "avg_factual_accuracy": f"{avg_acc:.2f}" if avg_acc != "" else "",
                    "avg_completeness": f"{avg_comp:.2f}" if avg_comp != "" else "",
                    "hallucination_rate": f"{hall_rate:.0%}",
                }
            )
    print(f"Wrote summary: {out_summary}")


if __name__ == "__main__":
    main()
