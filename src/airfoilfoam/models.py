"""Pydantic request/response models — the public contract of the API."""
from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
class AirfoilFormat(str, Enum):
    auto = "auto"
    selig = "selig"
    lednicer = "lednicer"


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
        default=0.0, ge=0, description="Equivalent sand-grain roughness height Ks [m]. 0 = smooth."
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
        default=12.0, gt=1, description="Outer C-boundary radius in chord lengths."
    )
    wake_length_chords: float = Field(
        default=16.0, gt=1, description="Downstream wake length (from TE to outlet) in chords."
    )
    n_surface: int = Field(
        default=120, ge=20, le=600, description="Cells along each airfoil surface (upper/lower)."
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


class ImageField(str, Enum):
    velocity_magnitude = "velocity_magnitude"
    velocity_x = "velocity_x"
    velocity_y = "velocity_y"
    pressure = "pressure"
    turbulent_kinetic_energy = "turbulent_kinetic_energy"
    turbulent_viscosity = "turbulent_viscosity"


class SolverParams(BaseModel):
    turbulence: TurbulenceParams = Field(default_factory=TurbulenceParams)
    n_iterations: int = Field(default=2000, ge=50, le=20000, description="Max SIMPLE iterations.")
    convergence_tolerance: float = Field(
        default=1.0e-5, gt=0, description="Residual control for early convergence."
    )
    write_images: list[ImageField] = Field(
        default_factory=lambda: [ImageField.velocity_magnitude, ImageField.pressure]
    )
    image_zoom_chords: float = Field(
        default=2.0, gt=0, description="Half-window (in chords) around the airfoil for contour images."
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
    solver: SolverParams = Field(default_factory=SolverParams)

    @model_validator(mode="after")
    def _validate(self) -> "PolarRequest":
        if any(c <= 0 for c in self.chord_lengths):
            raise ValueError("chord_lengths must be positive.")
        if any(s <= 0 for s in self.speeds):
            raise ValueError("speeds must be positive.")
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
class PolarPoint(BaseModel):
    aoa_deg: float
    cl: Optional[float] = None
    cd: Optional[float] = None
    cm: Optional[float] = None
    cl_cd: Optional[float] = None
    converged: bool = False
    final_residual: Optional[float] = None
    iterations: Optional[int] = None
    y_plus_avg: Optional[float] = None
    y_plus_max: Optional[float] = None
    images: dict[str, str] = Field(default_factory=dict, description="image field -> result URL path")
    error: Optional[str] = None


class Polar(BaseModel):
    speed: float
    chord: float
    reynolds: float
    mach: Optional[float] = None
    points: list[PolarPoint] = Field(default_factory=list)


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class JobStatus(BaseModel):
    job_id: str
    state: JobState
    total_cases: int = 0
    completed_cases: int = 0
    message: Optional[str] = None


class JobResult(BaseModel):
    job_id: str
    state: JobState
    polars: list[Polar] = Field(default_factory=list)
    message: Optional[str] = None
