"""Flow physics helpers: Reynolds number, freestream turbulence, AoA geometry."""
from __future__ import annotations

import math
from dataclasses import dataclass

CMU = 0.09  # standard k-epsilon/k-omega constant


def reynolds(speed: float, chord: float, nu: float) -> float:
    return speed * chord / nu


def mach(speed: float, speed_of_sound: float) -> float:
    return speed / speed_of_sound


def freestream_k(speed: float, intensity: float) -> float:
    """Turbulent kinetic energy from intensity I: k = 1.5 (I |U|)^2."""
    return 1.5 * (intensity * speed) ** 2


def freestream_omega(k: float, nu: float, viscosity_ratio: float) -> float:
    """Specific dissipation rate from the target nut/nu ratio (nut = k/omega)."""
    nut = viscosity_ratio * nu
    return k / nut


def freestream_epsilon(k: float, omega: float) -> float:
    """epsilon = Cmu * k * omega."""
    return CMU * k * omega


def freestream_nut(k: float, omega: float) -> float:
    return k / omega


def freestream_nutilda(nu: float, viscosity_ratio: float) -> float:
    """Spalart-Allmaras modified viscosity; for the freestream nuTilda ~ a few * nu."""
    # SA: nut = nuTilda * fv1; for the freestream nuTilda is commonly set to 3-5 nu.
    return max(viscosity_ratio, 3.0) * nu


def transition_re_theta_t(intensity: float) -> float:
    """Freestream transition momentum-thickness Reynolds number (Menter-Langtry).

    Used to initialise the ``ReThetat`` field of the k-omega SST-LM transition model
    from the turbulence intensity Tu (fraction). Correlation (Tu in %):
        Tu <= 1.3 : 1173.51 - 589.428 Tu + 0.2196/Tu^2
        Tu  > 1.3 : 331.50 (Tu - 0.5658)^-0.671
    """
    tu = max(intensity * 100.0, 0.03)  # percent, floored to avoid the 1/Tu^2 blow-up
    if tu <= 1.3:
        re = 1173.51 - 589.428 * tu + 0.2196 / (tu * tu)
    else:
        re = 331.50 * (tu - 0.5658) ** (-0.671)
    return max(re, 20.0)


def shedding_period(speed: float, chord: float, strouhal: float = 0.2) -> float:
    """Estimated vortex-shedding period T = c / (St U) for sizing transient runs."""
    return chord / (strouhal * max(speed, 1e-9))


def first_cell_height_for_yplus(target_yplus: float, speed: float, chord: float, nu: float) -> float:
    """Wall-normal first-cell *height* [m] to achieve a target y+ (flat-plate estimate).

    Uses Cf = 0.026 / Re_c^(1/7), u_tau = U sqrt(Cf/2), y1 = y+ nu / u_tau, and a
    cell height of 2*y1 so the first cell centroid sits at ~y1.
    """
    re_c = max(reynolds(speed, chord, nu), 1.0)
    cf = 0.026 / re_c ** (1.0 / 7.0)
    u_tau = speed * math.sqrt(cf / 2.0)
    y1 = target_yplus * nu / u_tau
    return 2.0 * y1


@dataclass(frozen=True)
class FreestreamVector:
    """Velocity components and lift/drag unit directions for a given AoA."""

    ux: float
    uy: float
    uz: float
    lift_dir: tuple[float, float, float]
    drag_dir: tuple[float, float, float]


def freestream_vector(speed: float, aoa_deg: float) -> FreestreamVector:
    """Rotate the freestream by AoA in the x-y plane (mesh stays fixed).

    Drag acts along the freestream direction, lift normal to it.
    """
    a = math.radians(aoa_deg)
    ux = speed * math.cos(a)
    uy = speed * math.sin(a)
    drag_dir = (math.cos(a), math.sin(a), 0.0)
    lift_dir = (-math.sin(a), math.cos(a), 0.0)
    return FreestreamVector(ux=ux, uy=uy, uz=0.0, lift_dir=lift_dir, drag_dir=drag_dir)
