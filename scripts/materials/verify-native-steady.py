import json
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4


directory = Path("/evidence/steady-detector") / str(uuid4())
directory.mkdir(parents=True, exist_ok=False)
cases = []
for evolving in [False, True]:
    case = directory / ("evolving-turbulence" if evolving else "stationary-fields")
    shutil.copytree("/fixture/case", case)
    meshed = subprocess.run(["blockMesh", "-case", str(case)], capture_output=True, text=True, timeout=30)
    (case / "log.blockMesh").write_text(meshed.stdout + meshed.stderr)
    meshed.check_returncode()
    command = ["/opt/xfoilfoam-thermophysics/bin/xfoilfoamSteadyProbe", "-case", str(case)]
    if evolving:
        command.append("-evolvingTurbulence")
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    raw = result.stdout + result.stderr
    (case / "log.probe").write_text(raw)
    if result.returncode != 0:
        raise RuntimeError(f"Native steady probe failed ({result.returncode}): {raw[-3000:]}")
    rows = [line.split()[1:] for line in raw.splitlines() if line.startswith("XFOILFOAM_LOCAL_STEADY_RESIDUAL ")]
    assert len(rows) == 100
    assert all(len(row) == 6 for row in rows)
    if evolving:
        assert all(float(row[4]) > 1e-4 and float(row[5]) > 1e-4 for row in rows)
    else:
        assert all(all(float(value) == 0 for value in row[1:]) for row in rows)
    certificates = [json.loads(line.split(" ", 1)[1]) for line in raw.splitlines() if line.startswith("XFOILFOAM_LOCAL_STEADY_CONVERGED ")]
    assert len(certificates) == (0 if evolving else 1)
    if certificates:
        assert certificates[0]["version"] == 2 and certificates[0]["consecutive_steps"] == 100
    cases.append({"evolving_turbulence": evolving, "residual_samples": len(rows), "certified": bool(certificates)})
report = {"kind": "isolated-native-steady-detector-test", "cases": cases, "outcome": "passed", "solver_polar_evidence": False}
(directory / "report.json").write_text(json.dumps(report) + "\n")
print(json.dumps({**report, "report": str(directory / "report.json")}), flush=True)
