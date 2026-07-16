"""Pydantic request/response models — the public contract of the API."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
class EngineIdentity(BaseModel):
    """Logical numerical implementation requested for a solve.

    Family and distribution are deliberately extensible slugs: introducing the
    thesis-derived coupled Euler/boundary-layer engine must not require changing
    this shared contract.  Adapter registries, rather than this core model,
    decide which identities a particular runtime can execute.

    ``numerics_revision`` changes only when defaults, generated dictionaries or
    adapter behaviour can change numerical results.  Runtime rebuild metadata
    is intentionally kept out of this identity so a packaging-only rebuild does
    not split a physically compatible polar.
    """

    family: str = Field(default="openfoam", pattern=r"^[a-z][a-z0-9_-]*$")
    distribution: str = Field(default="opencfd", pattern=r"^[a-z][a-z0-9_-]*$")
    version: str = Field(default="2606", min_length=1, max_length=80)
    numerics_revision: str = Field(default="1", min_length=1, max_length=80)
    adapter_contract_version: int = Field(default=1, ge=1)

    @property
    def compatibility_key(self) -> str:
        """Stable namespace for caches and value-level numerical identity."""
        return (
            f"{self.family}:{self.distribution}:{self.version}:"
            f"numerics-{self.numerics_revision}"
        )

    @property
    def handshake_key(self) -> str:
        """Exact queue/request-worker contract identity, including schema revision."""
        return f"{self.compatibility_key}:adapter-{self.adapter_contract_version}"


class EngineRuntimeIdentity(EngineIdentity):
    """Exact worker/build provenance acknowledged by the executing runtime."""

    build_id: str = Field(default="dev", min_length=1, max_length=200)
    source_revision: Optional[str] = Field(default=None, max_length=200)
    image_digest: Optional[str] = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    application_source_sha256: Optional[str] = Field(
        default=None, pattern=r"^[0-9a-f]{64}$"
    )
    package_sha256: Optional[str] = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    binary_sha256: Optional[str] = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    architecture: Optional[str] = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def require_content_fingerprint(self) -> "EngineRuntimeIdentity":
        """Reject label-only new runtime acknowledgements.

        Historical evidence represents unrecorded runtime provenance as a null
        ``engine`` value, so enforcing this on concrete non-legacy runtime
        objects does not invent or erase legacy facts.
        """
        if self.distribution != "legacy" and not any(
            (
                self.image_digest,
                self.application_source_sha256,
                self.package_sha256,
                self.binary_sha256,
            )
        ):
            raise ValueError(
                "runtime provenance requires at least one content fingerprint"
            )
        return self

    def logical_identity(self) -> EngineIdentity:
        return EngineIdentity.model_validate(
            self.model_dump(
                include={
                    "family",
                    "distribution",
                    "version",
                    "numerics_revision",
                    "adapter_contract_version",
                }
            )
        )


class EngineCapabilities(BaseModel):
    """Typed, capability-driven description of one solver implementation."""

    engine: EngineIdentity
    routing_key: str = Field(
        min_length=1,
        description="Exact execution-pool/Celery routing key for this adapter.",
    )
    analysis_methods: list[str] = Field(default_factory=list)
    steady: bool = False
    transient: bool = False
    volume_fields: bool = False
    mesh_evidence: bool = False
    stored_media: bool = False
    custom_field_rendering: bool = False
    multi_element_geometry: bool = False
    supported_turbulence_models: list[str] = Field(default_factory=list)
    supported_image_fields: list[str] = Field(default_factory=list)


class AirfoilFormat(str, Enum):
    auto = "auto"
    selig = "selig"
    lednicer = "lednicer"


class FailureDisposition(str, Enum):
    """Machine-readable reason solver evidence or a whole job failed.

    Promotion policy must consume this field, never parse the user-facing
    ``error`` string.  ``hard_solver`` is reserved for aerodynamic/numerical
    RANS evidence (non-convergence, divergence, or invalid coefficients).
    Deterministic mesh and execution/infrastructure failures remain distinct
    repair/retry classes and cannot justify a whole-polar URANS replacement.
    """

    none = "none"
    hard_solver = "hard_solver"
    deterministic_mesh = "deterministic_mesh"
    infrastructure = "infrastructure"


class RansFailurePolicy(str, Enum):
    """Action after a qualifying low-AoA hard RANS failure in a marched polar."""

    continue_rans = "continue"
    abort_for_precalc = "abort_for_precalc"
    replace_precalc = "replace_precalc"


class AirfoilInput(BaseModel):
    """An airfoil supplied either as raw coordinate text or as an explicit point list."""

    name: str = Field(default="airfoil", description="Human-readable airfoil name.")
    format: AirfoilFormat = AirfoilFormat.auto
    coordinates: Optional[str] = Field(
        default=None,
        description="Raw airfoil coordinate file contents (Selig or Lednicer format).",
    )
    points: Optional[list[tuple[float, float]]] = Field(
        default=None,
        description="Explicit (x, y) points, normalised to unit chord, ordered around the contour.",
    )

    @model_validator(mode="after")
    def _need_geometry(self) -> "AirfoilInput":
        if not self.coordinates and not self.points:
            raise ValueError("Provide either 'coordinates' (text) or 'points'.")
        return self


class FluidProperties(BaseModel):
    """Fluid material properties. Supply kinematic viscosity, or density + dynamic viscosity."""

    density: float = Field(default=1.225, gt=0, description="Density rho [kg/m^3].")
    dynamic_viscosity: Optional[float] = Field(
        default=None, gt=0, description="Dynamic viscosity mu [Pa.s]."
    )
    kinematic_viscosity: Optional[float] = Field(
        default=None, gt=0, description="Kinematic viscosity nu [m^2/s]. Overrides mu/rho if given."
    )

    @model_validator(mode="after")
    def _need_viscosity(self) -> "FluidProperties":
        if self.kinematic_viscosity is None and self.dynamic_viscosity is None:
            # default to sea-level air dynamic viscosity
            self.dynamic_viscosity = 1.81e-5
        return self

    @property
    def nu(self) -> float:
        if self.kinematic_viscosity is not None:
            return self.kinematic_viscosity
        assert self.dynamic_viscosity is not None
        return self.dynamic_viscosity / self.density


class RoughnessParams(BaseModel):
    """Sand-grain wall-roughness model (Cebeci-Bradshaw) for the airfoil surface."""

    sand_grain_height: float = Field(
        default=0.0,
        ge=0,
        description="Equivalent sand-grain roughness height Ks [m]. 0 = smooth. NOTE: the sand-grain "
        "wall-function model requires the first wall cell to be larger than Ks, so for rough walls "
        "set a coarser wall spacing via mesh.first_cell_height_chords (>= Ks/chord) instead of y+~1.",
    )
    roughness_constant: float = Field(
        default=0.5, gt=0, le=1.0, description="Roughness constant Cs (typically 0.5)."
    )

    @property
    def is_rough(self) -> bool:
        return self.sand_grain_height > 0.0


class TurbulenceModel(str, Enum):
    k_omega = "kOmega"
    k_omega_sst = "kOmegaSST"
    k_omega_sst_lm = "kOmegaSSTLM"  # Langtry-Menter transition model (laminar-turbulent)
    k_epsilon = "kEpsilon"
    spalart_allmaras = "SpalartAllmaras"


class TurbulenceParams(BaseModel):
    model: TurbulenceModel = TurbulenceModel.k_omega_sst
    intensity: float = Field(
        default=0.001, gt=0, lt=1, description="Freestream turbulence intensity (fraction)."
    )
    viscosity_ratio: float = Field(
        default=10.0, gt=0, description="Freestream turbulent/laminar viscosity ratio nut/nu."
    )


class MeshParams(BaseModel):
    mesher: str = Field(default="blockmesh-cgrid", description="Registered mesher name.")
    farfield_radius_chords: float = Field(
        default=15.0, gt=1, le=80, description="Outer C-boundary radius in chord lengths."
    )
    wake_length_chords: float = Field(
        default=12.0, gt=1, le=80, description="Downstream wake length (from TE to outlet) in chords."
    )
    n_surface: int = Field(
        default=130, ge=20, le=600, description="Cells along each airfoil surface (upper/lower)."
    )
    n_radial: int = Field(default=80, ge=20, le=400, description="Cells in the radial (normal) direction.")
    n_wake: int = Field(default=60, ge=10, le=400, description="Cells along the wake (streamwise).")
    target_y_plus: float = Field(
        default=1.0,
        gt=0,
        description="Target wall y+; the first-cell height is sized for this per case unless "
        "first_cell_height_chords is given explicitly.",
    )
    first_cell_height_chords: Optional[float] = Field(
        default=None,
        gt=0,
        description="Explicit first wall-normal cell height in chord lengths. Overrides target_y_plus.",
    )
    span_chords: float = Field(
        default=0.1, gt=0, description="Spanwise (z) thickness of the 2D domain, in chords."
    )


# --------------------------------------------------------------------------- #
# URANS FIDELITY TIERS (pinned 2026-07-07, task #30; budgets retuned
# 2026-07-07 to measured prod rates — ladder-gate campaign, naca-0012
# alpha=15 deg, 25 m/s, 0.1 m chord; precalc retuned again 2026-07-09 to the
# first prod tier-2 wave). The request field
# ``solver.urans_fidelity`` selects the tier; the node side builds requests
# against EXACTLY these tier constants (contract pin tests on both runtimes):
#   precalc => urans_min_periods 3, solver budget 14400 s (4 h), mesh scale 0.5
#              + wall-function y+ 40 (2026-07-09 retune, measured basis:
#              first-layer height bound the timestep; see DecisionHistory
#              2026-07-09 "Measured: why precalc URANS is slow"). The derived
#              half-resolution URANS mesh halves n_surface/n_radial/n_wake; the
#              mesh cache keys on the resolved params, so it caches separately
#              from the full one.
#   full    => urans_min_periods 7, solver budget 43200 s (12 h), full-
#              resolution wall-function mesh by default (background trickle
#              tier per the approved ladder design)
# Measured basis for the budgets (gate tier-2 quality_warnings): under the
# original 3600 s precalc budget the guard stopped at "retained 1.4 of 3
# periods; projected 0.6h continuation exceeds 80% of the 1.0h solver
# timeout" — i.e. ~14 min/period on the half-res precalc mesh at the
# worst campaign class (c/U = 0.1 m / 25 m/s), so 3 periods need ~1.4 h
# => 7200 s. The first PROD tier-2 wave (2026-07-09) then budget-stopped
# 9/9 points at 7200 s with the feasible class projecting up to ~3.1 h of
# continuation past the stop point => 14400 s (the march-rate guard keeps
# the hopeless class from burning the bigger budget blind). The full tier
# runs the FULL mesh (~8x cost => ~2 h/period), so 7 periods need ~14 h of
# integration headroom under the 80% wall-guard fraction => 43200 s.
# The tier is echoed on PolarPoint.fidelity: "rans" | "urans_precalc" |
# "urans_full".
# --------------------------------------------------------------------------- #
class UransFidelity(str, Enum):
    precalc = "precalc"
    full = "full"


#: Whole shedding periods each tier must retain (contract item 1).
URANS_FIDELITY_MIN_PERIODS: dict[UransFidelity, int] = {
    UransFidelity.precalc: 3,
    UransFidelity.full: 7,
}

#: Wall-clock solver budget [s] for the URANS transient of each tier.
#: Retuned to measured prod rates (see the tier block comment above):
#: precalc 14400 s — the first prod tier-2 wave (2026-07-09) budget-stopped
#: 9/9 points at the old 7200 s: the feasible class (Re ~170-340k) projected
#: up to ~3.1 h of continuation past the stop point, so 4 h absorbs it,
#: while the provably hopeless class (Re 3.4M: t=0.0094 s of 0.4 s in the
#: full 2 h) is now stopped EARLY by the march-rate guard instead of burning
#: the bigger budget blind. History: 3600 -> 7200 -> 14400.
#: full 43200 s (~2 h/period full-resolution mesh => 7 periods, background trickle tier).
URANS_FIDELITY_BUDGET_S: dict[UransFidelity, int] = {
    UransFidelity.precalc: 14400,
    UransFidelity.full: 43200,
}

#: Mesh resolution scale of the derived precalc URANS mesh.
URANS_PRECALC_MESH_SCALE = 0.5

#: Wall-function y+ of derived URANS meshes.
#: Wall-function resolution trades boundary-layer detail for a ~40x taller
#: first cell, which lifts the Courant-capped dt by the same factor and removes
#: the high-aspect-ratio pressure stiffness. Precalc halves the mesh counts;
#: the full tier keeps the requested counts/extents and changes only the wall
#: spacing unless the concavity guard keeps the requested resolved-wall mesh.
#: Deliberately equals ``pipeline.TRANSIENT_WALL_YPLUS`` (standalone-case
#: fallback); do not import pipeline here because models must stay below the
#: runtime layer.
URANS_PRECALC_WALL_YPLUS = 40.0
URANS_FULL_WALL_YPLUS = 40.0

#: Geometry guard for the y+40 precalc wall-function mesh. Measured with the
#: airfoil.max_concave_curvature 0.025c arc-length window on real seed files:
#: s1223 4.89/c; sd8020 0.17/c; naca4412 0.36/c; n0012 0.00/c; clarky 0.04/c.
#: Keep a wide gap so only the strongly concave cove class stays on the
#: resolved-wall precalc mesh.
PRECALC_WALLFN_MAX_CONCAVE_CURVATURE = 2.5

#: Sane hard cap on the per-job URANS wall-budget override [s] (24 h). A
#: continuation submits the INCREASED budget through
#: ``PolarRequest.budget_override_s``; anything above this cap is rejected at
#: validation and clamped defensively at budget resolution.
URANS_BUDGET_OVERRIDE_MAX_S = 86_400


class ContinueFrom(BaseModel):
    """Resume a saved URANS case from a prior engine job (cross-job continuation).

    A URANS transient stopped by the wall-clock budget guard leaves its case
    directory (mesh, fields at latestTime, coefficient history) intact on the
    shared volume. A request carrying ``continue_from`` copies that saved case
    state into the new job and restarts the transient from latestTime with the
    (usually increased) budget, merging the coefficient history across the job
    boundary — the same restart-segment mechanics the in-run continuation
    chunks use. The source directory is validated at RUN time (the volume is
    only visible to the worker); a missing/cleaned case fails the job honestly.
    """

    engine_job_id: str = Field(
        pattern=r"^[0-9a-fA-F-]{8,64}$",
        description="Engine job id that produced the saved case (uuid-ish hex).",
    )
    case_slug: str = Field(
        min_length=1,
        max_length=200,
        description="Case slug within the prior job's cases/ directory (may contain "
        "one nesting level, e.g. 'c0p1_u25/urans_a3').",
    )

    @model_validator(mode="after")
    def _safe_slug(self) -> "ContinueFrom":
        parts = self.case_slug.split("/")
        if len(parts) > 2:
            raise ValueError("case_slug may contain at most one '/' nesting level.")
        for part in parts:
            if not part or part in {".", ".."}:
                raise ValueError("case_slug contains an empty or traversal path component.")
            if not all(c.isalnum() or c in "._-" for c in part):
                raise ValueError("case_slug contains characters outside [A-Za-z0-9._-].")
        return self


class ImageField(str, Enum):
    velocity_magnitude = "velocity_magnitude"
    velocity_x = "velocity_x"
    velocity_y = "velocity_y"
    pressure = "pressure"
    pressure_coefficient = "pressure_coefficient"
    vorticity = "vorticity"
    turbulent_kinetic_energy = "turbulent_kinetic_energy"
    turbulent_viscosity = "turbulent_viscosity"


ALL_IMAGE_FIELDS: tuple[ImageField, ...] = tuple(ImageField)


class SolverParams(BaseModel):
    turbulence: TurbulenceParams = Field(default_factory=TurbulenceParams)
    n_iterations: int = Field(default=3000, ge=50, le=20000, description="Max SIMPLE iterations.")
    convergence_tolerance: float = Field(
        default=1.0e-5, gt=0, description="Residual control for early convergence."
    )
    momentum_scheme: str = Field(
        default="linearUpwind",
        description="Convection scheme for div(phi,U): 'linearUpwind' (2nd order, default) or "
        "'upwind' (1st order, most robust).",
    )
    transient_fallback: bool = Field(
        default=True,
        description="If the steady solve does not converge (e.g. post-stall, unsteady separation), "
        "automatically re-run the case transient (pimpleFoam/URANS) and report time-averaged "
        "force coefficients with their fluctuation.",
    )
    rans_failure_policy: RansFailurePolicy = Field(
        default=RansFailurePolicy.replace_precalc,
        description="Low-AoA hard-RANS policy for a marched polar: continue, emit an "
        "external preliminary-URANS promotion signal, or replace in-job at preliminary fidelity.",
    )
    force_transient: bool = Field(
        default=False,
        description="Always run the transient URANS path for requested AoAs. A short steady solve may "
        "still be used as initialisation, but the steady RANS coefficients are not accepted as the "
        "reported polar result.",
    )
    warm_start: bool = Field(
        default=False,
        description="Solve each polar by marching the angle of attack, warm-starting each AoA from "
        "the previous converged field (serial within a polar). Helps with fine AoA spacing in the "
        "attached regime; the default (off) instead cold-starts every AoA with a potentialFoam "
        "initialisation and runs them concurrently, which is more robust and parallel. Either way "
        "the mesh is built once per airfoil/chord and reused.",
    )
    transient_cycles: float = Field(
        default=10.0, gt=1, description="Vortex-shedding cycles to simulate in the transient fallback."
    )
    transient_discard_fraction: float = Field(
        default=0.4, ge=0, lt=1, description="Initial fraction of the transient run discarded as startup."
    )
    transient_max_courant: float = Field(
        default=4.0,
        gt=0,
        description="Max Courant number for the adaptive transient time step. The implicit "
        "pimpleFoam solver tolerates Co>1, and a larger value avoids the tiny wall cells "
        "throttling the step — but >4 risks accumulating splitting error over multi-period "
        "horizons (prod 2026-07-07: relaxed-PIMPLE URANS at Co=15 accumulated splitting error "
        "into a velocity singularity, k bounding blow-up and dt collapse). 4 is the "
        "practitioner-standard ceiling for relaxed-PIMPLE URANS; profiles may still override.",
    )
    urans_fidelity: UransFidelity = Field(
        default=UransFidelity.full,
        description="URANS fidelity tier (pinned cross-runtime): 'precalc' runs a fast 3-period "
        "transient on a derived half-resolution wall-function mesh with a 14400 s (4 h) solver budget; 'full' "
        "runs 7 periods on a full-resolution wall-function mesh with a 43200 s (12 h) budget "
        "(background trickle tier). "
        "Budgets sized to measured prod rates: ~14 min/period half-res, ~2 h/period full mesh at "
        "the worst campaign class (0.1 m chord, 25 m/s). Echoed on PolarPoint.fidelity.",
    )
    steady_oscillation_window: int = Field(
        default=400,
        ge=50,
        le=5000,
        description="Iteration window for the oscillating-steady averaging detector: a steady "
        "solve that fails pointwise convergence but oscillates boundedly is accepted when the "
        "means of the two half-windows of the last N iterations agree within 2% and the "
        "oscillation amplitude is bounded; the window average is then reported with the full "
        "coefficient history shipped as steady_history.",
    )
    urans_min_periods: int = Field(
        default=7,
        ge=2,
        le=40,
        description="Whole vortex-shedding periods that must be retained (after startup discard) "
        "before a URANS transient stops integrating. The transient is extended in continuation "
        "chunks until this many periods are retained or the wall-clock budget guard fires.",
    )
    urans_drift_tolerance: float = Field(
        default=0.05,
        gt=0,
        lt=1,
        description="Stationarity tolerance for the retained URANS window: relative drift of the "
        "Cl mean between the first and second half of the integer-period window.",
    )
    frame_fields: list[ImageField] = Field(
        default_factory=lambda: [
            ImageField.vorticity,
            ImageField.velocity_magnitude,
            ImageField.pressure,
        ],
        description="Fields rendered as per-frame 640px PNGs for the frame-synced URANS player "
        "(frame_track contract). Output-profile configurable.",
    )
    transient_auto_refine: bool = Field(
        default=True,
        description="After a URANS run, rerun once with measured shedding timing if the retained "
        "window or field-write cadence is too sparse for reliable media. Background whole-polar "
        "URANS promotions may disable this so coefficients can ingest before expensive per-AoA "
        "media refinement.",
    )
    write_images: list[ImageField] = Field(
        default_factory=lambda: list(ALL_IMAGE_FIELDS)
    )
    image_zoom_chords: float = Field(
        default=2.0, gt=0, description="Half-window (in chords) around the airfoil for contour images."
    )


def urans_budget_seconds(solver: "SolverParams", override_s: Optional[int] = None) -> int:
    """Wall-clock solver budget for the URANS transient of this request's tier.

    ``override_s`` (``PolarRequest.budget_override_s``) replaces the tier
    budget for this job only — used by cross-job continuations that resume a
    budget-stopped transient with more wall time. Clamped to the 24 h cap
    defensively even though validation already rejects larger values.
    """
    if override_s is not None:
        return max(60, min(int(override_s), URANS_BUDGET_OVERRIDE_MAX_S))
    return URANS_FIDELITY_BUDGET_S[solver.urans_fidelity]


def apply_urans_fidelity(solver: "SolverParams") -> "SolverParams":
    """Effective solver params for the URANS stage of this request's tier.

    The tier owns the retained-period target (contract pin: precalc => 3,
    full => 7); everything else on the profile stands untouched.
    """
    target = URANS_FIDELITY_MIN_PERIODS[solver.urans_fidelity]
    if solver.urans_min_periods == target:
        return solver
    return solver.model_copy(update={"urans_min_periods": target})


def urans_point_fidelity(solver: "SolverParams") -> str:
    """PolarPoint.fidelity echo for values produced by this request's URANS tier."""
    return f"urans_{solver.urans_fidelity.value}"


def derive_precalc_mesh_params(mesh: MeshParams) -> MeshParams:
    """Derived wall-function, half-resolution URANS mesh for the precalc tier.

    Halves n_surface/n_radial/n_wake (clamped to the field minimums), switches
    the wall target to y+=40, clears any explicit first-cell height so y+ is
    actually resolved per case, and keeps farfield/wake extents. The mesh cache
    keys on the resolved params, so this derived mesh caches under its own key,
    separate from the full-resolution mesh.
    """
    return mesh.model_copy(
        update={
            "n_surface": max(20, round(mesh.n_surface * URANS_PRECALC_MESH_SCALE)),
            "n_radial": max(20, round(mesh.n_radial * URANS_PRECALC_MESH_SCALE)),
            "n_wake": max(10, round(mesh.n_wake * URANS_PRECALC_MESH_SCALE)),
            "target_y_plus": URANS_PRECALC_WALL_YPLUS,
            "first_cell_height_chords": None,
        }
    )


def derive_full_urans_mesh_params(mesh: MeshParams) -> MeshParams:
    """Derived full-resolution wall-function URANS mesh for the full tier.

    Keeps the request mesh counts/extents unchanged, switches the wall target
    to y+=40, and clears explicit first-cell height so y+ is resolved per case.
    The geometry-aware concavity guard lives in pipeline where airfoil geometry
    is available.
    """
    return mesh.model_copy(
        update={
            "target_y_plus": URANS_FULL_WALL_YPLUS,
            "first_cell_height_chords": None,
        }
    )


def derive_precalc_resolved_wall_mesh_params(mesh: MeshParams) -> MeshParams:
    """Derived half-resolution URANS mesh that preserves the profile wall spacing.

    This is the pre-wall-function derivation used for strongly concave airfoils:
    precalc still reduces the stream/radial/wake counts, but it keeps the
    requested target_y_plus and any explicit first-cell override.
    """
    return mesh.model_copy(
        update={
            "n_surface": max(20, round(mesh.n_surface * URANS_PRECALC_MESH_SCALE)),
            "n_radial": max(20, round(mesh.n_radial * URANS_PRECALC_MESH_SCALE)),
            "n_wake": max(10, round(mesh.n_wake * URANS_PRECALC_MESH_SCALE)),
        }
    )


def effective_mesh_params(mesh: MeshParams, solver: "SolverParams") -> MeshParams:
    """The default mesh params a job/case must build without geometry context.

    Geometry-aware resolution, explicit per-tier overrides, and concavity
    guards are centralized in ``pipeline.effective_mesh_params_for_airfoil``.
    """
    if solver.force_transient:
        if solver.urans_fidelity == UransFidelity.precalc:
            return derive_precalc_mesh_params(mesh)
        if solver.urans_fidelity == UransFidelity.full:
            return derive_full_urans_mesh_params(mesh)
    return mesh


class ResourcePolicy(str, Enum):
    auto = "auto"
    airfoil_parallel = "airfoil_parallel"
    case_parallel = "case_parallel"
    exclusive = "exclusive"


class ResourceParams(BaseModel):
    """Requested CPU scheduling policy for one airfoil job."""

    cpu_budget: Optional[int] = Field(
        default=None,
        ge=1,
        description="Maximum worker-local CPU tokens this airfoil job may consume. None lets the engine decide.",
    )
    case_concurrency: Optional[int] = Field(
        default=None,
        ge=1,
        description="Maximum AoA cases allowed to run concurrently inside this job. None lets the engine decide.",
    )
    solver_processes: Optional[int] = Field(
        default=None,
        ge=1,
        description="MPI/OpenFOAM processes per AoA case. 1 means a serial OpenFOAM solve.",
    )
    queue_pressure: Optional[int] = Field(
        default=None,
        ge=0,
        description="Optional control-plane backlog pressure hint used by the auto scheduler.",
    )
    policy: ResourcePolicy = Field(
        default=ResourcePolicy.auto,
        description="Scheduling policy: auto, airfoil_parallel, case_parallel, or exclusive.",
    )


class AoASpec(BaseModel):
    """Angles of attack to evaluate, as an explicit list and/or an inclusive range."""

    angles: Optional[list[float]] = Field(default=None, description="Explicit AoA values [deg].")
    start: Optional[float] = Field(default=None, description="Range start [deg].")
    stop: Optional[float] = Field(default=None, description="Range stop (inclusive) [deg].")
    step: Optional[float] = Field(default=None, description="Range step [deg].")

    @model_validator(mode="after")
    def _validate(self) -> "AoASpec":
        if self.angles is None and (self.start is None or self.stop is None or self.step is None):
            raise ValueError("Provide 'angles' or all of start/stop/step.")
        if self.step is not None and self.step == 0:
            raise ValueError("step must be non-zero.")
        return self

    def expand(self) -> list[float]:
        result: list[float] = []
        if self.angles:
            result.extend(float(a) for a in self.angles)
        if self.start is not None and self.stop is not None and self.step is not None:
            n = int(round((self.stop - self.start) / self.step))
            for i in range(n + 1):
                result.append(round(self.start + i * self.step, 6))
        # de-duplicate preserving order
        seen: set[float] = set()
        ordered: list[float] = []
        for a in result:
            if a not in seen:
                seen.add(a)
                ordered.append(a)
        return ordered


class PolarRequest(BaseModel):
    """Compute one or more polars. A polar is produced for every (speed, chord) combination."""

    airfoil: AirfoilInput
    chord_lengths: list[float] = Field(
        default=[1.0], min_length=1, description="Chord length(s) [m]. One polar per chord."
    )
    speeds: list[float] = Field(
        default=[50.0], min_length=1, description="Freestream speed(s) [m/s]. One polar per speed."
    )
    aoa: AoASpec
    fluid: FluidProperties = Field(default_factory=FluidProperties)
    roughness: RoughnessParams = Field(default_factory=RoughnessParams)
    mesh: MeshParams = Field(default_factory=MeshParams)
    urans_mesh: Optional[MeshParams] = Field(
        default=None,
        description="Explicit mesh for the full URANS tier. None means derive from mesh.",
    )
    urans_precalc_mesh: Optional[MeshParams] = Field(
        default=None,
        description="Explicit mesh for the precalc URANS tier. None means derive from mesh.",
    )
    solver: SolverParams = Field(default_factory=SolverParams)
    resources: ResourceParams = Field(default_factory=ResourceParams)
    continue_from: Optional[ContinueFrom] = Field(
        default=None,
        description="Resume the saved URANS case of a prior engine job instead of "
        "solving from scratch: the saved case dir is copied into this job, the "
        "transient restarts from latestTime and the coefficient history is merged "
        "across the job boundary. Requires a single-case force_transient request.",
    )
    budget_override_s: Optional[int] = Field(
        default=None,
        ge=60,
        le=URANS_BUDGET_OVERRIDE_MAX_S,
        description="Per-job URANS wall-clock budget [s] replacing the fidelity-tier "
        "budget (continuations submit the increased budget here). Capped at 24 h.",
    )
    expected_mesh_recovery_version: Optional[int] = Field(
        default=None,
        ge=0,
        description="Controller-required engine mesh-recovery capability. The API and "
        "worker reject a mismatch before solving so requested capability cannot be "
        "mistaken for execution provenance during a rolling deployment.",
    )
    expected_engine: Optional[EngineIdentity] = Field(
        default=None,
        description="Exact logical solver implementation required by the controller. "
        "Omission resolves to the current OpenFOAM/OpenCFD 2606 default; "
        "new callers should always send this field.",
    )
    expected_execution_pool: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Controller-required execution-pool routing key. The gateway and worker "
        "both reject a mismatch so a stale pool selection cannot silently run elsewhere.",
    )

    @model_validator(mode="after")
    def _validate(self) -> "PolarRequest":
        if any(c <= 0 for c in self.chord_lengths):
            raise ValueError("chord_lengths must be positive.")
        if any(s <= 0 for s in self.speeds):
            raise ValueError("speeds must be positive.")
        if self.continue_from is not None:
            if not self.solver.force_transient:
                raise ValueError(
                    "continue_from resumes a saved URANS transient; solver.force_transient must be true."
                )
            if len(self.cases()) != 1:
                raise ValueError(
                    "continue_from targets one saved case; the request must expand to exactly one "
                    "(chord, speed, AoA) case."
                )
        return self

    def cases(self) -> list["CaseSpec"]:
        """Flatten the request into the individual CFD cases to run."""
        specs: list[CaseSpec] = []
        for chord in self.chord_lengths:
            for speed in self.speeds:
                for aoa in self.aoa.expand():
                    specs.append(CaseSpec(chord=chord, speed=speed, aoa_deg=aoa))
        return specs


class CaseSpec(BaseModel):
    """A single CFD run: one chord, one speed, one angle of attack."""

    chord: float
    speed: float
    aoa_deg: float

    @property
    def slug(self) -> str:
        return f"c{self.chord:g}_u{self.speed:g}_a{self.aoa_deg:g}".replace(".", "p").replace("-", "m")


# --------------------------------------------------------------------------- #
# Outputs
# --------------------------------------------------------------------------- #
class ForceHistory(BaseModel):
    """Cl/Cd/Cm time series over the transient sampling window (URANS only)."""

    t: list[float] = Field(default_factory=list)
    cl: list[float] = Field(default_factory=list)
    cd: list[float] = Field(default_factory=list)
    cm: list[float] = Field(default_factory=list)
    shedding_freq_hz: Optional[float] = None
    samples: Optional[int] = None
    period_s: Optional[float] = Field(default=None, description="Measured vortex-shedding period used for this window.")
    retained_cycles: Optional[int] = Field(default=None, description="Integer number of shedding periods retained.")
    window_start: Optional[float] = Field(default=None, description="Start time of the retained integer-period window.")
    window_end: Optional[float] = Field(default=None, description="End time of the retained integer-period window.")


# --------------------------------------------------------------------------- #
# FRAME-TRACK CONTRACT (pinned 2026-07-06, task #23/#24). Shipped per URANS
# point in result.json as ``point.frame_track`` with EXACTLY this shape; the
# node side pins the same shape in packages/engine-client/src/frame-track.ts
# (strict parser: missing/extra/wrongly-typed keys are contract drift and fail
# tests on BOTH sides, same pattern as the orphan-message pin).
#
# The point-level cl/cd/cm/strouhal = frame_track.stats means / measured St
# (single source of truth). No-shedding steady points ship frame_track=null.
# --------------------------------------------------------------------------- #
class FrameTrackWindow(BaseModel):
    """Retained integer-period averaging window [t_start, t_end]."""

    t_start: float
    t_end: float


class FrameChannelStats(BaseModel):
    """Time-weighted trapezoidal stats over an INTEGER number of periods."""

    mean: float
    std: float
    min: float
    max: float


class FrameTrackStats(BaseModel):
    cl: FrameChannelStats
    cd: FrameChannelStats
    cm: FrameChannelStats


class FrameSample(BaseModel):
    """One recorded frame: index, physical time, instantaneous coefficients."""

    i: int
    t: float
    cl: float
    cd: float
    cm: float


#: Hard payload bound pinned by the contract: len(frames) <= 120.
FRAME_TRACK_MAX_FRAMES = 120

#: Evidence-artifact kind stamped on per-frame PNGs (pinned cross-runtime:
#: node FRAME_IMAGE_ARTIFACT_KIND must match this literal exactly).
FRAME_IMAGE_ARTIFACT_KIND = "frame_image"


class FrameTrack(BaseModel):
    period_s: Optional[float] = None
    periods_retained: float
    stationary: bool
    drift_frac: float
    window: FrameTrackWindow
    stats: FrameTrackStats
    # Frame-image fields (output-profile configurable; defaults include
    # vorticity, velocity magnitude, and pressure). Only fields whose PNGs
    # actually rendered are listed.
    fields: list[str] = Field(default_factory=list)
    # <=120 frames, all written states up to cap over the last 2-3 periods.
    frames: list[FrameSample] = Field(default_factory=list)
    # 640px-wide PNGs under the case dir, shipped as evidence files.
    image_pattern: str = "frames/{field}/f{i04}.png"


# --------------------------------------------------------------------------- #
# STEADY-HISTORY CONTRACT (pinned 2026-07-07, task #30). Shipped per steady
# point in result.json as ``point.steady_history`` with EXACTLY this shape
# whenever the steady solve used oscillating-averaging OR failed both
# pointwise convergence and mean stabilisation (history kept for analysis);
# null for classic pointwise convergence. Downsampled to <= 2000 samples
# engine-side. The node side pins the same shape (contract drift fails tests
# on BOTH runtimes, same pattern as frame_track).
# --------------------------------------------------------------------------- #

#: Hard payload bound pinned by the contract: len(iterations) <= 2000.
STEADY_HISTORY_MAX_SAMPLES = 2000


class SteadyHistoryWindow(BaseModel):
    """Averaging window of the oscillating-steady detector [start_iter, end_iter]."""

    start_iter: int
    end_iter: int


class SteadyHistory(BaseModel):
    """Steady-solve coefficient iteration history (oscillating-averaging evidence)."""

    iterations: list[int]
    cl: list[float]
    cd: list[float]
    cm: list[float]
    window: SteadyHistoryWindow
    mean_stable: bool
    note: str


class EvidenceArtifact(BaseModel):
    """Immutable raw/derived evidence file emitted by the engine.

    ``path`` is relative to the case directory. ``url`` is filled when the
    result is serialized for the API so downstream ingestion can preserve the
    exact job-file location.
    """

    kind: str
    path: str
    mime_type: str
    sha256: str
    byte_size: int
    role: Optional[str] = None
    field: Optional[str] = None
    url: Optional[str] = None
    metadata: dict[str, object] = Field(default_factory=dict)


class PolarPoint(BaseModel):
    case_slug: Optional[str] = Field(default=None, description="Engine case directory slug for this AoA evidence.")
    aoa_deg: float
    cl: Optional[float] = None
    cd: Optional[float] = None
    cm: Optional[float] = None
    cl_cd: Optional[float] = None
    cl_std: Optional[float] = Field(default=None, description="Std-dev of Cl over the averaging window (transient only).")
    cd_std: Optional[float] = Field(default=None, description="Std-dev of Cd over the averaging window (transient only).")
    cm_std: Optional[float] = None
    unsteady: bool = Field(
        default=False,
        description="True if values are time-averaged from a transient (URANS) run because the "
        "steady solve did not converge (e.g. post-stall). The *_std fields give the fluctuation.",
    )
    converged: bool = False
    final_residual: Optional[float] = None
    iterations: Optional[int] = None
    y_plus_avg: Optional[float] = None
    y_plus_max: Optional[float] = None
    n_cells: Optional[int] = Field(default=None, description="OpenFOAM mesh cell count for this case.")
    first_order_fallback: bool = Field(
        default=False,
        description="True if the case diverged with 2nd-order convection and was re-run with the "
        "more dissipative 1st-order upwind scheme (less accurate but stable).",
    )
    images: dict[str, str] = Field(default_factory=dict, description="image field -> result URL path")
    strouhal: Optional[float] = Field(
        default=None, description="Measured vortex-shedding Strouhal number St = f c / U (transient only)."
    )
    video: dict[str, str] = Field(
        default_factory=dict, description="image field -> animation (mp4) URL path (transient only)."
    )
    mean_images: dict[str, str] = Field(
        default_factory=dict, description="image field -> time-averaged contour URL path (transient only)."
    )
    force_history: Optional[ForceHistory] = Field(
        default=None, description="Cl/Cd/Cm time series for the force monitors (transient only)."
    )
    frame_track: Optional[FrameTrack] = Field(
        default=None,
        description="Pinned URANS recording contract: integer-period window, time-weighted stats, "
        "stationarity verdict and per-frame coefficient samples. None for steady and no-shedding "
        "points (frame_track=null in result.json).",
    )
    fidelity: Literal["rans", "urans_precalc", "urans_full"] = Field(
        default="rans",
        description="Solve tier that produced the reported values (pinned cross-runtime): "
        "'rans' for steady points, 'urans_precalc'/'urans_full' when the URANS transient of "
        "that tier produced them (including no-shedding steady-equivalent URANS means).",
    )
    steady_history: Optional[SteadyHistory] = Field(
        default=None,
        description="Pinned steady-history contract: the steady solve's Cl/Cd/Cm iteration "
        "history (<= 2000 samples) with the oscillating-averaging window and verdict. Shipped "
        "when the steady solve used oscillating-averaging or failed to stabilise; null for "
        "classic pointwise convergence.",
    )
    quality_warnings: list[str] = Field(
        default_factory=list,
        description="Non-fatal solver/media quality warnings, e.g. unmeasurable or under-resolved URANS output.",
    )
    evidence_artifacts: list[EvidenceArtifact] = Field(
        default_factory=list,
        description="Raw immutable engine evidence artifacts for this solver point.",
    )
    engine: Optional[EngineRuntimeIdentity] = Field(
        default=None,
        description="Exact worker/build provenance that produced this attempt. Null only for legacy stored results.",
    )
    method_key: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=160,
        description="Extensible numerical-method identity, e.g. openfoam.rans or openfoam.urans. "
        "Null only for legacy stored attempts; fidelity remains a separate tier dimension.",
    )
    failure_disposition: FailureDisposition = Field(
        default=FailureDisposition.none,
        description="Structured rejection provenance. Promotion logic may use 'hard_solver'; "
        "deterministic_mesh and infrastructure are repair/retry failures and never aerodynamic evidence.",
    )
    error: Optional[str] = None


class RansPrecalcPromotion(BaseModel):
    trigger_aoa_deg: float
    failure_disposition: Literal[FailureDisposition.hard_solver] = (
        FailureDisposition.hard_solver
    )
    attempted_aoas: list[float]
    intentionally_omitted_aoas: list[float]


class Polar(BaseModel):
    speed: float
    chord: float
    reynolds: float
    mach: Optional[float] = None
    points: list[PolarPoint] = Field(default_factory=list)
    attempts: list[PolarPoint] = Field(
        default_factory=list,
        description="Rejected or superseded solver attempts retained as evidence; not valid polar points.",
    )
    rans_precalc_promotion: Optional[RansPrecalcPromotion] = Field(
        default=None,
        description="Typed normal-control-flow signal that this polar stopped RANS and owes external preliminary URANS.",
    )


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class JobPhase(str, Enum):
    pending = "pending"
    waiting_cpu = "waiting_cpu"
    meshing = "meshing"
    solving_rans = "solving_rans"
    solving_urans = "solving_urans"
    postprocessing = "postprocessing"
    ingesting = "ingesting"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class SchedulingMetadata(BaseModel):
    requested_policy: ResourcePolicy = ResourcePolicy.auto
    resolved_policy: ResourcePolicy = ResourcePolicy.auto
    worker_cpu_budget: int = 1
    resolved_cpu_budget: int = 1
    resolved_case_concurrency: int = 1
    solver_processes: int = 1
    mesh_build_count: int = 0
    aoa_case_count: int = 0
    mesh_reuse_mode: Literal["symlink", "copy"] = "symlink"
    queue_depth: Optional[int] = None


class JobStatus(BaseModel):
    job_id: str
    state: JobState
    phase: JobPhase = JobPhase.pending
    total_cases: int = 0
    completed_cases: int = 0
    message: Optional[str] = None
    task_id: Optional[str] = None
    queued_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    phase_started_at: Optional[datetime] = None
    last_progress_at: Optional[datetime] = None
    active_solver: Optional[str] = None
    active_case_slug: Optional[str] = None
    active_aoa_deg: Optional[float] = None
    active_pids: list[int] = Field(default_factory=list)
    cpu_tokens_waiting: int = 0
    cpu_tokens_held: int = 0
    scheduling: Optional[SchedulingMetadata] = None
    requested_engine: Optional[EngineIdentity] = Field(
        default=None,
        description="Resolved logical routing target. Present before execution without claiming runtime provenance.",
    )
    requested_execution_pool: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Resolved execution-pool routing target retained from submission.",
    )
    engine: Optional[EngineRuntimeIdentity] = Field(
        default=None,
        description="Executing worker acknowledgement. Null while work is only queued or for legacy stored status.",
    )
    execution_pool: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Execution pool acknowledged by the worker. Null while work is only queued.",
    )
    mesh_recovery_version: Optional[int] = Field(
        default=None,
        ge=0,
        description="Capability acknowledged by the worker that actually executed this job. "
        "Null while only the API has accepted/queued the request.",
    )
    failure_disposition: Optional[FailureDisposition] = Field(
        default=None,
        description="Machine-readable terminal job failure class when execution ended "
        "before per-angle attempt evidence existed.",
    )


class JobResult(BaseModel):
    job_id: str
    state: JobState
    polars: list[Polar] = Field(default_factory=list)
    message: Optional[str] = None
    scheduling: Optional[SchedulingMetadata] = None
    requested_engine: Optional[EngineIdentity] = Field(
        default=None,
        description="Resolved logical routing target retained independently from worker acknowledgement.",
    )
    requested_execution_pool: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Resolved execution-pool routing target retained from submission.",
    )
    engine: Optional[EngineRuntimeIdentity] = Field(
        default=None,
        description="Exact worker/build provenance that produced or rejected this result.",
    )
    execution_pool: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Execution pool acknowledged by the worker that produced this result.",
    )
    method_keys: list[str] = Field(
        default_factory=list,
        description="Distinct numerical methods present in this result. Jobs may contain both RANS and URANS attempts.",
    )
    mesh_recovery_version: Optional[int] = Field(
        default=None,
        ge=0,
        description="Capability acknowledged by the worker that produced this result.",
    )
    failure_disposition: Optional[FailureDisposition] = Field(
        default=None,
        description="Machine-readable terminal job failure class when execution ended "
        "before per-angle attempt evidence existed.",
    )
