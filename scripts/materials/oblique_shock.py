import math
from dataclasses import dataclass


NASA_WEDGE_REFERENCE = "https://www.grc.nasa.gov/www/wind/valid/wedge/wedge.html"


class DetachedShockError(ValueError):
    pass


@dataclass(frozen=True)
class ObliqueShock:
    mach_upstream: float
    gamma: float
    deflection_deg: float
    shock_angle_deg: float
    mach_downstream: float
    pressure_ratio: float
    density_ratio: float
    temperature_ratio: float


def weak_oblique_shock(mach: float, deflection_deg: float, gamma: float = 1.4) -> ObliqueShock:
    if not all(math.isfinite(value) for value in (mach, deflection_deg, gamma)) or mach <= 1 or gamma <= 1 or not 0 <= deflection_deg < 90:
        raise ValueError("An attached shock requires finite supersonic Mach, gamma above one and nonnegative turning below ninety degrees")
    mach_squared = mach * mach
    if not math.isfinite(mach_squared):
        raise ValueError("Mach number exceeds the numerical domain")
    mach_angle = math.asin(1 / mach)

    def turning(beta):
        numerator = 2 * (mach_squared * math.sin(beta) ** 2 - 1)
        denominator = math.tan(beta) * (mach_squared * (gamma + math.cos(2 * beta)) + 2)
        return math.atan(numerator / denominator)

    lower, upper = mach_angle, math.pi / 2
    for _ in range(100):
        left = lower + (upper - lower) / 3
        right = upper - (upper - lower) / 3
        if turning(left) < turning(right):
            lower = left
        else:
            upper = right
    maximum_beta = (lower + upper) / 2
    target = math.radians(deflection_deg)
    if target > turning(maximum_beta) + 1e-13:
        raise DetachedShockError("The requested turning exceeds the attached-shock limit")
    lower, upper = mach_angle, maximum_beta
    for _ in range(100):
        middle = (lower + upper) / 2
        if turning(middle) < target:
            lower = middle
        else:
            upper = middle
    beta = (lower + upper) / 2
    normal_squared = mach_squared * math.sin(beta) ** 2
    pressure_ratio = (2 * gamma * normal_squared - (gamma - 1)) / (gamma + 1)
    density_ratio = (gamma + 1) * normal_squared / ((gamma - 1) * normal_squared + 2)
    downstream_normal_squared = ((gamma - 1) * normal_squared + 2) / (2 * gamma * normal_squared - (gamma - 1))
    downstream_mach = math.sqrt(downstream_normal_squared) / math.sin(beta - target)
    return ObliqueShock(mach, gamma, deflection_deg, math.degrees(beta), downstream_mach,
                        pressure_ratio, density_ratio, pressure_ratio / density_ratio)
