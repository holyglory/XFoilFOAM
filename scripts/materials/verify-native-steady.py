import json
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4


directory = Path("/evidence/steady-detector") / str(uuid4())
directory.mkdir(parents=True, exist_ok=False)
cases = []
scenarios = [
    ("stored-stationary", [], [], False),
    ("stored-density", ["-changingField", "rho"], [1], False),
    ("stored-momentum", ["-changingField", "rhoU"], [2], False),
    ("stored-energy", ["-changingField", "rhoE"], [3], False),
    ("stored-turbulence", ["-evolvingTurbulence"], [4, 5], False),
    ("primitive-h-stationary", ["-primitiveFields"], [], False),
    ("primitive-h-density", ["-primitiveFields", "-changingField", "rho"], [1, 2, 3], False),
    ("primitive-h-velocity", ["-primitiveFields", "-changingField", "U"], [2, 3], False),
    ("primitive-h-energy", ["-primitiveFields", "-changingField", "he"], [3], False),
    ("primitive-h-pressure", ["-primitiveFields", "-changingField", "p"], [3], False),
    ("primitive-h-k", ["-primitiveFields", "-changingField", "k"], [4], False),
    ("primitive-h-omega", ["-primitiveFields", "-changingField", "omega"], [5], False),
    ("primitive-e-stationary", ["-primitiveFields", "-internalEnergy"], [], False),
    ("primitive-e-energy", ["-primitiveFields", "-internalEnergy", "-changingField", "he"], [3], False),
    ("invalid-field-mode", ["-invalidFieldMode"], [], True),
    ("invalid-energy-field", ["-primitiveFields", "-invalidEnergyField"], [], True),
]
for name, arguments, changing_channels, invalid in scenarios:
    case = directory / name
    receipt = {"case": name, "outcome": "failed"}
    try:
        shutil.copytree("/fixture/case", case)
        meshed = subprocess.run(["blockMesh", "-case", str(case)], capture_output=True, text=True, timeout=30)
        (case / "log.blockMesh").write_text(meshed.stdout + meshed.stderr)
        meshed.check_returncode()
        command = ["/opt/xfoilfoam-thermophysics/bin/xfoilfoamSteadyProbe", "-case", str(case), *arguments]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        raw = result.stdout + result.stderr
        (case / "log.probe").write_text(raw)
        certificates = [json.loads(line.split(" ", 1)[1]) for line in raw.splitlines() if line.startswith("XFOILFOAM_LOCAL_STEADY_CONVERGED ")]
        if invalid:
            assert result.returncode != 0 and "Invalid conserved-field source" in raw
            assert not certificates
            receipt.update(outcome="passed", invalid_configuration_rejected=True)
        else:
            if result.returncode != 0:
                raise RuntimeError(f"Native probe exited {result.returncode}; see log.probe")
            rows = [line.split()[1:] for line in raw.splitlines() if line.startswith("XFOILFOAM_LOCAL_STEADY_RESIDUAL ")]
            assert len(rows) == 100 and all(len(row) == 6 for row in rows)
            if changing_channels:
                assert all(all(float(row[channel]) > 1e-4 for channel in changing_channels) for row in rows)
            else:
                assert all(all(float(value) == 0 for value in row[1:]) for row in rows)
            assert len(certificates) == (0 if changing_channels else 1)
            if certificates:
                assert certificates[0]["version"] == 2 and certificates[0]["consecutive_steps"] == 100
            receipt.update(outcome="passed", residual_samples=len(rows), certified=bool(certificates))
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    cases.append(receipt)
passed = all(case["outcome"] == "passed" for case in cases)
report = {"kind": "isolated-native-steady-detector-test", "cases": cases, "outcome": "passed" if passed else "failed", "solver_polar_evidence": False}
(directory / "report.json").write_text(json.dumps(report) + "\n")
print(json.dumps({**report, "report": str(directory / "report.json")}), flush=True)
raise SystemExit(0 if passed else 1)
