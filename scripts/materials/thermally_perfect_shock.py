import math
from dataclasses import dataclass

from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState
try:
    from .oblique_shock import DetachedShockError, ObliqueShock
except ImportError:
    from oblique_shock import DetachedShockError, ObliqueShock


@dataclass(frozen=True)
class ThermallyPerfectShock(ObliqueShock):
    temperature_upstream_k: float
    gas_constant: float
    gamma_downstream: float
    entropy_change_over_R: float


def enthalpy_change(gas: GasThermodynamics, lower: float, upper: float) -> float:
    gas.heat_capacity_at(lower)
    gas.heat_capacity_at(upper)
    if upper < lower:
        return -enthalpy_change(gas, upper, lower)
    if gas.nasa7 is None:
        return gas.heat_capacity_at(lower) * (upper - lower)
    common = gas.nasa7.common_temperature_k
    limits = [lower, *([common] if lower < common < upper else []), upper]
    integral = 0.0
    for start, end in zip(limits, limits[1:]):
        coefficients = gas.nasa7.coefficients_at((start + end) / 2)
        integral += (end - start) * sum(
            coefficients[degree] * sum(end ** (degree - power) * start ** power for power in range(degree + 1)) / (degree + 1)
            for degree in range(5)
        )
    if lower < common <= upper:
        difference = [high - low for high, low in zip(gas.nasa7.high_coefficients, gas.nasa7.low_coefficients)]
        integral += difference[5] + sum(difference[degree] * common ** (degree + 1) / (degree + 1) for degree in range(5))
    return gas.gas_constant * integral


def entropy_change_over_R(gas, lower, upper, pressure_ratio):
    if gas.nasa7 is None:
        return gas.heat_capacity_at(lower) / gas.gas_constant * math.log(upper / lower) - math.log(pressure_ratio)
    return gas.nasa7.entropy_ratio(upper) - gas.nasa7.entropy_ratio(lower) - math.log(pressure_ratio)


def _normal_ratios(gas, normal_mach, temperature):
    if normal_mach <= 1 + 1e-12:
        return 1.0, 1.0, temperature
    velocity_squared = normal_mach ** 2 * gas.gamma_at(temperature) * gas.gas_constant * temperature
    thermal_velocity = velocity_squared / gas.gas_constant
    if not math.isfinite(velocity_squared):
        raise ValueError("Shock conditions exceed the finite reference domain")

    def downstream(compression):
        if compression in (1.0, thermal_velocity / temperature):
            return temperature
        return temperature + (compression - 1) * (thermal_velocity - temperature * compression) / compression ** 2

    def residual(compression):
        changed = downstream(compression)
        average_cp = gas.heat_capacity_at(temperature) if changed == temperature else enthalpy_change(gas, temperature, changed) / (changed - temperature)
        return average_cp * (thermal_velocity - temperature * compression) - velocity_squared * (compression + 1) / 2

    lower, upper = 1.0, thermal_velocity / temperature
    if residual(lower) <= 0 or residual(upper) >= 0:
        raise ValueError("No compressive shock root is bracketed")
    for _ in range(80):
        middle = (lower + upper) / 2
        if residual(middle) > 0:
            lower = middle
        else:
            upper = middle
    compression = (lower + upper) / 2
    pressure_ratio = 1 + thermal_velocity / temperature * (1 - 1 / compression)
    return compression, pressure_ratio, downstream(compression)


def _reference(gas, mach, temperature, beta):
    compression, pressure_ratio, downstream_temperature = _normal_ratios(gas, mach * math.sin(beta), temperature)
    upstream_speed = mach * gas.speed_of_sound(ThermodynamicState(temperature_k=temperature, pressure_pa=101325))
    normal_velocity = upstream_speed * math.sin(beta) / compression
    tangential_velocity = upstream_speed * math.cos(beta)
    turning = beta - math.atan2(normal_velocity, tangential_velocity)
    downstream_speed = math.hypot(normal_velocity, tangential_velocity)
    gamma_downstream = gas.gamma_at(downstream_temperature)
    downstream_mach = downstream_speed / math.sqrt(gamma_downstream * gas.gas_constant * downstream_temperature)
    entropy = entropy_change_over_R(gas, temperature, downstream_temperature, pressure_ratio)
    scale = gas.heat_capacity_at(temperature) * temperature + upstream_speed ** 2 / 2
    energy_error = abs(enthalpy_change(gas, temperature, downstream_temperature)
                       + (downstream_speed ** 2 - upstream_speed ** 2) / 2) / scale
    if energy_error > 1e-9 or entropy < -1e-9 or not all(math.isfinite(value) for value in (downstream_mach, entropy, energy_error)):
        raise ValueError("Reference shock violates energy or entropy admissibility")
    return ThermallyPerfectShock(mach, gas.gamma_at(temperature), math.degrees(turning), math.degrees(beta), downstream_mach,
                                 pressure_ratio, compression, downstream_temperature / temperature,
                                 temperature, gas.gas_constant, gamma_downstream, entropy)


def normal_shock(gas: GasThermodynamics, mach: float, temperature: float) -> ThermallyPerfectShock:
    if isinstance(mach, bool) or not math.isfinite(mach) or mach <= 1:
        raise ValueError("Normal shock requires finite supersonic Mach")
    gas.heat_capacity_at(temperature)
    return _reference(gas, mach, temperature, math.pi / 2)


def weak_thermally_perfect_shock(gas: GasThermodynamics, mach: float, deflection_deg: float, temperature: float) -> ThermallyPerfectShock:
    if (isinstance(mach, bool) or isinstance(deflection_deg, bool) or not math.isfinite(mach) or not math.isfinite(deflection_deg)
            or mach <= 1 or not 0 <= deflection_deg < 90):
        raise ValueError("Attached shock requires finite supersonic Mach and nonnegative turning below ninety degrees")
    gas.heat_capacity_at(temperature)
    mach_angle = math.asin(1 / mach)
    if deflection_deg == 0:
        return _reference(gas, mach, temperature, mach_angle)
    lower, upper = mach_angle, math.pi / 2
    for _ in range(60):
        left = lower + (upper - lower) / 3
        right = upper - (upper - lower) / 3
        if _reference(gas, mach, temperature, left).deflection_deg < _reference(gas, mach, temperature, right).deflection_deg:
            lower = left
        else:
            upper = right
    maximum_beta = (lower + upper) / 2
    if deflection_deg > _reference(gas, mach, temperature, maximum_beta).deflection_deg + 1e-10:
        raise DetachedShockError("The requested turning exceeds the material's attached-shock limit")
    lower, upper = mach_angle, maximum_beta
    for _ in range(70):
        middle = (lower + upper) / 2
        if _reference(gas, mach, temperature, middle).deflection_deg < deflection_deg:
            lower = middle
        else:
            upper = middle
    return _reference(gas, mach, temperature, (lower + upper) / 2)
