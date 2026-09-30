INSERT INTO "solver_implementations" (
  "id", "key", "family", "distribution", "release_version",
  "method_family", "adapter_contract_version", "numerics_revision",
  "capabilities", "upstream_url", "license_spdx"
) VALUES (
  '2f8bc764-09ae-4ff3-8fd2-260600000002',
  'openfoam:opencfd:2606:adapter-v1:numerics-v2',
  'openfoam', 'opencfd', '2606', 'finite_volume_rans_urans', 1, '2',
  '{"methodKeys":["openfoam.rans","openfoam.urans"],"dimensionality":["2d"],"evidence":["coefficients","mesh","fields","logs"],"meshRecoveryVersion":3}'::jsonb,
  'https://gitlab.com/openfoam/core/openfoam/-/tree/OpenFOAM-v2606',
  'GPL-3.0-or-later'
);
--> statement-breakpoint
INSERT INTO "solver_execution_pools" (
  "id", "slug", "name", "solver_implementation_id", "routing_key",
  "capacity_kind", "capacity_limit", "enabled", "metadata"
) VALUES (
  '3f8bc764-09ae-4ff3-8fd2-260600000002',
  'openfoam-opencfd-2606-numerics-2', 'OpenFOAM OpenCFD 2606 · numerics 2',
  '2f8bc764-09ae-4ff3-8fd2-260600000002',
  'openfoam-opencfd-2606-numerics-2', 'cpu_slots', NULL, false, '{}'::jsonb
);
