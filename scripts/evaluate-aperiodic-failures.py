#!/usr/bin/env python3
"""Evaluate JSONL rejected FAST-URANS evidence without changing any state."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from airfoilfoam.aperiodic_evaluator import evaluate_json_lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="-", help="JSONL path or - for stdin")
    parser.add_argument("--output", default="-", help="evaluation JSONL path or -")
    parser.add_argument("--summary", required=True, help="summary JSON path")
    args = parser.parse_args()

    if args.input == "-":
        lines = sys.stdin
    else:
        lines = Path(args.input).open("r", encoding="utf-8")
    try:
        evaluations, summary = evaluate_json_lines(lines)
    finally:
        if args.input != "-":
            lines.close()

    if args.output == "-":
        for evaluation in evaluations:
            print(json.dumps(evaluation, allow_nan=False, sort_keys=True))
    else:
        with Path(args.output).open("w", encoding="utf-8") as output:
            for evaluation in evaluations:
                output.write(json.dumps(evaluation, allow_nan=False, sort_keys=True))
                output.write("\n")
    Path(args.summary).write_text(
        json.dumps(summary, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
