"""Batched NeuralFoil priors from stored coordinates, with pinned provenance."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import argparse
from functools import lru_cache
import hashlib
from importlib.metadata import version
import json
from pathlib import Path

import numpy as np


NEURALFOIL_VERSION = "0.3.3"
AEROSANDBOX_VERSION = "4.2.10"
BASELINE_VERSION = "neuralfoil-prior-v1"
MODEL_SIZES = {"xxsmall", "xsmall", "small", "medium", "large", "xlarge", "xxlarge", "xxxlarge"}


@dataclass(frozen=True)
class BaselineCondition:
    target_signature: str
    reynolds: float
    mach: float
    alpha: list[float]
    n_crit: float
    transition_upper: float
    transition_lower: float
    roughness_height: float


@dataclass(frozen=True)
class BaselineRecipe:
    recipe_id: str
    model_size: str
    maximum_geometry_rms: float
    maximum_geometry_error: float


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=8)
def model_provenance(model_size: str) -> dict:
    import neuralfoil

    if version("neuralfoil") != NEURALFOIL_VERSION or version("aerosandbox") != AEROSANDBOX_VERSION:
        raise ValueError("Baseline dependency versions do not match the pinned solver recipe")
    if model_size not in MODEL_SIZES:
        raise ValueError("Unknown NeuralFoil model size")
    root = Path(neuralfoil.__file__).parent
    weights = root / "nn_weights_and_biases" / f"nn-{model_size}.npz"
    distribution = root / "nn_weights_and_biases" / "scaled_input_distribution.npz"
    return {"neuralfoil": NEURALFOIL_VERSION, "aerosandbox": AEROSANDBOX_VERSION,
            "numpy": version("numpy"), "model_size": model_size,
            "weights_sha256": _sha256(weights), "training_distribution_sha256": _sha256(distribution)}


def _distances_to_segments(points: np.ndarray, polyline: np.ndarray) -> np.ndarray:
    starts = polyline[:-1]
    directions = polyline[1:] - starts
    lengths = np.sum(directions ** 2, axis=1)
    valid = lengths > 0
    if not np.any(valid):
        raise ValueError("Degenerate geometry")
    starts, directions, lengths = starts[valid], directions[valid], lengths[valid]
    offsets = points[:, None, :] - starts[None, :, :]
    fractions = np.clip(np.sum(offsets * directions[None, :, :], axis=2) / lengths, 0, 1)
    distances = offsets - fractions[:, :, None] * directions[None, :, :]
    return np.sqrt(np.min(np.sum(distances ** 2, axis=2), axis=1))


def _validate_condition(condition: BaselineCondition) -> None:
    scalars = [condition.reynolds, condition.mach, condition.n_crit,
               condition.transition_upper, condition.transition_lower, condition.roughness_height]
    if not np.all(np.isfinite(scalars)) or not condition.target_signature:
        raise ValueError("A baseline requires finite physical inputs and a target identity")
    if condition.reynolds <= 0 or not 0 <= condition.mach <= 3 or condition.n_crit <= 0:
        raise ValueError("Baseline condition is outside the supported non-reacting-air domain")
    if not 0 <= condition.transition_upper <= 1 or not 0 <= condition.transition_lower <= 1:
        raise ValueError("Transition locations must lie on the airfoil chord")
    if condition.roughness_height != 0:
        raise ValueError("NeuralFoil does not model this rough wall; no compatible baseline is available")
    angles = np.asarray(condition.alpha, dtype=float)
    if (angles.ndim != 1 or len(angles) < 2 or not np.all(np.isfinite(angles))
            or np.any(np.diff(angles) <= 0) or np.any(abs(angles) > 180)):
        raise ValueError("A baseline needs a finite increasing polar angle grid")


def _geometry_fit_errors(reference: np.ndarray, approximation: np.ndarray) -> tuple[float, float]:
    if not np.all(np.isfinite(reference)) or not np.all(np.isfinite(approximation)):
        raise ValueError("NeuralFoil geometry fit is not finite")
    distances = np.concatenate((
        _distances_to_segments(reference, approximation),
        _distances_to_segments(approximation, reference),
    ))
    rms, maximum = float(np.sqrt(np.mean(distances ** 2))), float(np.max(distances))
    if not np.isfinite(rms) or not np.isfinite(maximum):
        raise ValueError("NeuralFoil geometry fit is not finite")
    return rms, maximum


def _neuralfoil_geometry(original, recipe: BaselineRecipe):
    import aerosandbox as asb

    normalized = original.normalize()
    approximation = normalized.to_kulfan_airfoil(n_weights_per_side=8, normalize_coordinates=False)
    native_rms, native_maximum = _geometry_fit_errors(normalized.coordinates, approximation.coordinates)
    if native_rms <= recipe.maximum_geometry_rms and native_maximum <= recipe.maximum_geometry_error:
        return original, {"rms_chord": native_rms, "maximum_chord": native_maximum}
    spacing = 0.01
    counts = np.maximum(1, np.ceil(np.linalg.norm(np.diff(normalized.coordinates, axis=0), axis=1) / spacing).astype(int))
    if int(np.sum(counts)) + 1 > 8192:
        raise ValueError("Stored geometry exceeds the bounded NeuralFoil fit sampling budget")
    segments = []
    for index, count in enumerate(counts):
        start, end = original.coordinates[index:index + 2]
        segments.extend(start + (end - start) * step / count for step in range(count))
    coordinates = np.asarray([*segments, original.coordinates[-1]])
    candidate = asb.Airfoil(name="stored-polyline-fit", coordinates=coordinates)
    candidate_normalized = candidate.normalize()
    approximation = candidate_normalized.to_kulfan_airfoil(n_weights_per_side=8, normalize_coordinates=False)
    rms, maximum = _geometry_fit_errors(normalized.coordinates, approximation.coordinates)
    if rms > recipe.maximum_geometry_rms or maximum > recipe.maximum_geometry_error:
        raise ValueError(f"Stored geometry is not represented accurately enough by NeuralFoil: rms={rms:g}, max={maximum:g}")
    return candidate, {
        "rms_chord": rms, "maximum_chord": maximum,
        "method": "retained-polyline-segment-sampling-v1",
        "maximum_segment_chord": spacing, "fit_point_count": len(coordinates),
        "native_rms_chord": native_rms, "native_maximum_chord": native_maximum,
    }


def solve_baseline(coordinates: list[list[float]], geometry_provenance: dict,
                   conditions: list[BaselineCondition], recipe: BaselineRecipe) -> list[dict]:
    import aerosandbox as asb

    points = np.asarray(coordinates, dtype=float)
    if (points.ndim != 2 or points.shape[1] != 2 or len(points) < 8
            or not np.all(np.isfinite(points)) or not geometry_provenance):
        raise ValueError("Stored airfoil coordinates and provenance are required")
    if np.ptp(points[:, 0]) <= 0 or np.ptp(points[:, 1]) <= 0:
        raise ValueError("Degenerate airfoil geometry")
    if (not recipe.recipe_id or recipe.model_size not in MODEL_SIZES
            or not np.isfinite(recipe.maximum_geometry_rms) or recipe.maximum_geometry_rms <= 0
            or not np.isfinite(recipe.maximum_geometry_error) or recipe.maximum_geometry_error < recipe.maximum_geometry_rms):
        raise ValueError("A baseline requires an explicit geometry-fit recipe")
    if not conditions:
        return []
    for condition in conditions:
        _validate_condition(condition)
    if len({condition.target_signature for condition in conditions}) != len(conditions):
        raise ValueError("Duplicate baseline target")
    provenance = model_provenance(recipe.model_size)
    original = asb.Airfoil(name="stored-coordinate-profile", coordinates=points)
    fitted, geometry_fit = _neuralfoil_geometry(original, recipe)
    lengths = [len(condition.alpha) for condition in conditions]
    angles = np.concatenate([condition.alpha for condition in conditions])
    expanded = lambda name: np.repeat([getattr(condition, name) for condition in conditions], lengths)
    aerodynamic = fitted.get_aero_from_neuralfoil(
        alpha=angles, Re=expanded("reynolds"), mach=expanded("mach"), n_crit=expanded("n_crit"),
        xtr_upper=expanded("transition_upper"), xtr_lower=expanded("transition_lower"), model_size=recipe.model_size,
    )
    coefficients = np.column_stack([np.asarray(aerodynamic[name], dtype=float).reshape(-1) for name in ("CL", "CD", "CM")])
    confidence = np.asarray(aerodynamic["analysis_confidence"], dtype=float).reshape(-1)
    diagnostics = {name: np.asarray(aerodynamic[key], dtype=float).reshape(-1)
                   for name, key in (("cp_min", "Cpmin"), ("critical_mach", "mach_crit"), ("drag_divergence_mach", "mach_dd"))}
    if (coefficients.shape != (len(angles), 3) or confidence.shape != (len(angles),)
            or not np.all(np.isfinite(coefficients)) or not np.all(np.isfinite(confidence))
            or np.any(coefficients[:, 1] <= 0) or np.any(confidence < 0) or np.any(confidence > 1)):
        raise ValueError("NeuralFoil returned an invalid prediction; no substitute values are generated")
    geometry_signature = hashlib.sha256(json.dumps(points.tolist(), separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    predictions = []
    offset = 0
    for condition, length in zip(conditions, lengths):
        payload = {
            "version": BASELINE_VERSION, "kind": "prediction", "method": "neuralfoil",
            "target_signature": condition.target_signature, "condition": asdict(condition),
            "recipe": asdict(recipe), "model": provenance, "geometry_signature": geometry_signature,
            "geometry_provenance": geometry_provenance, "geometry_fit": geometry_fit,
            "alpha": condition.alpha, "coefficients": coefficients[offset:offset + length].tolist(),
            "analysis_confidence": confidence[offset:offset + length].tolist(),
            "compressibility_diagnostics": {
                name: [float(value) if np.isfinite(value) else None for value in values[offset:offset + length]]
                for name, values in diagnostics.items()
            },
            "compressibility_model": "aerosandbox_analytic_extension",
            "uncertainty_calibration": "unvalidated", "cfd_evidence": False,
        }
        payload["prediction_id"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        predictions.append(payload)
        offset += length
    return predictions


def main() -> int:
    from .airfoil import parse_airfoil

    parser = argparse.ArgumentParser(description="Generate preliminary NeuralFoil curves from an existing coordinate file.")
    parser.add_argument("coordinates", type=Path)
    parser.add_argument("--reynolds", type=float, required=True)
    parser.add_argument("--mach", type=float, nargs="+", required=True)
    parser.add_argument("--angles", type=float, nargs="+", required=True)
    parser.add_argument("--transition-upper", type=float, required=True)
    parser.add_argument("--transition-lower", type=float, required=True)
    parser.add_argument("--n-crit", type=float, required=True)
    parser.add_argument("--maximum-geometry-rms", type=float, required=True)
    parser.add_argument("--maximum-geometry-error", type=float, required=True)
    parser.add_argument("--model-size", choices=sorted(MODEL_SIZES), default="large")
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    source = arguments.coordinates.resolve(strict=True)
    if arguments.output.exists():
        raise ValueError("Output exists; choose a new preview artifact")
    source_sha256 = _sha256(source)
    conditions = []
    for mach in arguments.mach:
        target = {"geometry": source_sha256, "reynolds": arguments.reynolds, "mach": mach,
                  "transition_upper": arguments.transition_upper, "transition_lower": arguments.transition_lower,
                  "n_crit": arguments.n_crit, "roughness_height": 0}
        target_signature = hashlib.sha256(json.dumps(target, sort_keys=True).encode()).hexdigest()
        conditions.append(BaselineCondition(
            target_signature, arguments.reynolds, mach, arguments.angles, arguments.n_crit,
            arguments.transition_upper, arguments.transition_lower, 0,
        ))
    recipe = BaselineRecipe("explicit-local-preview", arguments.model_size,
                            arguments.maximum_geometry_rms, arguments.maximum_geometry_error)
    predictions = solve_baseline(
        parse_airfoil(source.read_text()).tolist(),
        {"source_file": str(source), "source_sha256": source_sha256}, conditions, recipe,
    )
    with arguments.output.open("x") as stream:
        json.dump({"purpose": "preliminary_local_inspection", "predictions": predictions}, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"curves": len(predictions), "output": str(arguments.output.resolve()),
                      "kind": "neuralfoil_prediction", "cfd_evidence": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
