# NACA 0012 reference bytes

Original public data from the NASA-linked
[Turbulence Modeling Resource](https://tmbwg.github.io/turbmodels/naca0012_val.html):

- `CLCD_Ladson_expdata.dat`: Ladson, NASA TM 4074 (1988), tripped force runs at reported Mach 0.15 and Reynolds 6 million. Keep the 80-, 120-, and 180-grit runs separate.
- `n0012points_superbig_clust_fix.dat`: the modified, sharp-trailing-edge TMR benchmark geometry, not measured geometry from the experiment. The original lower-surface-first order and all source bytes are retained.

The loader pins each file's byte count and SHA-256. Import unchanged public bytes
with `python -m scripts.materials.naca0012_reference --fetch --directory tests/fixtures/naca0012`.
Existing mismatched files are refused, never replaced.

The force file does not provide pitching moment, trip location, equivalent
roughness, or measurement uncertainty. None is inferred. Near-stall experimental
two-dimensionality is not established. Comparisons using the modified benchmark
geometry and a smooth fully turbulent model are exploratory, not exact-target
calibration or a physical accuracy certificate. No data here is seeded into the
application's catalog or solver-evidence tables.
