import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import tempfile

from airfoilfoam.models import CaseSpec
from airfoilfoam.openfoam.runner import InfrastructureError, get_runner
from airfoilfoam.pipeline import _rewrite_carried_inlet_velocity
from airfoilfoam.provenance import installed_application_source_sha256


def main():
    root = Path(tempfile.mkdtemp(prefix="native-boundary-carry-"))
    runner = get_runner()
    records = []
    for index, (inlet, outlet) in enumerate([
        ("freestreamVelocity", "freestreamVelocity"),
        ("freestream", "freestream"),
        ("fixedValue", "inletOutlet"),
        ("fixedValue", "zeroGradient"),
        ("fixedValue", "unrecognizedTestBoundary"),
    ]):
        case_dir = root / str(index)
        donor = case_dir / "donor"
        carried = case_dir / "carried"
        donor.mkdir(parents=True)
        carried.mkdir()
        old_velocity = "uniform (29.9817 1.04698 0)"

        def patch(name, kind):
            entries = [f"type {kind};", f"value {old_velocity};"]
            if kind in {"freestream", "freestreamVelocity"}:
                entries.append(f"freestreamValue {old_velocity};")
            if kind == "inletOutlet":
                entries.append("inletValue uniform (0 0 0);")
            return name + " { " + " ".join(entries) + " }"

        content = "\n".join([
            'FoamFile { version 2.0; format ascii; class volVectorField; object U; }',
            'dimensions [0 1 -1 0 0 0 0];', f'internalField {old_velocity};',
            'boundaryField {', patch("inlet", inlet), patch("outlet", outlet),
            'airfoil { type noSlip; value uniform (0 0 0); }',
            'frontAndBack { type empty; }', '}',
        ]) + "\n"
        original = donor / "U"
        original.write_text(content)
        before = original.read_bytes()
        shutil.copyfile(original, carried / "U")
        if outlet == "unrecognizedTestBoundary":
            try:
                _rewrite_carried_inlet_velocity(case_dir, CaseSpec(chord=1, speed=30, aoa_deg=4), "carried", runner)
            except InfrastructureError:
                assert (carried / "U").read_bytes() == before
                records.append({"inlet": inlet, "outlet": outlet, "refused_without_writes": True})
                continue
            raise AssertionError("Unsupported carried boundaries must refuse a solve")
        _rewrite_carried_inlet_velocity(case_dir, CaseSpec(chord=1, speed=30, aoa_deg=4), "carried", runner)

        def entry(name):
            result = runner.application(case_dir, f"foamDictionary -entry {name} -value carried/U")
            result.check()
            return result.stdout.strip().rstrip(";").strip()

        def components_at(name):
            value = entry(name)
            match = re.fullmatch(r"uniform\s*\(\s*([^()]+)\s*\)", value)
            assert match, value
            components = [float(component) for component in match.group(1).split()]
            assert len(components) == 3 and all(math.isfinite(component) for component in components), value
            return components

        checked = {}
        for name, kind in (("inlet", inlet), ("outlet", outlet)):
            keys = ["value", "freestreamValue"] if kind in {"freestream", "freestreamVelocity"} else ["value"]
            for key in keys:
                value = entry(f"boundaryField.{name}.{key}")
                components = components_at(f"boundaryField.{name}.{key}")
                angle = math.degrees(math.atan2(components[1], components[0]))
                speed = math.sqrt(sum(component * component for component in components))
                assert abs(angle - 4) < 1e-4 and abs(speed - 30) < 1e-4, value
                checked[f"{name}.{key}"] = value
        assert entry("boundaryField.airfoil.type") == "noSlip"
        assert components_at("boundaryField.airfoil.value") == [0, 0, 0]
        assert components_at("internalField") == [29.9817, 1.04698, 0]
        if outlet == "inletOutlet":
            assert components_at("boundaryField.outlet.inletValue") == [0, 0, 0]
        assert original.read_bytes() == before
        records.append({"inlet": inlet, "outlet": outlet, "values": checked,
            "donor_sha256": hashlib.sha256(before).hexdigest(), "donor_unchanged": True,
            "carried_sha256": hashlib.sha256((carried / "U").read_bytes()).hexdigest()})
    print(json.dumps({"kind": "native-boundary-carry-contract", "application_source_sha256": installed_application_source_sha256(),
        "cases": records, "physical_cfd_validated": False, "directory": str(root)}))


if __name__ == "__main__":
    main()
