"""Rare-profile external-flow fallback using OpenFOAM's ``cartesian2DMesh``.

The ordinary production path remains the faster structured C-grid. Some valid
catalog contours, however, are not homeomorphic to a well-behaved transfinite
C-grid passage: a sharp concave notch can invert the structured blocks and an
extremely thick/blunt profile can exceed the non-orthogonality gate even after
the bounded structured ladder is exhausted.

This internal-only fallback writes the exact normalized solver contour as a
two-dimensional FMS surface, adds a boundary-layer collar around the airfoil,
and lets cfMesh generate a conformal hex mesh. It does not smooth, repair, or
otherwise change source coordinates, and it keeps the same far-field extents,
span, first-wall-cell request, and resolution controls as the resolved setup.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

from ..airfoil import Airfoil
from ..models import MeshParams
from ..openfoam.foam_dict import foam_file_header
from ..openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    OpenFOAMError,
    Runner,
)
from .base import BoundaryPatch, Mesher, MeshResult, register_mesher
from .blockmesh import _mesher_infrastructure_reason

CARTESIAN2D_EXTERNAL_MESHER = "cartesian2d-external-boundary-layer"
CARTESIAN2D_SURFACE_FILE = "airfoil-external.fms"
CARTESIAN2D_LAYER_COUNT = 6
CARTESIAN2D_LAYER_EXPANSION = 1.2
CARTESIAN2D_MIN_SURFACE_DIVISIONS = 20
_ASCII_FORMAT_RE = re.compile(r"\bformat\s+ascii\s*;")
_OWNER_OBJECT_RE = re.compile(r"\bobject\s+owner\s*;")
_OWNER_LIST_RE = re.compile(r"(?P<count>\d+)\s*\(\s*(?P<labels>.*?)\s*\)", re.DOTALL)
_OWNER_LABEL_RE = re.compile(r"\d+")


def _fmt(value: float) -> str:
    return f"{float(value):.12g}"


def _owner_cell_count(case_dir: Path) -> int:
    """Read the generated ASCII owner list without requiring a full CFD case.

    ``prepare_mesh`` intentionally creates only the dictionaries required by
    the selected mesher. Running ``checkMesh`` here would therefore classify a
    valid mesh as failed merely because solver dictionaries such as
    ``fvSchemes`` have not been written yet. The pipeline performs the real
    quality gate later in a fully described temporary case.
    """
    owner_path = case_dir / "constant" / "polyMesh" / "owner"
    try:
        owner = owner_path.read_text()
    except OSError as exc:
        raise InfrastructureError(
            "cartesian2DMesh completed without a readable owner list: "
            f"{owner_path}: {exc}"
        ) from exc
    except UnicodeDecodeError as exc:
        raise InfrastructureError(
            "cartesian2DMesh produced a non-text owner list; the engine must "
            "write ASCII polyMesh evidence"
        ) from exc

    object_match = _OWNER_OBJECT_RE.search(owner)
    if object_match is None or _ASCII_FORMAT_RE.search(owner[: object_match.start()]) is None:
        raise InfrastructureError(
            "cartesian2DMesh produced an unsupported owner-list format; "
            "expected an ASCII OpenFOAM labelList"
        )
    list_match = _OWNER_LIST_RE.search(owner, object_match.end())
    if list_match is None:
        raise InfrastructureError(
            "cartesian2DMesh produced an unreadable owner labelList"
        )

    expected_labels = int(list_match.group("count"))
    raw_labels = list_match.group("labels").split()
    if (
        expected_labels <= 0
        or len(raw_labels) != expected_labels
        or any(_OWNER_LABEL_RE.fullmatch(label) is None for label in raw_labels)
    ):
        raise InfrastructureError(
            "cartesian2DMesh produced an inconsistent owner labelList"
        )
    n_cells = max(int(label) for label in raw_labels) + 1
    if n_cells <= 0:
        raise InfrastructureError(
            "cartesian2DMesh produced an owner list without positive cell labels"
        )
    return n_cells


def _side_triangles(
    points: list[tuple[float, float]],
    patch_ids: list[int],
    *,
    point_offset: int,
    top_offset: int,
) -> list[tuple[tuple[int, int, int], int]]:
    if len(points) != len(patch_ids):
        raise ValueError("every FMS boundary edge must have one patch id")
    faces: list[tuple[tuple[int, int, int], int]] = []
    for index, patch_id in enumerate(patch_ids):
        start = point_offset + index
        stop = point_offset + (index + 1) % len(points)
        faces.append(((start, stop, stop + top_offset), patch_id))
        faces.append(((start, stop + top_offset, start + top_offset), patch_id))
    return faces


class Cartesian2DExternalMesh(Mesher):
    """Internal source-preserving fallback for structured-topology exhaustion."""

    name = CARTESIAN2D_EXTERNAL_MESHER
    cache_version = "cfmesh-cartesian2d-external-layers-v1"
    user_selectable = False

    def patches(self, params: MeshParams) -> list[BoundaryPatch]:
        return [
            BoundaryPatch("airfoil", "wall"),
            BoundaryPatch("inlet", "inlet"),
            BoundaryPatch("outlet", "outlet"),
            BoundaryPatch("bottomEmptyFaces", "empty"),
            BoundaryPatch("topEmptyFaces", "empty"),
        ]

    def write_inputs(
        self,
        case_dir: Path,
        airfoil: Airfoil,
        params: MeshParams,
        chord: float,
    ) -> None:
        if not math.isfinite(chord) or chord <= 0:
            raise DeterministicMeshError(
                "cartesian2DMesh requires a finite positive chord"
            )
        if params.first_cell_height_chords is None:
            raise DeterministicMeshError(
                "cartesian2DMesh requires a resolved first-cell height"
            )

        surface_path = case_dir / CARTESIAN2D_SURFACE_FILE
        surface_path.parent.mkdir(parents=True, exist_ok=True)
        surface_path.write_text(self.build_fms(airfoil, params, chord))

        mesh_dict = case_dir / "system" / "meshDict"
        mesh_dict.parent.mkdir(parents=True, exist_ok=True)
        mesh_dict.write_text(self.build_mesh_dict(params, chord))

    def build_mesh_dict(self, params: MeshParams, chord: float) -> str:
        radial_size = params.farfield_radius_chords / max(1, params.n_radial)
        wake_size = params.wake_length_chords / max(1, params.n_wake)
        max_cell_chords = max(1.0 / params.n_surface, min(radial_size, wake_size))
        max_cell_size = chord * max_cell_chords
        surface_cell_size = chord / max(
            CARTESIAN2D_MIN_SURFACE_DIVISIONS,
            params.n_surface,
        )
        first_layer = chord * float(params.first_cell_height_chords)

        return (
            foam_file_header("dictionary", "meshDict", "system")
            + "\n"
            + f'surfaceFile "{CARTESIAN2D_SURFACE_FILE}";\n\n'
            + f"maxCellSize {_fmt(max_cell_size)};\n"
            + f"boundaryCellSize {_fmt(max_cell_size)};\n\n"
            + "localRefinement\n"
            + "{\n"
            + "    airfoil\n"
            + "    {\n"
            + f"        cellSize {_fmt(surface_cell_size)};\n"
            + "    }\n"
            + "}\n\n"
            + "boundaryLayers\n"
            + "{\n"
            + "    patchBoundaryLayers\n"
            + "    {\n"
            + "        airfoil\n"
            + "        {\n"
            + f"            nLayers {CARTESIAN2D_LAYER_COUNT};\n"
            + f"            thicknessRatio {CARTESIAN2D_LAYER_EXPANSION};\n"
            + f"            maxFirstLayerThickness {_fmt(first_layer)};\n"
            + "            allowDiscontinuity 0;\n"
            + "        }\n"
            + "    }\n"
            + "}\n"
        )

    def build_fms(
        self,
        airfoil: Airfoil,
        params: MeshParams,
        chord: float,
    ) -> str:
        contour = np.asarray(airfoil.contour, dtype=float)
        if (
            contour.ndim != 2
            or contour.shape[1] != 2
            or contour.shape[0] < 5
            or not np.isfinite(contour).all()
        ):
            raise DeterministicMeshError(
                "cartesian2DMesh requires a finite closed airfoil contour"
            )

        # Airfoil.from_contour closes both endpoints at the exact same sharp TE.
        # Keep that point once, then reverse the contour so the side triangles'
        # normals point from the fluid into the hole. No coordinate is moved.
        if float(np.linalg.norm(contour[0] - contour[-1])) > 1e-10:
            raise DeterministicMeshError(
                "cartesian2DMesh requires the solver-normalized closed contour"
            )
        airfoil_loop = [
            (float(point[0]), float(point[1]))
            for point in contour[:-1][::-1]
        ]
        radius = float(params.farfield_radius_chords)
        outlet_x = 1.0 + float(params.wake_length_chords)
        outer_loop = [
            (-radius, -radius),
            (outlet_x, -radius),
            (outlet_x, radius),
            (-radius, radius),
        ]

        base_points = [*outer_loop, *airfoil_loop]
        top_offset = len(base_points)
        z_top = float(params.span_chords) * chord
        points = [
            (x * chord, y * chord, 0.0)
            for x, y in base_points
        ] + [
            (x * chord, y * chord, z_top)
            for x, y in base_points
        ]
        faces = _side_triangles(
            outer_loop,
            [0, 1, 0, 0],
            point_offset=0,
            top_offset=top_offset,
        )
        faces.extend(
            _side_triangles(
                airfoil_loop,
                [2] * len(airfoil_loop),
                point_offset=len(outer_loop),
                top_offset=top_offset,
            )
        )

        lines = [
            "3",
            "(",
            "inlet",
            "patch",
            "",
            "outlet",
            "patch",
            "",
            "airfoil",
            "wall",
            ")",
            "",
            str(len(points)),
            "(",
            *(
                f"({_fmt(x)} {_fmt(y)} {_fmt(z)})"
                for x, y, z in points
            ),
            ")",
            "",
            str(len(faces)),
            "(",
            *(
                f"(({a} {b} {c}) {patch_id})"
                for (a, b, c), patch_id in faces
            ),
            ")",
            "",
            "0()",
            "",
            "0",
            "(",
            ")",
            "",
            "0",
            "(",
            ")",
            "",
            "0",
            "(",
            ")",
            "",
        ]
        return "\n".join(lines)

    def run_mesh(
        self,
        case_dir: Path,
        params: MeshParams,
        runner: Runner,
    ) -> MeshResult:
        try:
            result = runner.application(case_dir, "cartesian2DMesh")
        except InfrastructureError:
            raise
        except Exception as exc:  # noqa: BLE001 - launcher/runtime plumbing
            raise InfrastructureError(
                f"cartesian2DMesh could not be launched: {exc}"
            ) from exc

        output = result.stdout or ""
        try:
            (case_dir / "log.cartesian2DMesh").write_text(output)
        except OSError as exc:
            raise InfrastructureError(
                f"cartesian2DMesh output could not be preserved as evidence: {exc}"
            ) from exc

        infrastructure_reason = _mesher_infrastructure_reason(
            result,
            "cartesian2DMesh",
        )
        if infrastructure_reason is not None:
            raise InfrastructureError(infrastructure_reason)
        try:
            result.check()
        except InfrastructureError:
            raise
        except OpenFOAMError as exc:
            raise DeterministicMeshError(
                f"cartesian2DMesh rejected the requested geometry: {exc}"
            ) from exc

        return MeshResult(
            patches=self.patches(params),
            span_chords=params.span_chords,
            n_cells=_owner_cell_count(case_dir),
            log=output,
        )


register_mesher(Cartesian2DExternalMesh())
