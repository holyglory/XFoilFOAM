# Confirmed boundaries for solver evidence storage

These assumptions come from the user-provided project guardrails and the approved
progressive-polars work. They do not introduce a new access policy.

- The configured upstream instance owns remote-work identity and scheduling.
  A scheduling promise is not solver evidence, and a closed promise must not be
  reopened or fulfilled merely to store historical evidence.
- Remote evidence must retain its trusted source instance, exact immutable
  identity, byte size, checksum, and provenance. Conflicting content must not
  overwrite local canonical truth.
- Upstream sync, admin-session, and OAuth secrets remain server-side. Browser
  clients never receive upstream credentials. Existing API authentication, not
  a UI screen, enforces access.
- Solver evidence, accepted CFD points, NeuralFoil predictions, and composite
  estimates are distinct. Storing rejected or historical evidence does not
  authorize publication as accepted CFD.
- Local archive deletion requires verified remote custody and a fresh restore
  of the exact immutable archive generation. Missing or corrupt evidence stays
  retained; it is not replaced with invented data.

The closed-assignment storage path must preserve these boundaries and the
existing registered-worker ownership checks. New trust principals, anonymous
access, credential distribution, or relaxed archive verification are outside
this implementation and require a separate confirmed decision.
