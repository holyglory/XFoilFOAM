import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


SOURCE_SHA256 = "6030b9120981087e377303e7ac0b75e8ceab9ee7f267c53e76203f861ec5dbb9"


def instrument(source, expected_sha256=SOURCE_SHA256):
    if hashlib.sha256(source.encode()).hexdigest() != expected_sha256:
        raise ValueError("The energy diagnostic requires the exact pinned solver source")
    additions = [
        ('#include "fvcSmooth.H"', '\n#include "energyDiagnostic.H"'),
        ('        volTensorField tauMC("tauMC", muEff*dev2(Foam::T(fvc::grad(U))));',
         '\n        const scalarField diagnosticDensityBefore(rho.primitiveField());'
         '\n        const scalarField diagnosticEnergyBefore(rhoE.primitiveField());'
         '\n        const vectorField diagnosticVelocityBefore(U.primitiveField());'),
        ('        rhoU.boundaryFieldRef() == rho.boundaryField()*U.boundaryField();',
         '\n        const vectorField diagnosticInviscidVelocity(U.primitiveField());'),
        ('        e.correctBoundaryConditions();',
         '\n        reportEnergyBalance(runTime, mesh, diagnosticDensityBefore, diagnosticEnergyBefore,'
         '\n            diagnosticVelocityBefore, diagnosticInviscidVelocity, rho, rhoE, U, e, phi, phiEp, sigmaDotU);'),
    ]
    for anchor, addition in additions:
        if source.count(anchor) != 1:
            raise ValueError("The energy diagnostic insertion point changed")
        source = source.replace(anchor, anchor + addition, 1)
    return source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--header", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    source = (args.source / "rhoCentralFoam.C").read_text()
    instrumented = instrument(source)
    shutil.copytree(args.source, args.destination)
    (args.destination / "rhoCentralFoam.C").write_text(instrumented)
    shutil.copyfile(args.header, args.destination / "energyDiagnostic.H")
    (args.destination / "Make/files").write_text("rhoCentralFoam.C\n\nEXE = $(FOAM_USER_APPBIN)/xfoilfoamEnergyProbe\n")
    subprocess.run(["wmakeLnInclude", str(args.destination / "BCs")], check=True)
    subprocess.run(["wmake", str(args.destination)], check=True)
    report = {"kind": "isolated-observational-energy-probe-v1", "production_evidence": False,
              "source_sha256": SOURCE_SHA256,
              "instrumented_sha256": hashlib.sha256(instrumented.encode()).hexdigest(),
              "header_sha256": hashlib.sha256(args.header.read_bytes()).hexdigest()}
    (args.destination / "source.json").write_text(json.dumps(report, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
