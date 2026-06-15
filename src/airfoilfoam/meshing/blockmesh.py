"""A parametric structured C-grid generated with OpenFOAM's ``blockMesh``.

Topology (unit-chord, scaled to metres via ``convertToMeters``):

    leading edge at (0,0), trailing edge at (1,0); outer C-boundary is a circle
    of radius R about the LE, opening downstream to an outlet at x = 1 + wake.

Four blocks: upper-around, lower-around, upper-wake, lower-wake.  The trailing
edge is closed (sharp) and the wake cut between the two wake blocks is stitched
into internal faces with ``mergePatchPairs``.  The whole outer boundary is a
single ``freestream`` patch, which lets the same mesh serve every angle of
attack (AoA is applied by rotating the freestream velocity, not the mesh).
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

from ..airfoil import Airfoil
from ..models import MeshParams
from ..openfoam.runner import Runner
from .base import BoundaryPatch, MeshResult, Mesher, register_mesher

# Streamwise clustering / wake growth (fixed, sensible defaults).
SURFACE_GRADING_RATIO = 6.0  # cell-size ratio mid/end on each airfoil surface
WAKE_EXPANSION = 50.0  # last/first cell ratio along the wake


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


class BlockMeshCGrid(Mesher):
    name = "blockmesh-cgrid"

    # -- public API --------------------------------------------------------- #
    def patches(self, params: MeshParams) -> list[BoundaryPatch]:
        return [
            BoundaryPatch("airfoil", "wall"),
            BoundaryPatch("freestream", "freestream"),
            BoundaryPatch("frontAndBack", "empty"),
        ]

    def write_inputs(self, case_dir: Path, airfoil: Airfoil, params: MeshParams, chord: float) -> None:
        text = self.build_dict(airfoil, params, chord)
        path = case_dir / "system" / "blockMeshDict"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_mesh(self, case_dir: Path, params: MeshParams, runner: Runner) -> MeshResult:
        res = runner.application(case_dir, "blockMesh").check()
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

        # --- vertices (z=0 then z=span) ------------------------------------ #
        base = [
            (1.0, 0.0),  # 0 TE upper
            (0.0, 0.0),  # 1 LE
            (1.0, 0.0),  # 2 TE lower
            (0.0, R),  # 3 inlet top
            (-R, 0.0),  # 4 inlet front
            (0.0, -R),  # 5 inlet bottom
            (Xo, R),  # 6 outlet top
            (Xo, 0.0),  # 7 outlet wake top
            (Xo, 0.0),  # 8 outlet wake bottom
            (Xo, -R),  # 9 outlet bottom
        ]
        vert_lines = []
        for z in (0.0, span):
            for (x, y) in base:
                vert_lines.append(f"    ({x:.10g} {y:.10g} {z:.10g})")

        # --- edges (airfoil splines + inlet arcs) -------------------------- #
        upper, lower = airfoil.resampled_surfaces(n_surf)  # LE -> TE each
        upper_te_to_le = upper[::-1][1:-1]  # interior, TE -> LE
        lower_le_to_te = lower[1:-1]  # interior, LE -> TE

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

        # --- blocks -------------------------------------------------------- #
        # Each block: corners keyed by (radial r in {0=wall/inner,1=far},
        # streamwise s in {0,1}); we pick the local axis order that yields a
        # positive cell volume.
        blocks = [
            # name, n_stream, stream_grading, corners {(r,s): vertex}
            ("UA", n_surf, surf_grading, {(0, 0): 0, (1, 0): 3, (0, 1): 1, (1, 1): 4}),
            ("LA", n_surf, surf_grading, {(0, 0): 1, (1, 0): 4, (0, 1): 2, (1, 1): 5}),
            ("UW", n_wake, wake_grading, {(0, 0): 0, (1, 0): 3, (0, 1): 7, (1, 1): 6}),
            ("LW", n_wake, wake_grading, {(0, 0): 2, (1, 0): 5, (0, 1): 8, (1, 1): 9}),
        ]
        block_lines = []
        for name, n_stream, stream_grading, c in blocks:
            coord = {k: base[v] for k, v in c.items()}
            # Mapping A: i = radial (wall->far), j = streamwise (s0->s1)
            a_order = [(0, 0), (1, 0), (1, 1), (0, 1)]
            area = _signed_area([coord[k] for k in a_order])
            if area > 0:
                quad = [c[k] for k in a_order]
                div = (n_rad, n_stream, 1)
                grading = (f"{rad_grading:.8g}", stream_grading, "1")
            else:
                # Mapping B: i = streamwise, j = radial (transpose -> flips sign)
                b_order = [(0, 0), (0, 1), (1, 1), (1, 0)]
                quad = [c[k] for k in b_order]
                div = (n_stream, n_rad, 1)
                grading = (stream_grading, f"{rad_grading:.8g}", "1")
            top = [v + 10 for v in quad]
            verts = " ".join(str(v) for v in quad + top)
            block_lines.append(
                f"    hex ({verts}) ({div[0]} {div[1]} {div[2]}) "
                f"simpleGrading ({grading[0]} {grading[1]} {grading[2]})  // {name}"
            )

        # --- boundary ------------------------------------------------------ #
        def face(v0: int, v1: int) -> str:
            return f"            ({v0} {v1} {v1 + 10} {v0 + 10})"

        airfoil_faces = [face(0, 1), face(1, 2)]
        freestream_faces = [
            face(3, 4),
            face(4, 5),
            face(3, 6),
            face(5, 9),
            face(7, 6),
            face(8, 9),
        ]
        front_back = [
            "            (0 3 4 1)",
            "            (1 4 5 2)",
            "            (0 3 6 7)",
            "            (2 5 9 8)",
            "            (10 13 14 11)",
            "            (11 14 15 12)",
            "            (10 13 16 17)",
            "            (12 15 19 18)",
        ]
        wake_upper = [face(0, 7)]
        wake_lower = [face(2, 8)]

        boundary = self._boundary_block(
            airfoil_faces, freestream_faces, front_back, wake_upper, wake_lower
        )

        return self._assemble(chord, vert_lines, edge_lines, block_lines, boundary)

    @staticmethod
    def _boundary_block(airfoil, freestream, front_back, wake_upper, wake_lower) -> str:
        def patch(name: str, ptype: str, faces: list[str]) -> str:
            joined = "\n".join(faces)
            return (
                f"    {name}\n    {{\n        type {ptype};\n"
                f"        faces\n        (\n{joined}\n        );\n    }}\n"
            )

        return (
            patch("airfoil", "wall", airfoil)
            + patch("freestream", "patch", freestream)
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
