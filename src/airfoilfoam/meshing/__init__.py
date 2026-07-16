"""Pluggable meshing subsystem."""
from .base import BoundaryPatch, MeshResult, Mesher, get_mesher, list_meshers, register_mesher
from .blockmesh import BlockMeshCGrid  # noqa: F401  (registers the mesher on import)
from .cartesian2d import Cartesian2DExternalMesh  # noqa: F401  (registers on import)

__all__ = [
    "BoundaryPatch",
    "MeshResult",
    "Mesher",
    "get_mesher",
    "list_meshers",
    "register_mesher",
    "BlockMeshCGrid",
    "Cartesian2DExternalMesh",
]
