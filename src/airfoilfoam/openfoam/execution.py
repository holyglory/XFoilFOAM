"""Request-scoped flow equations without mutating the shared runtime dialect."""

from dataclasses import dataclass, replace

from ..models import PolarRequest
from ..thermodynamics import GasThermodynamics, ThermodynamicState
from .dialects import dialect_for_runner


@dataclass(frozen=True)
class CompressibleExecution:
    family: str
    gas: GasThermodynamics
    state: ThermodynamicState
    turbulent_prandtl: float


def configure_flow_execution(runner, request: PolarRequest) -> None:
    family = request.solver.flow_solver_family
    if family is None:
        return
    base = dialect_for_runner(runner)
    if base.identity.distribution != "opencfd" or base.identity.version != "2606":
        raise ValueError("Progressive flow execution requires the OpenCFD 2606 adapter")
    if not family.startswith("rho"):
        return
    gas, state, prandtl = request.fluid.gas, request.flow_state, request.solver.turbulent_prandtl
    if gas is None or state is None or prandtl is None:
        raise ValueError("Compressible execution is missing its resolved gas state")
    runner.flow_execution = CompressibleExecution(family, gas, state, prandtl)
    transient = "rhoCentralFoam" if family == "rhoCentralFoam" else "rhoPimpleFoam"
    runner.flow_dialect = replace(
        base,
        steady_solver_command="rhoCentralFoam" if family == "rhoCentralFoam" else "rhoSimpleFoam",
        transient_solver_command=transient,
        control_solver_value_steady="rhoCentralFoam" if family == "rhoCentralFoam" else "rhoSimpleFoam",
        control_solver_value_transient=transient,
        y_plus_command=f"{family} -postProcess -func yPlus -latestTime",
    )


def is_compressible(runner) -> bool:
    return isinstance(getattr(runner, "flow_execution", None), CompressibleExecution)


def is_density_based(runner) -> bool:
    context = getattr(runner, "flow_execution", None)
    return isinstance(context, CompressibleExecution) and context.family == "rhoCentralFoam"
