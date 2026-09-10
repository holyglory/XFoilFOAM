import math
import re
from pathlib import Path


NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
CONTINUITY = re.compile(
    rf"^time step continuity errors\s*:\s*sum local\s*=\s*({NUMBER}),\s*global\s*=\s*({NUMBER}),\s*cumulative\s*=\s*({NUMBER})\s*$"
)
PRESSURE_LIMIT = re.compile(rf"^pressureControl:\s*p\s+(min|max)\s+({NUMBER})\s*$")
ITERATION = re.compile(rf"^Time\s*=\s*({NUMBER})\s*$")


def solver_stability(lines, tail_iterations=200):
    if isinstance(tail_iterations, bool) or not isinstance(tail_iterations, int) or tail_iterations < 1:
        raise ValueError("Stability window requires a positive integer")
    history = []
    current = None
    for line in lines:
        line = line.strip()
        coordinate = ITERATION.fullmatch(line)
        if coordinate:
            value = float(coordinate[1])
            if not math.isfinite(value) or value < 0:
                raise ValueError("Invalid solver coordinate")
            if current is not None:
                if value == current["coordinate"]:
                    continue
                if value < current["coordinate"]:
                    history.clear()
                    current = None
            if current is not None:
                history.append(current)
                history = history[-tail_iterations:]
            current = {"coordinate": value, "continuity": [], "limits": set()}
            continue
        if current is None:
            continue
        continuity = CONTINUITY.fullmatch(line)
        if continuity:
            values = tuple(float(continuity[index]) for index in (1, 2, 3))
            if not all(math.isfinite(value) for value in values) or values[0] < 0:
                raise ValueError("Invalid continuity diagnostic")
            current["continuity"].append(values)
        limit = PRESSURE_LIMIT.fullmatch(line)
        if limit:
            if not math.isfinite(float(limit[2])):
                raise ValueError("Invalid pressure-limit diagnostic")
            current["limits"].add(limit[1])
    if current is not None:
        history.append(current)
    history = history[-tail_iterations:]
    if not history:
        return {"available": False, "reason": "no_solver_iterations"}
    continuity = [sample for step in history for sample in step["continuity"]]
    return {
        "available": True,
        "window_iterations": len(history),
        "first_coordinate": history[0]["coordinate"],
        "last_coordinate": history[-1]["coordinate"],
        "pressure_limited_iterations": sum(bool(step["limits"]) for step in history),
        "pressure_min_limited_iterations": sum("min" in step["limits"] for step in history),
        "pressure_max_limited_iterations": sum("max" in step["limits"] for step in history),
        "continuity_samples": len(continuity),
        "last_continuity": None if not continuity else {
            "sum_local": continuity[-1][0], "global": continuity[-1][1], "cumulative": continuity[-1][2],
        },
        "maximum_absolute_global": max((abs(sample[1]) for sample in continuity), default=None),
        "maximum_sum_local": max((sample[0] for sample in continuity), default=None),
        "acceptance_verdict": "not_evaluated",
    }


def retained_solver_stability(directory, tail_iterations=200):
    with (Path(directory) / "log.rhoSimpleFoam").open() as source:
        return solver_stability(source, tail_iterations)


if __name__ == "__main__":
    import json
    import sys

    for directory in sys.argv[1:]:
        print(json.dumps({"source": directory, **retained_solver_stability(directory)}, allow_nan=False))
