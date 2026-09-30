import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def instrument(source, expected_sha256):
    if hashlib.sha256(source.encode()).hexdigest() != expected_sha256:
        raise ValueError("The density diagnostic requires its exact acoustic source")
    anchor = "    if (gMin(forwardDensity) <= 0 || gMin(backwardDensity) <= 0)"
    if source.count(anchor) != 1 or source.count('#include "directionInterpolate.H"') != 1:
        raise ValueError("The acoustic diagnostic insertion points changed")
    return source.replace('#include "directionInterpolate.H"', '#include "directionInterpolate.H"\n#include "densityDiagnostic.H"', 1).replace(
        anchor, "    reportDensityReconstruction(mesh, density, material->p(), material->T(), forwardDensity, backwardDensity);\n" + anchor, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--header", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    original = (args.source / "acousticStartup.C").read_text()
    modified = instrument(original, args.sha256)
    shutil.copytree(args.source, args.destination)
    (args.destination / "acousticStartup.C").write_text(modified)
    shutil.copyfile(args.header, args.destination / "densityDiagnostic.H")
    (args.destination / "Make/files").write_text("acousticStartup.C\n\nEXE = $(FOAM_USER_APPBIN)/xfoilfoamDensityProbe\n")
    subprocess.run(["wmake", str(args.destination)], check=True)
    (args.destination / "source.json").write_text(json.dumps({
        "kind": "observational-acoustic-density-probe-v1", "source_sha256": args.sha256,
        "instrumented_sha256": hashlib.sha256(modified.encode()).hexdigest(),
        "header_sha256": hashlib.sha256(args.header.read_bytes()).hexdigest(), "production_evidence": False,
    }) + "\n")


if __name__ == "__main__":
    main()
