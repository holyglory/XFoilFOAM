# URANS recovery experiment — 2026-08-19

This is the outcome-blind cohort registration for the v14 recovery experiment.
The quality gates are unchanged. Every control starts from time zero through
the existing point-correction transaction and ordinary scheduler. An 8-hour
continuation is permitted only from that control's typed, exact restartable
budget-stop generation and verified restart archive.

## Ineligible original discovery sources

The first remote candidates were rejected as experiment sources before any
new CFD was submitted. Their mirrored revisions referenced boundary-profile
IDs that do not exist on the remote solver, and the same exact cells were not
yet present on the authoritative hub. No missing profile was created or
substituted.

| Key | Remote result attempt | Reason ineligible |
| --- | --- | --- |
| OD1 | `52fca8b0-b402-4622-a8d7-ce5555bc60b5` | incomplete remote profile graph |
| OD2 | `58a2cdf7-6844-4914-8333-4f229a1450dd` | incomplete remote profile graph |
| OD3 | `8ff922ae-c8b9-4f01-ae61-9f6353a06c52` | incomplete remote profile graph |
| OD4 | `ae961bc6-f799-4455-8033-5797cd402da3` | incomplete remote profile graph |

## Discovery cohort

All four sources are hub-owned, latest rejected generations with complete
flow, geometry, boundary, scheduling, output, and solver-implementation
references. The fresh control copies the exact pinned settings: standard
blockMesh C-grid (130/80/60, 15c far field, 12c wake, y+=1) and k-omega SST
with linearUpwind, 3000 iterations, tolerance 1e-5, transient cycles 10,
discard 0.4, and max Courant 4. FAST fidelity remains the ordinary v14
half-resolution derived mesh and 4-hour budget.

| Key | Stratum | Source result / attempt | Physical cell | Fresh correction / revision / request |
| --- | --- | --- | --- | --- |
| D1 | low-angle budget stop | `7deac466-92be-4df9-b646-4518170edbd3` / `61bad55a-8bb2-4d4a-a541-8a8eaf70c924` | AG11, Re 102347, M 0.088129, alpha 6 | `eb572952-9328-419d-b7fd-685b2984045b` / `c801adbf-3089-4ce6-a26c-3e58bf321a3c` / `3df53dfc-fff5-4afc-86fb-2358618857ed` |
| D2 | high-angle budget stop | `1383292b-4ca0-4109-8497-a39f63ae6cc8` / `5049fbec-7f7e-415e-80e7-493da919274c` | AG04, Re 102347, M 0.088129, alpha 18 | `f2cdfb08-a1c6-41e6-acdd-17e110e8d448` / `9b93e032-ac77-4c05-a0c5-ffb4239b97b1` / `6791bf30-2a0f-4c99-b468-a6d9095b5619` |
| D3 | periodicity contamination | `59a5f1eb-9d45-40e5-a434-198d102e67f6` / `576585f4-358b-43d6-8564-fbcb1e21ba81` | AG03, Re 102347, M 0.088129, alpha 18 | `d3b1f92b-3023-46f7-8fe7-f5911a66c621` / `35a72d94-4b3b-4349-8ba1-a6928f9dd461` / `cdaae2de-b3e1-463b-837b-6ad3cfac5641` |
| D4 | cycle exhaustion at distinct Re/Mach | `06a25c20-85de-4364-9066-83aa666762bb` / `615deb5f-08ab-4b00-81b9-941029cf978a` | AG04, Re 307041, M 0.264387, alpha 20 | `dc56abce-8ffe-40d6-ac22-aad1d5cdde76` / `4e3c0c12-b570-4bd2-8c06-9fc0752efd6c` / `9c604d73-ec5a-4b80-a1ff-228858bc1eff` |

Predeclared replacements, used only if fewer than two discovery controls
produce a legitimate restartable budget stop:

- R1 low-angle budget stop: result `ecb8be1e-810c-4175-97a3-6e96b201272e`,
  attempt `6f107bb4-cf76-4147-95ee-cc6129e7a9f3` (AG03, alpha -3).
- R2 high-angle budget stop: result `2d18ceab-d1ad-46e2-bceb-4d41688355d9`,
  attempt `5724ff95-69fa-4c16-96c7-fca59dbf7c84` (AG08, alpha 18).

## Held-out cohort

These rows were preflighted read-only: exact/latest ownership, rejected and
repairable state, and every immutable profile/implementation reference is
present. No correction, request, or job exists for them. They remain untouched
until the discovery strategy and pass/fail rules are frozen.

| Key | Stratum | Result / attempt | Physical cell |
| --- | --- | --- | --- |
| V1 | low-angle budget stop | `d698ccae-c25a-4bbb-9a77-460de7e036e2` / `4aca1d4c-143e-451d-9190-f30d9a36b807` | AG03, Re 102347, alpha 6 |
| V2 | high-angle budget stop | `f498090c-e2fe-4843-becc-f984e7b1bc8c` / `f8805724-41bc-4917-bebb-5961b47146f3` | AG03, Re 102347, alpha 17 |
| V3 | periodicity contamination | `391f3abb-a190-4e0c-b043-1bc06f1744cc` / `165fe767-f27a-4431-bd35-572a933b72a4` | A18, Re 102347, alpha 18 |
| V4 | cycle exhaustion at distinct Re/Mach | `e14487ab-f8b6-40c0-8e89-c6fec9d9ff03` / `93e9982c-e4b8-428f-8ceb-5aa06fdc43b4` | AG04, Re 307041, alpha 19 |

## Paired lineage and decision rule

For each discovery key, retain:

`source attempt -> fresh control request/job/attempt -> exact restartable
checkpoint/archive -> 8-hour continuation request/job/attempt`.

The continuation changes only the per-job wall budget to 28,800 seconds and
resumes the same case. Accepted, corrupt, exhausted, non-restartable, or
differently configured controls receive no continuation. Outcomes are compared
on accepted immutable evidence, retained simulated/convective time, force
samples, real field frames, exact gate reason, and CPU-hours. No result is
manually accepted and no held-out result is used to choose the strategy.
