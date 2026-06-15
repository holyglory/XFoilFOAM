"""Mesher abstraction and registry.

A mesher turns an :class:`~airfoilfoam.airfoil.Airfoil` plus
:class:`~airfoilfoam.models.MeshParams` into an OpenFOAM mesh inside a case
directory, and reports the boundary patches it created (by *role*) so that the
case builder can write boundary conditions in a mesher-agnostic way.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from ..airfoil import Airfoil
from ..models import MeshParams
from ..openfoam.runner import Runner


@dataclass
class BoundaryPatch:
    name: str
    role: str  # one of: "wall", "inlet", "outlet", "empty"


@dataclass
class MeshResult:
    patches: list[BoundaryPatch]
    span_chords: float
    n_cells: int = 0
    log: str = ""
    extra: dict = field(default_factory=dict)

    def patch_by_role(self, role: str) -> list[str]:
        return [p.name for p in self.patches if p.role == role]


class Mesher(ABC):
    name: str = "base"

    @abstractmethod
    def write_inputs(self, case_dir: Path, airfoil: Airfoil, params: MeshParams, chord: float) -> None:
        """Write the mesher input files (e.g. system/blockMeshDict) into the case."""

    @abstractmethod
    def patches(self, params: MeshParams) -> list[BoundaryPatch]:
        """The boundary patches this mesher produces (known before meshing)."""

    @abstractmethod
    def run_mesh(self, case_dir: Path, params: MeshParams, runner: Runner) -> MeshResult:
        """Run the mesher (inputs already written, controlDict must exist)."""

    def generate(
        self, case_dir: Path, airfoil: Airfoil, params: MeshParams, chord: float, runner: Runner
    ) -> MeshResult:
        """Convenience: write inputs and run the mesher (caller must supply a controlDict)."""
        self.write_inputs(case_dir, airfoil, params, chord)
        return self.run_mesh(case_dir, params, runner)


_REGISTRY: dict[str, Mesher] = {}


def register_mesher(mesher: Mesher) -> Mesher:
    _REGISTRY[mesher.name] = mesher
    return mesher


def get_mesher(name: str) -> Mesher:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(f"Unknown mesher {name!r}. Available: {sorted(_REGISTRY)}")


def list_meshers() -> list[str]:
    return sorted(_REGISTRY)
