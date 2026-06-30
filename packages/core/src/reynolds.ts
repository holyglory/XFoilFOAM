// Reynolds / speed / Mach relations. Mirrors src/airfoilfoam/physics.py:reynolds
// (Re = U·c/ν) so a boundary condition's target Re maps deterministically to the
// freestream speed the solver runs at, given a reference chord and the medium's ν.

export function reynolds(speed: number, chord: number, nu: number): number {
  return (speed * chord) / nu;
}

/** Invert Re = U·c/ν → U = Re·ν/c. Exact given a medium (ν) and reference chord. */
export function speedForReynolds(re: number, chord: number, nu: number): number {
  return (re * nu) / chord;
}

export function machFromSpeed(speed: number, speedOfSound: number): number {
  return speed / speedOfSound;
}
