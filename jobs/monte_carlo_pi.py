"""CPU benchmark: estimates pi by Monte Carlo sampling."""

import argparse
import random
import time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=2_000_000)
    args = parser.parse_args()

    start = time.perf_counter()
    inside = sum(1 for _ in range(args.samples) if random.random() ** 2 + random.random() ** 2 <= 1.0)
    estimate = 4 * inside / args.samples
    print(f"pi ~= {estimate:.6f} from {args.samples:,} samples in {time.perf_counter() - start:.2f}s")


if __name__ == "__main__":
    main()
