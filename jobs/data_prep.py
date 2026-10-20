"""Data preparation: builds a synthetic survey dataset and writes summary statistics."""

import argparse
import csv
import os
import random
import statistics
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=100_000)
    args = parser.parse_args()

    out_dir = Path(os.environ.get("HPC_JOB_DIR", "."))
    rows = [
        {"respondent": i, "region": random.choice(["North", "South", "East", "West"]), "score": round(random.gauss(3.6, 0.8), 2)}
        for i in range(args.rows)
    ]
    with open(out_dir / "survey.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["respondent", "region", "score"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {args.rows:,} rows to {out_dir / 'survey.csv'}")
    for region in ["North", "South", "East", "West"]:
        scores = [r["score"] for r in rows if r["region"] == region]
        print(f"{region:<6} n={len(scores):>7,}  mean={statistics.mean(scores):.3f}  sd={statistics.stdev(scores):.3f}")


if __name__ == "__main__":
    main()
