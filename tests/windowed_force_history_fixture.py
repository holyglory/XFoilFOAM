import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from airfoilfoam.jobs import _outcome_to_point
from airfoilfoam.models import CaseSpec
from airfoilfoam.pipeline import CaseOutcome
from airfoilfoam.postprocess.unsteady import force_history


def windowed_history_fixture(offset=0.0, alpha=0.0, speed=20.0, chord=1.0):
    transit = chord / speed
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for index in range(801):
        elapsed = index * 0.2 * transit
        phase = 2 * math.pi * 0.1 * elapsed / transit
        lift = 0.5 + alpha * 0.1 + 0.05 * math.sin(phase)
        drag = 0.025 + 0.002 * math.cos(phase)
        moment = -0.03 + 0.001 * math.sin(phase)
        row = [offset + elapsed, drag, 0, 0, lift, 0, 0, moment, 0, 0, 0, 0, 0]
        lines.append(" ".join(f"{value:.17g}" for value in row))
    with TemporaryDirectory() as directory:
        path = Path(directory) / "coefficient.dat"
        path.write_text("\n".join(lines) + "\n")
        history = force_history(path, speed, chord, discard_fraction=0.4, max_points=80)
    outcome = CaseOutcome(
        spec=CaseSpec(chord=chord, speed=speed, aoa_deg=alpha), reynolds=1_000_000,
        force_history=history, unsteady=True, converged=False,
        cl=history.cl_mean, cd=history.cd_mean, cm=history.cm_mean,
    )
    point = _outcome_to_point("isolated-windowed-history", "fixture", outcome)
    return history, point.force_history


if __name__ == "__main__":
    arguments = json.load(sys.stdin)
    _, transported = windowed_history_fixture(**arguments)
    json.dump(transported.model_dump(mode="json", exclude_unset=True), sys.stdout, allow_nan=False)
