"""Simulated GPU model training: logs loss per epoch and saves metrics.json."""

import argparse
import json
import math
import os
import random
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--seconds-per-epoch", type=float, default=2.0)
    parser.add_argument("--fail-at", type=int, default=0, help="simulate a crash at this epoch (0 = never)")
    args = parser.parse_args()

    gpus = os.environ.get("CUDA_VISIBLE_DEVICES", "")
    print(f"Job {os.environ.get('HPC_JOB_ID', '?')} on {os.environ.get('HPC_NODE', '?')}, GPUs: {gpus or 'none'}")
    loss, history = 2.5, []
    for epoch in range(1, args.epochs + 1):
        time.sleep(args.seconds_per_epoch)
        if args.fail_at and epoch == args.fail_at:
            print(f"Epoch {epoch}: RuntimeError: CUDA out of memory (simulated)")
            raise SystemExit(1)
        loss *= random.uniform(0.75, 0.92)
        accuracy = 1 - 0.9 * math.exp(-epoch / max(1, args.epochs / 2))
        history.append({"epoch": epoch, "loss": round(loss, 4), "accuracy": round(accuracy, 4)})
        print(f"Epoch {epoch}/{args.epochs}  loss={loss:.4f}  accuracy={accuracy:.3f}")

    out = Path(os.environ.get("HPC_JOB_DIR", ".")) / "metrics.json"
    out.write_text(json.dumps(history, indent=2))
    print(f"Training finished. Metrics saved to {out}")


if __name__ == "__main__":
    main()
