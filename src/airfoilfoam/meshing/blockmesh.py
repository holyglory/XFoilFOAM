"""A parametric structured C-grid generated with OpenFOAM's ``blockMesh``.

Topology (unit-chord, scaled to metres via ``convertToMeters``):

    leading edge at (0,0), trailing edge at (1,0); outer C-boundary is a circle
    of radius R about the LE, opening downstream to an outlet at x = 1 + wake.

The public/default implementation is the established four-block topology:
upper-around, lower-around, upper-wake, and lower-wake.  Segmented, wall-normal
variants are registered under internal names and are used only by the bounded
mesh-recovery ladder after real quality evidence rejects the default.  Keeping
the strategies distinct prevents a topology experiment from silently changing
all catalog meshes or colliding with a legacy mesh/seed cache entry.

The trailing edge is closed (sharp) and the wake cut between the two wake blocks
is stitched into internal faces with ``mergePatchPairs``.  The outer boundary is
split into an ``inlet`` (front arcs + top + bottom) and a downstream ``outlet``
(a fixed-pressure reference); the same mesh serves every angle of attack because
AoA is applied by rotating the freestream velocity, not the mesh.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

from ..airfoil import Airfoil
from ..models import MeshParams
from ..openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    OpenFOAMError,
    RunResult,
    Runner,
)
from .base import BoundaryPatch, MeshResult, Mesher, register_mesher

# Streamwise clustering / wake growth (fixed, sensible defaults).
SURFACE_GRADING_RATIO = 6.0  # legacy cell-size ratio mid/end on each surface
WAKE_EXPANSION = 50.0  # last/first cell ratio along the wake

# A single transfinite block from TE to LE folds near the nose of sufficiently
# cambered real airfoils even when blockMesh accepts it. Production 20-32C was
# the must-catch case: both 7,600- and 30,400-cell variants contained negative
# volume cells and had 93--95 degree non-orthogonality. Segmenting each curved
# passage bounds the interpolation span while preserving the exact requested
# cell count and the shared C-grid topology. MeshParams.n_surface is >= 20, so
# every segment owns at least one real streamwise cell.
SURFACE_BLOCK_SEGMENTS = 20
SEGMENTED_NORMAL_COUNTS = (20, 24, 29, 32)
LEGACY_TOPOLOGY = "legacy"
SEGMENTED_NORMAL_TOPOLOGY = "segmented-normal"
_SEGMENTED_PREFLIGHT_EPSILON = 1e-10
_PROCESS_KILL_RETURN_CODES = frozenset({137, 143, -9, -15})
_LAUNCH_FAILURE_RETURN_CODES = frozenset({125, 126, 127})
_OOM_OUTPUT_RE = re.compile(
    r"(?:out of memory|oom[-_ ]kill|killed process|cannot allocate memory)",
    re.IGNORECASE,
)


def _blockmesh_infrastructure_reason(result: RunResult) -> str | None:
    """Return a structured execution failure that must not repair geometry.

    ``blockMesh`` uses ordinary non-zero exits for deterministic dictionary or
    topology rejection, so those remain eligible for the recovery ladder. A
    timeout, process signal, container kill, or explicit OOM record instead
    proves only that the execution environment failed; classifying it as a
    geometry verdict would make every recovery candidate repeat the same
    infrastructure incident and eventually mislabel the airfoil as blocked.
    """

    returncode = int(getattr(result, "returncode", 0) or 0)
    if bool(getattr(result, "timed_out", False)) or returncode == 124:
        return "blockMesh timed out before producing a trustworthy mesh verdict"
    if returncode in _PROCESS_KILL_RETURN_CODES:
        return (
            "blockMesh was terminated by the execution environment "
            f"(return code {returncode})"
        )
    if returncode in _LAUNCH_FAILURE_RETURN_CODES:
        return (
            "blockMesh was unavailable in the execution environment "
            f"(return code {returncode})"
        )
    output = str(getattr(result, "stdout", "") or "")
    if returncode != 0 and _OOM_OUTPUT_RE.search(output):
        return (
            "blockMesh stopped because the execution environment reported an "
            f"out-of-memory/process-kill condition (return code {returncode})"
        )
    return None


def solve_expansion(first_cell: float, length: float, n: int) -> float:
    """Return blockMesh expansion ratio (last/first cell) for a geometric edge.

    Solves ``first_cell * (r**n - 1)/(r - 1) = length`` for the per-cell ratio r
    and returns ``r**(n-1)`` (the value blockMesh expects).
    """
    if n <= 1:
        return 1.0
    target = length / first_cell

    def total(r: float) -> float:
        if abs(r - 1.0) < 1e-12:
            return n
        return (r**n - 1.0) / (r - 1.0)

    # Uniform spacing already overshoots -> cells must shrink (r < 1); else grow.
    if total(1.0) > target:
        lo, hi = 0.3, 1.0
    else:
        lo, hi = 1.0, 1.05
        while total(hi) < target and hi < 100.0:
            hi *= 1.2
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if total(mid) < target:
            lo = mid
        else:
            hi = mid
    r = 0.5 * (lo + hi)
    return r ** (n - 1)


def _signed_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return 0.5 * a


def _normal_aligned_outer_angles(
    surface_path: np.ndarray,
    cuts: list[int],
    start_angle: float,
    end_angle: float,
) -> list[float]:
    """Map surface-block interfaces to a monotone outer-circle angle.

    A linear 90-degree outer-arc mapping ignores the direction of the curved
    wall at each interface. That makes long radial faces cut obliquely across
    the transfinite passage near highly cambered noses. We instead follow the
    local outward wall normal, then distribute the endpoint correction so the
    C-grid still joins the wake at +/-90 degrees and both passages share the
    exact upstream vertex at 180 degrees.

    The forced sharp trailing-edge coordinate makes its one-sided tangent a
    poor normal estimate, so the first/last normal borrow the nearest interior
    estimate. A small monotone projection prevents crossed radial interfaces
    without erasing the measured interior-normal mapping.
    """
    if len(cuts) < 2:
        return [float(start_angle), float(end_angle)]
    raw: list[float] = []
    last = len(surface_path) - 1
    for index in cuts:
        index = min(max(int(index), 0), last)
        before = surface_path[max(0, index - 1)]
        after = surface_path[min(last, index + 1)]
        tangent = after - before
        # Both directed paths follow the airfoil contour TE-upper -> LE ->
        # TE-lower, so a clockwise rotation is outward into the fluid.
        outward = np.asarray((tangent[1], -tangent[0]), dtype=float)
        if float(np.linalg.norm(outward)) <= 1e-14:
            raw.append(raw[-1] if raw else start_angle)
        else:
            raw.append(math.atan2(float(outward[1]), float(outward[0])))

    angles = np.unwrap(np.asarray(raw, dtype=float))
    target_mid = 0.5 * (start_angle + end_angle)
    angles += 2.0 * math.pi * round((target_mid - float(np.mean(angles))) / (2.0 * math.pi))
    if len(angles) > 2:
        angles[0] = angles[1]
        angles[-1] = angles[-2]
    angles += np.linspace(start_angle - angles[0], end_angle - angles[-1], len(angles))

    # Preserve strict topology order with a deliberately tiny separation. The
    # CFD spacing remains normal-driven; this projection only resolves local
    # reversals caused by noisy real coordinate tangents.
    min_step = (end_angle - start_angle) / max(1, 20 * (len(angles) - 1))
    angles[0] = start_angle
    angles[-1] = end_angle
    for i in range(1, len(angles) - 1):
        angles[i] = max(angles[i], angles[i - 1] + min_step)
    for i in range(len(angles) - 2, 0, -1):
        angles[i] = min(angles[i], angles[i + 1] - min_step)
    angles[0] = start_angle
    angles[-1] = end_angle
    return [float(angle) for angle in angles]


def _bilinear_corner_jacobians(quad: list[np.ndarray]) -> tuple[float, float, float, float]:
    """Return the four 2-D Jacobians of a bilinear quad mapping.

    ``blockMesh`` can accept a positive signed-area block whose mapping still
    folds at one corner.  The historical duplicated-wrap e850 source and the
    authoritative open ua79sfm component demonstrated that signed area alone
    is therefore not an adequate topology preflight.  Corrected e850 geometry
    passes this preflight and real checkMesh; source repair must update the
    evidence expectation rather than preserving a stale rejection.
    A bilinear quad's Jacobian is affine, so same-sign, non-zero values at all
    four corners are the exact straight-edge convexity condition.
    """

    p00, p10, p11, p01 = quad

    def cross(a: np.ndarray, b: np.ndarray) -> float:
        return float(a[0] * b[1] - a[1] * b[0])

    values: list[float] = []
    for u, v in ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)):
        du = (1.0 - v) * (p10 - p00) + v * (p11 - p01)
        dv = (1.0 - u) * (p01 - p00) + u * (p11 - p10)
        values.append(cross(du, dv))
    return values[0], values[1], values[2], values[3]


def _preflight_segmented_passage(
    surface_path: np.ndarray,
    cuts: list[int],
    outer_angles: list[float],
    radius: float,
    *,
    passage: str,
) -> None:
    """Reject a folded segmented passage before emitting/running blockMesh.

    This is a candidate-quality verdict, not a geometry repair.  No points,
    cell counts, or quality thresholds are changed.  The recovery ladder may
    try another explicitly fingerprinted topology; malformed source contours
    eventually remain rejected instead of being coerced into plausible-looking
    geometry.
    """

    if len(outer_angles) != len(cuts):
        raise DeterministicMeshError(
            f"segmented topology preflight failed for {passage}: "
            "outer-interface count does not match surface cuts"
        )
    if any(b <= a for a, b in zip(outer_angles, outer_angles[1:])):
        raise DeterministicMeshError(
            f"segmented topology preflight failed for {passage}: "
            "outer interfaces are not strictly ordered"
        )

    outer = [
        np.asarray((radius * math.cos(angle), radius * math.sin(angle)), dtype=float)
        for angle in outer_angles
    ]
    for segment, (start, stop) in enumerate(zip(cuts, cuts[1:])):
        quad = [
            np.asarray(surface_path[start], dtype=float),
            outer[segment],
            outer[segment + 1],
            np.asarray(surface_path[stop], dtype=float),
        ]
        area = _signed_area([(float(p[0]), float(p[1])) for p in quad])
        orientation = 1.0 if area > 0.0 else -1.0
        jacobians = _bilinear_corner_jacobians(quad)
        oriented = tuple(orientation * value for value in jacobians)
        if (
            abs(area) <= _SEGMENTED_PREFLIGHT_EPSILON
            or min(oriented) <= _SEGMENTED_PREFLIGHT_EPSILON
        ):
            formatted = ", ".join(f"{value:.6g}" for value in jacobians)
            raise DeterministicMeshError(
                f"segmented topology preflight failed for {passage} segment {segment}: "
                f"non-convex/folded bilinear block (corner Jacobians {formatted})"
            )


class BlockMeshCGrid(Mesher):
    name = "blockmesh-cgrid"
    cache_version = "legacy-four-block-v1"

    def __init__(
        self,
        *,
        topology: str = LEGACY_TOPOLOGY,
        surface_segments: int | None = None,
    ) -> None:
        if topology not in {LEGACY_TOPOLOGY, SEGMENTED_NORMAL_TOPOLOGY}:
            raise ValueError(f"unknown blockMesh C-grid topology {topology!r}")
        if topology == LEGACY_TOPOLOGY:
            if surface_segments is not None:
                raise ValueError("legacy blockMesh C-grid does not accept surface_segments")
            self.name = "blockmesh-cgrid"
            self.cache_version = "legacy-four-block-v1"
            self.surface_segments = None
            self.user_selectable = True
        else:
            if surface_segments not in SEGMENTED_NORMAL_COUNTS:
                raise ValueError(
                    "segmented-normal surface_segments must be one of "
                    f"{SEGMENTED_NORMAL_COUNTS}, got {surface_segments!r}"
                )
            self.name = f"blockmesh-cgrid-segmented-normal-{surface_segments}"
            self.cache_version = f"segmented-normal-{surface_segments}-v1"
            self.surface_segments = int(surface_segments)
            self.user_selectable = False
        self.topology = topology

    @classmethod
    def segmented_normal(cls, surface_segments: int = SURFACE_BLOCK_SEGMENTS) -> "BlockMeshCGrid":
        return cls(topology=SEGMENTED_NORMAL_TOPOLOGY, surface_segments=surface_segments)

    # -- public API --------------------------------------------------------- #
    def patches(self, params: MeshParams) -> list[BoundaryPatch]:
        return [
            BoundaryPatch("airfoil", "wall"),
            BoundaryPatch("inlet", "inlet"),
            BoundaryPatch("outlet", "outlet"),
            BoundaryPatch("frontAndBack", "empty"),
        ]

    def write_inputs(self, case_dir: Path, airfoil: Airfoil, params: MeshParams, chord: float) -> None:
        text = self.build_dict(airfoil, params, chord)
        path = case_dir / "system" / "blockMeshDict"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_mesh(self, case_dir: Path, params: MeshParams, runner: Runner) -> MeshResult:
        try:
            res = runner.application(case_dir, "blockMesh")
        except InfrastructureError:
            raise
        except Exception as exc:  # noqa: BLE001 - launcher/runtime plumbing
            raise InfrastructureError(f"blockMesh could not be launched: {exc}") from exc

        try:
            (case_dir / "log.blockMesh").write_text(res.stdout or "")
        except OSError as exc:
            raise InfrastructureError(
                f"blockMesh output could not be preserved as evidence: {exc}"
            ) from exc

        infrastructure_reason = _blockmesh_infrastructure_reason(res)
        if infrastructure_reason is not None:
            raise InfrastructureError(infrastructure_reason)

        try:
            res.check()
        except InfrastructureError:
            raise
        except OpenFOAMError as exc:
            raise DeterministicMeshError(f"blockMesh rejected the requested geometry: {exc}") from exc
        n_cells = self.cell_count(params)
        m = re.search(r"nCells:\s*(\d+)", res.stdout)
        if m:
            n_cells = int(m.group(1))
        return MeshResult(
            patches=self.patches(params),
            span_chords=params.span_chords,
            n_cells=n_cells,
            log=res.stdout,
        )

    def cell_count(self, params: MeshParams) -> int:
        return 2 * params.n_surface * params.n_radial + 2 * params.n_wake * params.n_radial

    # -- dictionary generation --------------------------------------------- #
    def build_dict(self, airfoil: Airfoil, params: MeshParams, chord: float) -> str:
        if self.topology == LEGACY_TOPOLOGY:
            return self._build_legacy_dict(airfoil, params, chord)
        return self._build_segmented_dict(airfoil, params, chord)

    def _build_legacy_dict(self, airfoil: Airfoil, params: MeshParams, chord: float) -> str:
        """Emit the established four-block C-grid unchanged.

        This remains the fast public/default strategy.  Recovery candidates are
        separate registered meshers and are selected only after typed quality
        evidence rejects this topology.
        """

        R = params.farfield_radius_chords
        Xo = 1.0 + params.wake_length_chords
        span = params.span_chords
        n_surf = params.n_surface
        n_rad = params.n_radial
        n_wake = params.n_wake
        rad_grading = solve_expansion(params.first_cell_height_chords, R, n_rad)
        surf_grading = (
            f"( (0.5 0.5 {SURFACE_GRADING_RATIO}) "
            f"(0.5 0.5 {1.0 / SURFACE_GRADING_RATIO}) )"
        )
        wake_grading = f"{WAKE_EXPANSION}"

        base = [
            (1.0, 0.0),
            (0.0, 0.0),
            (1.0, 0.0),
            (0.0, R),
            (-R, 0.0),
            (0.0, -R),
            (Xo, R),
            (Xo, 0.0),
            (Xo, 0.0),
            (Xo, -R),
        ]
        vert_lines = [
            f"    ({x:.10g} {y:.10g} {z:.10g})"
            for z in (0.0, span)
            for x, y in base
        ]

        upper, lower = airfoil.resampled_surfaces(n_surf)
        upper_te_to_le = upper[::-1][1:-1]
        lower_le_to_te = lower[1:-1]

        def spline(v0: int, v1: int, pts: np.ndarray, z: float) -> str:
            body = " ".join(f"({p[0]:.8g} {p[1]:.8g} {z:.8g})" for p in pts)
            return f"    spline {v0} {v1} ( {body} )"

        s = 1.0 / math.sqrt(2.0)
        edge_lines = [
            spline(0, 1, upper_te_to_le, 0.0),
            spline(1, 2, lower_le_to_te, 0.0),
            spline(10, 11, upper_te_to_le, span),
            spline(11, 12, lower_le_to_te, span),
            f"    arc 3 4 ({-R * s:.8g} {R * s:.8g} 0)",
            f"    arc 4 5 ({-R * s:.8g} {-R * s:.8g} 0)",
            f"    arc 13 14 ({-R * s:.8g} {R * s:.8g} {span:.8g})",
            f"    arc 14 15 ({-R * s:.8g} {-R * s:.8g} {span:.8g})",
        ]

        rg = f"{rad_grading:.8g}"
        blocks = [
            ("UA", n_surf, surf_grading, {(0, 0): 0, (1, 0): 3, (0, 1): 1, (1, 1): 4}),
            ("LA", n_surf, surf_grading, {(0, 0): 1, (1, 0): 4, (0, 1): 2, (1, 1): 5}),
            ("UW", n_wake, wake_grading, {(0, 0): 0, (1, 0): 3, (0, 1): 7, (1, 1): 6}),
            ("LW", n_wake, wake_grading, {(0, 0): 2, (1, 0): 5, (0, 1): 8, (1, 1): 9}),
        ]
        block_lines = []
        for name, n_stream, stream_grading, corners in blocks:
            coord = {key: base[vertex] for key, vertex in corners.items()}
            a_order = [(0, 0), (1, 0), (1, 1), (0, 1)]
            radial_is_i = _signed_area([coord[key] for key in a_order]) > 0
            if radial_is_i:
                quad = [corners[key] for key in a_order]
                divisions = (n_rad, n_stream, 1)
            else:
                b_order = [(0, 0), (0, 1), (1, 1), (1, 0)]
                quad = [corners[key] for key in b_order]
                divisions = (n_stream, n_rad, 1)
            top = [vertex + 10 for vertex in quad]
            vertices = " ".join(str(vertex) for vertex in quad + top)
            grading = (
                (rg, stream_grading, "1")
                if radial_is_i
                else (stream_grading, rg, "1")
            )
            block_lines.append(
                f"    hex ({vertices}) ({divisions[0]} {divisions[1]} {divisions[2]}) "
                f"simpleGrading ({grading[0]} {grading[1]} {grading[2]})  // {name}"
            )

        def face(v0: int, v1: int) -> str:
            return f"            ({v0} {v1} {v1 + 10} {v0 + 10})"

        boundary = self._boundary_block(
            [face(0, 1), face(1, 2)],
            [face(3, 4), face(4, 5), face(3, 6), face(5, 9)],
            [face(7, 6), face(8, 9)],
            [
                "            (0 3 4 1)",
                "            (1 4 5 2)",
                "            (0 3 6 7)",
                "            (2 5 9 8)",
                "            (10 13 14 11)",
                "            (11 14 15 12)",
                "            (10 13 16 17)",
                "            (12 15 19 18)",
            ],
            [face(0, 7)],
            [face(2, 8)],
        )
        return self._assemble(chord, vert_lines, edge_lines, block_lines, boundary)

    def _build_segmented_dict(self, airfoil: Airfoil, params: MeshParams, chord: float) -> str:
        R = params.farfield_radius_chords
        Xo = 1.0 + params.wake_length_chords
        span = params.span_chords
        n_surf = params.n_surface
        n_rad = params.n_radial
        n_wake = params.n_wake

        rad_grading = solve_expansion(params.first_cell_height_chords, R, n_rad)
        wake_grading = f"{WAKE_EXPANSION}"

        # --- segmented surface paths -------------------------------------- #
        # Split on the existing cosine-resampled indices. The per-segment cell
        # count is therefore the number of original intervals in that slice;
        # no cells or measured geometry are invented by the topology repair.
        if self.surface_segments is None:  # constructor invariant; helps type checkers
            raise RuntimeError("segmented topology has no configured surface segment count")
        n_segments = min(self.surface_segments, n_surf)
        cuts = [round(i * n_surf / n_segments) for i in range(n_segments + 1)]
        first, second = airfoil.resampled_surfaces(n_surf)  # LE -> TE each
        # Source databases do not consistently wind TE->upper->LE->lower->TE.
        # Assigning the geometrically higher passage to the upper far field is
        # topology interpretation only: it does not alter a coordinate.
        upper, lower = (
            (first, second)
            if float(np.mean(first[:, 1])) >= float(np.mean(second[:, 1]))
            else (second, first)
        )
        upper_path = upper[::-1]  # TE -> LE
        lower_path = lower  # LE -> TE
        upper_outer_angles = _normal_aligned_outer_angles(
            upper_path, cuts, math.pi / 2, math.pi
        )
        lower_outer_angles = _normal_aligned_outer_angles(
            lower_path, cuts, math.pi, 3 * math.pi / 2
        )
        _preflight_segmented_passage(
            upper_path,
            cuts,
            upper_outer_angles,
            R,
            passage="upper",
        )
        _preflight_segmented_passage(
            lower_path,
            cuts,
            lower_outer_angles,
            R,
            passage="lower",
        )

        # A dynamic vertex table lets adjacent surface blocks share their
        # radial interface exactly. The sharp TE remains duplicated above and
        # below so the wake cut can still be merged after block construction.
        base: list[tuple[float, float]] = []

        def add(point: tuple[float, float] | np.ndarray) -> int:
            idx = len(base)
            base.append((float(point[0]), float(point[1])))
            return idx

        upper_inner = [add(upper_path[index]) for index in cuts]
        upper_outer = [
            add((R * math.cos(angle), R * math.sin(angle)))
            for angle in upper_outer_angles
        ]
        # LE and inlet-front vertices are shared between the two passages.
        lower_inner = [upper_inner[-1]] + [add(lower_path[index]) for index in cuts[1:]]
        lower_outer = [upper_outer[-1]] + [
            add((R * math.cos(angle), R * math.sin(angle)))
            for angle in lower_outer_angles[1:]
        ]
        outlet_top = add((Xo, R))
        outlet_wake_top = add((Xo, 0.0))
        outlet_wake_bottom = add((Xo, 0.0))
        outlet_bottom = add((Xo, -R))

        # --- vertices (z=0 then z=span) ------------------------------------ #
        vert_lines = []
        for z in (0.0, span):
            for (x, y) in base:
                vert_lines.append(f"    ({x:.10g} {y:.10g} {z:.10g})")

        # --- edges (short airfoil splines + inlet arcs) -------------------- #
        z_offset = len(base)

        def spline(v0: int, v1: int, pts: np.ndarray, z: float) -> str | None:
            if len(pts) == 0:
                return None  # one-cell segment: the endpoints define the edge
            body = " ".join(f"({p[0]:.8g} {p[1]:.8g} {z:.8g})" for p in pts)
            return f"    spline {v0} {v1} ( {body} )"

        edge_lines: list[str] = []
        for path, inner, outer, outer_angles in (
            (upper_path, upper_inner, upper_outer, upper_outer_angles),
            (lower_path, lower_inner, lower_outer, lower_outer_angles),
        ):
            for j in range(n_segments):
                surface_points = path[cuts[j] + 1 : cuts[j + 1]]
                for z, offset in ((0.0, 0), (span, z_offset)):
                    line = spline(
                        inner[j] + offset,
                        inner[j + 1] + offset,
                        surface_points,
                        z,
                    )
                    if line is not None:
                        edge_lines.append(line)
                    mid_theta = 0.5 * (outer_angles[j] + outer_angles[j + 1])
                    edge_lines.append(
                        f"    arc {outer[j] + offset} {outer[j + 1] + offset} "
                        f"({R * math.cos(mid_theta):.8g} {R * math.sin(mid_theta):.8g} {z:.8g})"
                    )

        # --- blocks -------------------------------------------------------- #
        # Each block has corners keyed by radial r (0=wall, 1=far) and local
        # streamwise s. Short blocks use uniform local stream grading; the
        # cosine-spaced cut locations preserve LE/TE clustering globally.
        rg = f"{rad_grading:.8g}"  # radial grading (fine at wall / wake-cut TE end)
        blocks: list[tuple[str, int, str, dict[tuple[int, int], int]]] = []
        for prefix, inner, outer in (
            ("UA", upper_inner, upper_outer),
            ("LA", lower_inner, lower_outer),
        ):
            for j in range(n_segments):
                blocks.append(
                    (
                        f"{prefix}{j:02d}",
                        cuts[j + 1] - cuts[j],
                        "1",
                        {
                            (0, 0): inner[j],
                            (1, 0): outer[j],
                            (0, 1): inner[j + 1],
                            (1, 1): outer[j + 1],
                        },
                    )
                )
        blocks.extend(
            [
                (
                    "UW",
                    n_wake,
                    wake_grading,
                    {
                        (0, 0): upper_inner[0],
                        (1, 0): upper_outer[0],
                        (0, 1): outlet_wake_top,
                        (1, 1): outlet_top,
                    },
                ),
                (
                    "LW",
                    n_wake,
                    wake_grading,
                    {
                        (0, 0): lower_inner[-1],
                        (1, 0): lower_outer[-1],
                        (0, 1): outlet_wake_bottom,
                        (1, 1): outlet_bottom,
                    },
                ),
            ]
        )
        block_lines = []
        block_quads: list[list[int]] = []
        for name, n_stream, stream_grading, c in blocks:
            coord = {k: base[v] for k, v in c.items()}
            # Mapping A: i = radial (wall->far), j = streamwise (s0->s1)
            a_order = [(0, 0), (1, 0), (1, 1), (0, 1)]
            area = _signed_area([coord[k] for k in a_order])
            radial_is_i = area > 0
            if radial_is_i:
                quad = [c[k] for k in a_order]
                div = (n_rad, n_stream, 1)
            else:
                # Mapping B: i = streamwise, j = radial (transpose -> flips sign)
                b_order = [(0, 0), (0, 1), (1, 1), (1, 0)]
                quad = [c[k] for k in b_order]
                div = (n_stream, n_rad, 1)
            top = [v + z_offset for v in quad]
            verts = " ".join(str(v) for v in quad + top)
            g = (rg, stream_grading, "1") if radial_is_i else (stream_grading, rg, "1")
            block_lines.append(
                f"    hex ({verts}) ({div[0]} {div[1]} {div[2]}) "
                f"simpleGrading ({g[0]} {g[1]} {g[2]})  // {name}"
            )
            block_quads.append(quad)

        # --- boundary ------------------------------------------------------ #
        def face(v0: int, v1: int) -> str:
            return f"            ({v0} {v1} {v1 + z_offset} {v0 + z_offset})"

        airfoil_faces = [
            face(inner[j], inner[j + 1])
            for inner in (upper_inner, lower_inner)
            for j in range(n_segments)
        ]
        # Inlet = the C outer (front arcs + top + bottom); outlet = the two
        # downstream vertical faces. A fixed-pressure outlet gives the pressure a
        # solid reference, which keeps the delicate symmetric (AoA=0) case stable.
        inlet_faces = [
            face(outer[j], outer[j + 1])
            for outer in (upper_outer, lower_outer)
            for j in range(n_segments)
        ] + [face(upper_outer[0], outlet_top), face(lower_outer[-1], outlet_bottom)]
        outlet_faces = [face(outlet_wake_top, outlet_top), face(outlet_wake_bottom, outlet_bottom)]
        front_back: list[str] = []
        for quad in block_quads:
            front_back.append("            (" + " ".join(str(v) for v in quad) + ")")
            front_back.append(
                "            (" + " ".join(str(v + z_offset) for v in quad) + ")"
            )
        wake_upper = [face(upper_inner[0], outlet_wake_top)]
        wake_lower = [face(lower_inner[-1], outlet_wake_bottom)]

        boundary = self._boundary_block(
            airfoil_faces, inlet_faces, outlet_faces, front_back, wake_upper, wake_lower
        )

        return self._assemble(chord, vert_lines, edge_lines, block_lines, boundary)

    @staticmethod
    def _boundary_block(airfoil, inlet, outlet, front_back, wake_upper, wake_lower) -> str:
        def patch(name: str, ptype: str, faces: list[str]) -> str:
            joined = "\n".join(faces)
            return (
                f"    {name}\n    {{\n        type {ptype};\n"
                f"        faces\n        (\n{joined}\n        );\n    }}\n"
            )

        return (
            patch("airfoil", "wall", airfoil)
            + patch("inlet", "patch", inlet)
            + patch("outlet", "patch", outlet)
            + patch("frontAndBack", "empty", front_back)
            + patch("wakeUpper", "patch", wake_upper)
            + patch("wakeLower", "patch", wake_lower)
        )

    @staticmethod
    def _assemble(chord, vert_lines, edge_lines, block_lines, boundary) -> str:
        from ..openfoam.foam_dict import foam_file_header

        header = foam_file_header("dictionary", "blockMeshDict", "system")
        return (
            header
            + f"\nscale {chord:.10g};\n\n"
            + "vertices\n(\n"
            + "\n".join(vert_lines)
            + "\n);\n\n"
            + "edges\n(\n"
            + "\n".join(edge_lines)
            + "\n);\n\n"
            + "blocks\n(\n"
            + "\n".join(block_lines)
            + "\n);\n\n"
            + "boundary\n(\n"
            + boundary
            + ");\n\n"
            + "mergePatchPairs\n(\n    (wakeUpper wakeLower)\n);\n"
        )


register_mesher(BlockMeshCGrid())
for _segments in SEGMENTED_NORMAL_COUNTS:
    register_mesher(BlockMeshCGrid.segmented_normal(_segments))
