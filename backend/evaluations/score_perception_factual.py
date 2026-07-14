#!/usr/bin/env python3
"""
Perception scorer -- Method 1: fact-grounded (deterministic).

For every (allocation, model) row that has a `model_probe` column, extracts
the concrete facts the model claims about the image (rack count, row/aisle
count, peak temperature) via regex and checks them against the real facility
config (allocations/<id>/config.json) and that row's own `actual_max_temp`
ground truth. No LLM calls, no external dependencies beyond the stdlib --
cheap, deterministic, and fully explainable (you can point at exactly why a
row scored the way it did), which is why this is proposal #1.

Usage:
    python3 score_perception_factual.py [results/*.csv ...]
    (defaults to every CSV in results/ that has a model_probe column)

Env vars:
    ALLOCATIONS_DIR   default: ../../allocations relative to this script
    TEMP_TOLERANCE_C  default: 3.0 -- allowed +/- deg C when matching a
                      temperature the model mentions against actual_max_temp
"""
import csv
import glob
import json
import os
import re
import sys
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ALLOCATIONS_DIR = os.environ.get(
    "ALLOCATIONS_DIR", os.path.join(SCRIPT_DIR, "..", "..", "allocations")
)
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")
TEMP_TOLERANCE_C = float(os.environ.get("TEMP_TOLERANCE_C", "3.0"))

RACK_RE = re.compile(r"(\d+)\s*(?:racks?)\b", re.IGNORECASE)
ROW_RE = re.compile(r"(\d+)\s*(?:rows?|aisles?)\b", re.IGNORECASE)
TEMP_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:\xb0|deg(?:rees)?)?\s*c\b", re.IGNORECASE)


def load_ground_truth(allocation_id):
    cfg_path = os.path.join(ALLOCATIONS_DIR, allocation_id, "config.json")
    if not os.path.isfile(cfg_path):
        return None
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    return {
        "rack_count": cfg.get("rack_specs", {}).get("count"),
        "num_rows": cfg.get("num_rows"),
    }


def first_int(matches):
    return int(matches[0]) if matches else None


def score_row(model_probe_text, ground_truth, actual_max_temp):
    result = {}

    claimed_racks = first_int(RACK_RE.findall(model_probe_text))
    if claimed_racks is None:
        result["rack_count"] = "not_mentioned"
    elif ground_truth.get("rack_count") is None:
        result["rack_count"] = "no_ground_truth"
    elif claimed_racks == ground_truth["rack_count"]:
        result["rack_count"] = "correct"
    else:
        result["rack_count"] = f"incorrect(said {claimed_racks}, actual {ground_truth['rack_count']})"

    claimed_rows = first_int(ROW_RE.findall(model_probe_text))
    if claimed_rows is None:
        result["row_count"] = "not_mentioned"
    elif ground_truth.get("num_rows") is None:
        result["row_count"] = "no_ground_truth"
    elif claimed_rows == ground_truth["num_rows"]:
        result["row_count"] = "correct"
    else:
        result["row_count"] = f"incorrect(said {claimed_rows}, actual {ground_truth['num_rows']})"

    temp_matches = [float(t) for t in TEMP_RE.findall(model_probe_text)]
    if not temp_matches:
        result["temperature"] = "not_mentioned"
    elif actual_max_temp in (None, ""):
        result["temperature"] = "no_ground_truth"
    else:
        actual = float(actual_max_temp)
        if any(abs(t - actual) <= TEMP_TOLERANCE_C for t in temp_matches):
            result["temperature"] = "correct"
        else:
            result["temperature"] = f"incorrect(said {temp_matches}, actual ~{actual:.1f})"

    return result


def bucket_of(verdict):
    return "incorrect" if verdict.startswith("incorrect") else verdict


def main():
    csv_paths = sys.argv[1:] or glob.glob(os.path.join(RESULTS_DIR, "*.csv"))
    per_row = []
    per_model = defaultdict(
        lambda: defaultdict(
            lambda: {"correct": 0, "incorrect": 0, "not_mentioned": 0, "no_ground_truth": 0}
        )
    )

    for path in csv_paths:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if "model_probe" not in (reader.fieldnames or []):
                continue
            for row in reader:
                probe_text = row.get("model_probe", "")
                if not probe_text:
                    continue
                gt = load_ground_truth(row["allocation_id"])
                if gt is None:
                    continue
                scores = score_row(probe_text, gt, row.get("actual_max_temp"))
                model_label = row.get("model_label") or row.get("model") or "unknown"
                per_row.append({"allocation_id": row["allocation_id"], "model": model_label, **scores})
                for fact, verdict in scores.items():
                    per_model[model_label][fact][bucket_of(verdict)] += 1

    os.makedirs(RESULTS_DIR, exist_ok=True)

    out_detail = os.path.join(RESULTS_DIR, "perception_factual_detail.csv")
    with open(out_detail, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["allocation_id", "model", "rack_count", "row_count", "temperature"])
        writer.writeheader()
        writer.writerows(per_row)
    print(f"Wrote per-row detail: {out_detail}\n")

    print(f"{'Model':<20} {'Fact':<12} {'Correct':>8} {'Incorrect':>10} {'NotMentioned':>13}")
    out_summary_rows = []
    for model, facts in per_model.items():
        for fact, counts in facts.items():
            total_scored = counts["correct"] + counts["incorrect"]
            pct = (100 * counts["correct"] / total_scored) if total_scored else None
            pct_str = f"   ({pct:.0f}% correct)" if pct is not None else ""
            print(
                f"{model:<20} {fact:<12} {counts['correct']:>8} {counts['incorrect']:>10} "
                f"{counts['not_mentioned']:>13}{pct_str}"
            )
            out_summary_rows.append(
                {
                    "model": model,
                    "fact": fact,
                    **counts,
                    "pct_correct_of_scored": f"{pct:.1f}" if pct is not None else "",
                }
            )

    out_summary = os.path.join(RESULTS_DIR, "perception_factual_summary.csv")
    with open(out_summary, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["model", "fact", "correct", "incorrect", "not_mentioned", "no_ground_truth", "pct_correct_of_scored"],
        )
        writer.writeheader()
        writer.writerows(out_summary_rows)
    print(f"\nWrote summary: {out_summary}")


if __name__ == "__main__":
    main()
