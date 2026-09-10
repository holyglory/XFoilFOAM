import argparse
import hashlib
import json
from pathlib import Path
import re

from scripts.materials.uiuc_volume1_reference import load_uiuc_volume1_archive, parse_uiuc_volume1
from scripts.materials.validate_polar_uncertainty import write_result


def profile_family(name):
    return re.sub(r"\s*\([A-Z]\)$", "", name.strip()).casefold()


def inventory_archive(path):
    archive = load_uiuc_volume1_archive(path)
    items, excluded = [], []
    for name, raw in sorted(archive["drag"].items()):
        coordinate = name.rsplit(".", 1)[0].lower() + ".dap"
        if coordinate not in archive["coordinates"]:
            excluded.append({"source": name, "reason": "no_exact_as_tested_coordinate_name"})
            continue
        try:
            polar = parse_uiuc_volume1(raw, "drag")
        except ValueError as error:
            excluded.append({"source": name, "reason": "source_format_requires_review", "detail": str(error)})
            continue
        if polar["condition"].casefold() != "clean":
            excluded.append({"source": name, "reason": "not_the_declared_clean_surface", "condition": polar["condition"]})
            continue
        items.append({"source": name, "profile": polar["airfoil"], "family": profile_family(polar["airfoil"]),
                      "coordinates": coordinate, "coordinate_sha256": hashlib.sha256(archive["coordinates"][coordinate]).hexdigest(),
                      "source_sha256": polar["source_sha256"], "runs": len(polar["runs"]),
                      "samples": sum(run["samples"] for run in polar["runs"]),
                      "reynolds": sorted({run["reynolds"] for run in polar["runs"]})})
    return {"kind": "uiuc-reference-availability-not-performance", "archive_sha256": archive["archive_sha256"], "attribution": archive["attribution"],
            "profiles": len(items), "profile_families": len({item["family"] for item in items}),
            "runs": sum(item["runs"] for item in items), "samples": sum(item["samples"] for item in items), "items": items, "excluded": excluded}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = inventory_archive(args.archive)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    signature = write_result(args.output, result)
    print(json.dumps({**{key: result[key] for key in ("kind", "profiles", "profile_families", "runs", "samples", "excluded")}, "output_sha256": signature}))
