"""Turbulence-model-specific 0/ fields, schemes and solver settings."""
from __future__ import annotations

from dataclasses import dataclass, field

from .. import physics
from ..models import RoughnessParams, TurbulenceModel
from ..openfoam.foam_dict import Raw, dimensions


def _u(value) -> Raw:
    return Raw(f"uniform {value}")


@dataclass
class FieldSpec:
    object_name: str
    class_name: str
    dims: Raw
    internal: str
    boundary: dict


@dataclass
class TurbulenceConfig:
    ras_model: str
    fields: list[FieldSpec]
    div_schemes: dict[str, str]
    solver_vars: list[str]  # field names solved with the matrix smoother
    relaxation: dict[str, float]
    residual_controls: list[str]
    extra: dict = field(default_factory=dict)


def _wall_nut(roughness: RoughnessParams) -> dict:
    if roughness.is_rough:
        return {
            "type": "nutkRoughWallFunction",
            "Ks": _u(roughness.sand_grain_height),
            "Cs": _u(roughness.roughness_constant),
            "value": _u(0),
        }
    return {"type": "nutUSpaldingWallFunction", "value": _u(0)}


def build_turbulence(
    model: TurbulenceModel,
    speed: float,
    nu: float,
    intensity: float,
    viscosity_ratio: float,
    roughness: RoughnessParams,
    wall: str,
    inlet: str,
    outlet: str,
    empty: str,
) -> TurbulenceConfig:
    k = physics.freestream_k(speed, intensity)
    omega = physics.freestream_omega(k, nu, viscosity_ratio)
    epsilon = physics.freestream_epsilon(k, omega)
    nut = physics.freestream_nut(k, omega)
    nutilda = physics.freestream_nutilda(nu, viscosity_ratio)

    def scalar_field(name, dims, value, wall_bc):
        return FieldSpec(
            object_name=name,
            class_name="volScalarField",
            dims=dims,
            internal=f"uniform {value}",
            boundary={
                inlet: {"type": "fixedValue", "value": _u(value)},
                outlet: {"type": "inletOutlet", "inletValue": _u(value), "value": _u(value)},
                wall: wall_bc,
                empty: {"type": "empty"},
            },
        )

    nut_field = FieldSpec(
        object_name="nut",
        class_name="volScalarField",
        dims=dimensions(0, 2, -1, 0, 0, 0, 0),
        internal=f"uniform {nut}",
        boundary={
            inlet: {"type": "calculated", "value": _u(nut)},
            outlet: {"type": "calculated", "value": _u(nut)},
            wall: _wall_nut(roughness),
            empty: {"type": "empty"},
        },
    )

    k_dims = dimensions(0, 2, -2, 0, 0, 0, 0)
    omega_dims = dimensions(0, 0, -1, 0, 0, 0, 0)
    eps_dims = dimensions(0, 2, -3, 0, 0, 0, 0)
    nutilda_dims = dimensions(0, 2, -1, 0, 0, 0, 0)

    if model in (
        TurbulenceModel.k_omega,
        TurbulenceModel.k_omega_sst,
        TurbulenceModel.k_omega_sst_lm,
    ):
        k_field = scalar_field("k", k_dims, k, {"type": "kqRWallFunction", "value": _u(k)})
        omega_field = scalar_field(
            "omega", omega_dims, omega, {"type": "omegaWallFunction", "value": _u(omega)}
        )
        fields = [k_field, omega_field, nut_field]
        div = {"div(phi,k)": "bounded Gauss upwind", "div(phi,omega)": "bounded Gauss upwind"}
        solver_vars = ["k", "omega"]
        relaxation = {"k": 0.5, "omega": 0.5}

        if model == TurbulenceModel.k_omega_sst_lm:
            # Langtry-Menter transition: intermittency gammaInt and transition
            # momentum-thickness Reynolds number ReThetat (both dimensionless).
            re_theta = physics.transition_re_theta_t(intensity)
            dimless = dimensions(0, 0, 0, 0, 0, 0, 0)

            def transition_field(name, value):
                return FieldSpec(
                    object_name=name,
                    class_name="volScalarField",
                    dims=dimless,
                    internal=f"uniform {value}",
                    boundary={
                        inlet: {"type": "fixedValue", "value": _u(value)},
                        outlet: {"type": "inletOutlet", "inletValue": _u(value), "value": _u(value)},
                        wall: {"type": "zeroGradient"},
                        empty: {"type": "empty"},
                    },
                )

            fields += [transition_field("gammaInt", 1), transition_field("ReThetat", re_theta)]
            div["div(phi,gammaInt)"] = "bounded Gauss upwind"
            div["div(phi,ReThetat)"] = "bounded Gauss upwind"
            solver_vars += ["gammaInt", "ReThetat"]
            relaxation["gammaInt"] = 0.5
            relaxation["ReThetat"] = 0.5

        return TurbulenceConfig(
            ras_model=model.value,
            fields=fields,
            div_schemes=div,
            solver_vars=solver_vars,
            relaxation=relaxation,
            residual_controls=["k", "omega"],
        )

    if model == TurbulenceModel.k_epsilon:
        k_field = scalar_field("k", k_dims, k, {"type": "kqRWallFunction", "value": _u(k)})
        eps_field = scalar_field(
            "epsilon", eps_dims, epsilon, {"type": "epsilonWallFunction", "value": _u(epsilon)}
        )
        return TurbulenceConfig(
            ras_model="kEpsilon",
            fields=[k_field, eps_field, nut_field],
            div_schemes={
                "div(phi,k)": "bounded Gauss upwind",
                "div(phi,epsilon)": "bounded Gauss upwind",
            },
            solver_vars=["k", "epsilon"],
            relaxation={"k": 0.5, "epsilon": 0.5},
            residual_controls=["k", "epsilon"],
        )

    # Spalart-Allmaras
    nutilda_field = FieldSpec(
        object_name="nuTilda",
        class_name="volScalarField",
        dims=nutilda_dims,
        internal=f"uniform {nutilda}",
        boundary={
            inlet: {"type": "fixedValue", "value": _u(nutilda)},
            outlet: {"type": "inletOutlet", "inletValue": _u(nutilda), "value": _u(nutilda)},
            wall: {"type": "fixedValue", "value": _u(0)},
            empty: {"type": "empty"},
        },
    )
    return TurbulenceConfig(
        ras_model="SpalartAllmaras",
        fields=[nutilda_field, nut_field],
        div_schemes={"div(phi,nuTilda)": "bounded Gauss upwind"},
        solver_vars=["nuTilda"],
        relaxation={"nuTilda": 0.5},
        residual_controls=["nuTilda"],
    )
