#!/usr/bin/env python3
"""Plot Cl, Cd and Cl/Cd vs angle of attack from a job result.json.

Usage:
    python examples/plot_polar.py path/to/result.json [out.png]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    result = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("polar.png")

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.5))
    for pol in result["polars"]:
        pts = [p for p in pol["points"] if p.get("cl") is not None]
        a = [p["aoa_deg"] for p in pts]
        cl = [p["cl"] for p in pts]
        cd = [p["cd"] for p in pts]
        lod = [p["cl_cd"] for p in pts]
        label = f"U={pol['speed']} m/s, c={pol['chord']} m (Re={pol['reynolds']:.1e})"
        axes[0].plot(a, cl, "o-", label=label)
        axes[1].plot(cd, cl, "o-", label=label)
        axes[2].plot(a, lod, "o-", label=label)

    axes[0].set_xlabel("AoA [deg]"); axes[0].set_ylabel("Cl"); axes[0].set_title("Lift curve")
    axes[1].set_xlabel("Cd"); axes[1].set_ylabel("Cl"); axes[1].set_title("Drag polar")
    axes[2].set_xlabel("AoA [deg]"); axes[2].set_ylabel("Cl/Cd"); axes[2].set_title("L/D")
    for ax in axes:
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
