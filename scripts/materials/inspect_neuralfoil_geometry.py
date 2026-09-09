from pathlib import Path
import hashlib
import json

import aerosandbox as asb
import numpy as np

from airfoilfoam.neuralfoil_solver import _distances_to_segments


def inspect_profile(path):
    coordinates = np.asarray([
        [float(value) for value in line.split()]
        for line in path.read_text().splitlines()[1:]
        if len(line.split()) == 2
    ])
    normalized = asb.Airfoil(name=path.stem, coordinates=coordinates).normalize().coordinates
    trials = []
    for spacing in [None, 0.01, 0.005, 0.002]:
        if spacing is None:
            candidate = normalized
        else:
            segments = []
            for start, end in zip(normalized[:-1], normalized[1:]):
                count = max(1, int(np.ceil(np.linalg.norm(end - start) / spacing)))
                segments.extend(start + (end - start) * index / count for index in range(count))
            candidate = np.asarray([*segments, normalized[-1]])
            assert np.max(_distances_to_segments(candidate, normalized)) < 1e-12
            assert all(np.any(np.all(candidate == vertex, axis=1)) for vertex in normalized)
        airfoil = asb.Airfoil(name=path.stem, coordinates=candidate)
        fit = airfoil.to_kulfan_airfoil(n_weights_per_side=8, normalize_coordinates=False)
        approximation = np.asarray(fit.coordinates)
        distances = np.concatenate([
            _distances_to_segments(normalized, approximation),
            _distances_to_segments(approximation, normalized),
        ])
        rms = float(np.sqrt(np.mean(distances ** 2)))
        maximum = float(np.max(distances))
        trials.append({
            "maximum_segment_chord": spacing,
            "points": len(candidate),
            "rms_chord": rms,
            "maximum_chord": maximum,
            "meets_existing_fit_limits": rms <= 0.003 and maximum <= 0.012,
        })
    return {"profile": path.stem, "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "trials": trials}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2] / "packages/db/seed/selig-database"
    for profile in ["ag24", "b707b", "b707c", "cap21c", "e49", "fx79w470a", "hs1430", "r1145msm"]:
        print(json.dumps(inspect_profile(root / f"{profile}.dat"), allow_nan=False), flush=True)
