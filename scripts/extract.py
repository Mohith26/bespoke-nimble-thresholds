#!/usr/bin/env python3
"""Build data/decisions.json from public sources (stdlib only).

Inputs (download into CACHE first; see README "Rebuild the data"):
  Bespoke Labs' own Decision Index 0.3 runs, CC BY-NC 4.0
    https://huggingface.co/datasets/bespokelabs/nimble-v4-max-decision-index
    runs/nimble-v4-max/results.jsonl.gz, runs/nimble-v4.1-max/results.jsonl.gz
    runs/<run>/benchmark-summary.json
  The exact raw files the Decision Index kit hashes (decision_index/suite/build/acquire.py):
    banking77/test.csv, banking77/categories.json  (PolyAI task-specific-datasets)
    clinc150/data_full.json                        (clinc/oos-eval)

The join reproduces the published per-benchmark field accuracy of both runs exactly,
and the script refuses to write anything if it does not.
"""
import csv
import gzip
import hashlib
import json
import sys
from pathlib import Path

CACHE = Path(sys.argv[1] if len(sys.argv) > 1 else "cache")
OUT = Path(__file__).resolve().parents[1] / "data" / "decisions.json"

RAW = {
    "banking77/test.csv": "d12d6e3bc4c3103966ae786dc435913c0c563dfa328f5a3646d0e62cfeeb474d",
    "banking77/categories.json": "53261da888122daf2d120d925458631d9619e15d82e56052e7a42e535ce32b63",
    "clinc150/data_full.json": "36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0",
}
MODELS = ["nimble-v4.1-max", "nimble-v4-max"]


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    for rel, want in RAW.items():
        got = sha(CACHE / rel)
        if got != want:
            sys.exit(f"{rel}: sha256 {got} != {want}")

    # Reference labels, built exactly like decision_index/suite/build/normalize_direct.py
    questions = {}
    b_rows = list(csv.DictReader((CACHE / "banking77/test.csv").open(newline="", encoding="utf-8")))
    b_labels = json.loads((CACHE / "banking77/categories.json").read_text())
    questions["BANKING77"] = {
        "id": "banking_intent",
        "track": "BANKING77",
        "options": b_labels,
        "rows": [(f"BANKING77:test:{i}", r["text"], b_labels.index(r["category"])) for i, r in enumerate(b_rows)],
    }
    obj = json.loads((CACHE / "clinc150/data_full.json").read_text())
    c_labels = sorted({p[1] for p in obj["train"]} | {"oos"})
    rows = []
    for split in ("test", "oos_test"):
        for i, (text, label) in enumerate(obj[split]):
            rows.append((f"CLINC150+OOS:{split}:{i}", text, c_labels.index(label)))
    questions["CLINC150+OOS"] = {"id": "assistant_intent", "track": "CLINC150+OOS", "options": c_labels, "rows": rows}

    preds = {m: {} for m in MODELS}
    published = {}
    for m in MODELS:
        summ = json.loads((CACHE / m / "benchmark-summary.json").read_text())
        published[m] = {b["dataset"]: b["detail"]["field_accuracy"] for b in summ["benchmarks"] if b["dataset"] in questions}
        with gzip.open(CACHE / m / "results.jsonl.gz", "rt") as f:
            for line in f:
                if '"track":"BANKING77"' not in line and '"track":"CLINC150+OOS"' not in line:
                    continue
                r = json.loads(line)
                if r["status"] != "ok":
                    continue
                probs = r["response"]["answers"]["q1"]["probabilities"]
                ranked = sorted(probs.items(), key=lambda kv: -kv[1])
                (k1, p1), (k2, p2) = ranked[0], ranked[1]
                preds[m][r["group_id"]] = (int(k1.split("_")[1]), p1, int(k2.split("_")[1]), p2, r["model_request_wall_ms"])

    out = {
        "meta": {
            "description": "Nimble decisions on two human-labeled intent-routing benchmarks, joined to their reference labels.",
            "predictions": "Bespoke Labs, Decision Index 0.3 runs of nimble-v4-max (v4.0) and nimble-v4.1-max, huggingface.co/datasets/bespokelabs/nimble-v4-max-decision-index (CC BY-NC 4.0)",
            "labels": {"BANKING77": "PolyAI BANKING77 test split (CC BY 4.0)", "CLINC150+OOS": "clinc/oos-eval data_full test + oos_test (CC BY 3.0)"},
            "raw_sha256": RAW,
            "score": "probability of Nimble's top choice",
        },
        "questions": [],
    }
    for track, q in questions.items():
        entry = {"id": q["id"], "track": track, "options": q["options"], "ids": [], "text": [], "gold": [], "models": {}}
        for rid, text, g in q["rows"]:
            entry["ids"].append(rid)
            entry["text"].append(text)
            entry["gold"].append(g)
        for m in MODELS:
            c1, p1, c2, p2, ms = [], [], [], [], []
            for rid in entry["ids"]:
                a = preds[m][rid]
                c1.append(a[0]); p1.append(float(f"{a[1]:.9g}")); c2.append(a[2]); p2.append(float(f"{a[3]:.6g}")); ms.append(round(a[4], 1))
            acc = sum(int(c == g) for c, g in zip(c1, entry["gold"])) / len(c1)
            if abs(acc - published[m][track]) > 1e-12:
                sys.exit(f"{m} {track}: joined accuracy {acc} != published {published[m][track]}")
            entry["models"][m] = {"choice": c1, "p": p1, "choice2": c2, "p2": p2, "ms": ms, "published_accuracy": published[m][track]}
            print(f"{m:16s} {track:13s} n={len(c1)} accuracy={acc:.6f} (published {published[m][track]:.6f})")
        out["questions"].append(entry)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print("wrote", OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
