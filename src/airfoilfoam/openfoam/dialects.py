"""Versioned OpenFOAM distribution dialects.

OpenCFD and the OpenFOAM Foundation share physics vocabulary but not a stable
case/CLI/output dialect.  This module is the single boundary for those
differences; the pipeline consumes commands and dictionary specifications from
an adapter instead of branching on distribution strings throughout execution.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..models import (
    ALL_IMAGE_FIELDS,
    EngineCapabilities,
    EngineIdentity,
    ImageField,
    TurbulenceModel,
)
from .foam_dict import Raw, dimensions


class UnsupportedEngineIdentity(ValueError):
    """The runtime has no adapter for the requested logical engine identity."""


@dataclass(frozen=True)
class FoamDictionarySpec:
    path: Path
    class_name: str
    object_name: str
    contents: dict


@dataclass(frozen=True)
class OpenFoamDialect:
    identity: EngineIdentity
    queue_name: str
    coefficient_filename: str
    force_libraries: tuple[str, ...]
    force_interval_key: str
    steady_solver_command: str
    transient_solver_command: str
    potential_foam_command: str
    y_plus_command: str
    vtk_all_times_command: str
    vtk_latest_time_command: str
    control_solver_key: str
    control_solver_value_steady: str
    control_solver_value_transient: str

    def control_solver_entry(self, *, transient: bool) -> dict[str, str]:
        return {
            self.control_solver_key: (
                self.control_solver_value_transient
                if transient
                else self.control_solver_value_steady
            )
        }

    def constant_dictionary_specs(
        self,
        nu: float,
        ras_model: str,
        density: float = 1.0,
    ) -> tuple[FoamDictionarySpec, ...]:
        raise NotImplementedError

    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            engine=self.identity,
            routing_key=self.queue_name,
            analysis_methods=["rans", "urans"],
            steady=True,
            transient=True,
            volume_fields=True,
            mesh_evidence=True,
            stored_media=True,
            custom_field_rendering=True,
            multi_element_geometry=False,
            supported_turbulence_models=[model.value for model in TurbulenceModel],
            supported_image_fields=[field.value for field in ALL_IMAGE_FIELDS],
        )


@dataclass(frozen=True)
class OpenCfdDialect(OpenFoamDialect):
    def constant_dictionary_specs(
        self,
        nu: float,
        ras_model: str,
        density: float = 1.0,
    ) -> tuple[FoamDictionarySpec, ...]:
        return (
            FoamDictionarySpec(
                Path("constant") / "transportProperties",
                "dictionary",
                "transportProperties",
                {
                    "transportModel": "Newtonian",
                    "nu": Raw(f"{dimensions(0, 2, -1, 0, 0, 0, 0)} {nu:.10g}"),
                },
            ),
            FoamDictionarySpec(
                Path("constant") / "turbulenceProperties",
                "dictionary",
                "turbulenceProperties",
                {
                    "simulationType": "RAS",
                    "RAS": {
                        "RASModel": ras_model,
                        "turbulence": "on",
                        "printCoeffs": "on",
                    },
                },
            ),
        )


@dataclass(frozen=True)
class Foundation14Dialect(OpenFoamDialect):
    def constant_dictionary_specs(
        self,
        nu: float,
        ras_model: str,
        density: float = 1.0,
    ) -> tuple[FoamDictionarySpec, ...]:
        # Foundation v14's modular incompressibleFluid solver reads these two
        # dictionaries; transportProperties/turbulenceProperties are an OpenCFD
        # dialect and must never be emitted into a Foundation case.
        return (
            FoamDictionarySpec(
                Path("constant") / "physicalProperties",
                "dictionary",
                "physicalProperties",
                {
                    "viscosityModel": "constant",
                    "rho": density,
                    "nu": nu,
                },
            ),
            FoamDictionarySpec(
                Path("constant") / "momentumTransport",
                "dictionary",
                "momentumTransport",
                {
                    "simulationType": "RAS",
                    "RAS": {
                        "model": ras_model,
                        "turbulence": "on",
                    },
                },
            ),
        )


OPENCFD_2406_IDENTITY = EngineIdentity(
    family="openfoam",
    distribution="opencfd",
    version="2406",
    numerics_revision="1",
    adapter_contract_version=1,
)

OPENCFD_2606_IDENTITY = EngineIdentity(
    family="openfoam",
    distribution="opencfd",
    version="2606",
    numerics_revision="1",
    adapter_contract_version=1,
)

FOUNDATION_14_IDENTITY = EngineIdentity(
    family="openfoam",
    distribution="foundation",
    version="14",
    numerics_revision="1",
    adapter_contract_version=1,
)

OPENCFD_2606 = OpenCfdDialect(
    identity=OPENCFD_2606_IDENTITY,
    queue_name="openfoam-opencfd-2606",
    coefficient_filename="coefficient.dat",
    force_libraries=("forces",),
    force_interval_key="writeInterval",
    steady_solver_command="simpleFoam",
    transient_solver_command="pimpleFoam",
    potential_foam_command="potentialFoam -writephi -initialiseUBCs",
    y_plus_command="simpleFoam -postProcess -func yPlus -latestTime",
    vtk_all_times_command="foamToVTK",
    vtk_latest_time_command="foamToVTK -latestTime",
    control_solver_key="application",
    control_solver_value_steady="simpleFoam",
    control_solver_value_transient="pimpleFoam",
)

FOUNDATION_14 = Foundation14Dialect(
    identity=FOUNDATION_14_IDENTITY,
    queue_name="openfoam-foundation-14",
    coefficient_filename="forceCoeffs.dat",
    force_libraries=('"libforces.so"',),
    force_interval_key="timeInterval",
    steady_solver_command="foamRun -solver incompressibleFluid",
    transient_solver_command="foamRun -solver incompressibleFluid",
    potential_foam_command="potentialFoam -writePhi -initialiseUBCs",
    y_plus_command="foamPostProcess -solver incompressibleFluid -func yPlus -latestTime",
    vtk_all_times_command="foamToVTK -useTimeName",
    vtk_latest_time_command="foamToVTK -latestTime -useTimeName",
    control_solver_key="solver",
    control_solver_value_steady="incompressibleFluid",
    control_solver_value_transient="incompressibleFluid",
)

_DIALECTS: tuple[OpenFoamDialect, ...] = (OPENCFD_2606, FOUNDATION_14)


def supported_openfoam_identities() -> list[EngineIdentity]:
    return [dialect.identity.model_copy(deep=True) for dialect in _DIALECTS]


def get_openfoam_dialect(identity: EngineIdentity | None = None) -> OpenFoamDialect:
    requested = identity or OPENCFD_2606_IDENTITY
    for dialect in _DIALECTS:
        if requested == dialect.identity:
            return dialect
    raise UnsupportedEngineIdentity(
        "unsupported solver identity "
        f"{requested.family}/{requested.distribution}/{requested.version} "
        f"(numerics {requested.numerics_revision}, adapter contract "
        f"{requested.adapter_contract_version})"
    )


def dialect_for_runner(runner) -> OpenFoamDialect:
    settings = getattr(runner, "settings", None)
    identity = settings.engine_identity() if settings is not None else OPENCFD_2606_IDENTITY
    return get_openfoam_dialect(identity)


FORCE_COEFFICIENT_FILENAMES: tuple[str, ...] = tuple(
    dict.fromkeys(dialect.coefficient_filename for dialect in _DIALECTS)
)


def find_force_coefficient_files(case_dir: Path) -> list[Path]:
    """All forceCoeffs segments across supported OpenFOAM output dialects."""

    files: list[Path] = []
    for filename in FORCE_COEFFICIENT_FILENAMES:
        files.extend(case_dir.glob(f"postProcessing/forceCoeffs1/*/{filename}"))

    def start_time(path: Path) -> float:
        try:
            return float(path.parent.name)
        except ValueError:
            return -1.0

    return sorted(set(files), key=lambda path: (start_time(path), path.name))
