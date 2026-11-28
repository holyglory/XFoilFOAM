# Sealed precise dispatch cutover

Deploy the hub and HZ receiver control-plane changes together through the guarded
wrappers, with the expired-assignment intake changes from `d95ab882`. A mixed
old/new pair can reject new work: the old hub substitutes a transient solver for
a sealed steady choice, while the old receiver expects that substitution.
The OpenFOAM solver images and precise numerical/acceptance settings do not change.
Keep the v1 shared-mesh march at one lane; the transient default remains four ranks.
The old precise case-concurrency benchmark override is ignored.

An already mirrored historical `7f04bf99` request replays its exact stored envelope
and request. Existing submission intent leads to observation, terminal reporting,
and settlement; it does not authorize a replacement request. Historical accepted
URANS, its classification, evidence signature, and stable result/attempt identifiers
are retained. Future steady dispatch does not rewrite or reclassify those rows.

A not-yet-mirrored legacy steady-revision/transient-request pair has no new start
authority. Active mismatches, unrelated solver or numerical mismatches, failed
upstream authentication, and renewed assignments are refused. The one compatibility
path freshly reads the exact signed assignment from the authenticated upstream,
requires an expired promise and the specific historical stage-3 substitution, and
creates a durable **stop-only** identity. It cannot be submitted, including after
promise renewal. The normal engine cancellation API must provide the genuine native
unregistered-execution fence; an inspection/cancellation failure leaves the identity
and ownership outstanding. No synthetic stop receipt, inferred absence, or new CFD
result is created. Its terminal report follows the normal custody/settlement path.

A historical checkpoint continuation stays bound to its original request and exact
saved case. If historical actual execution was transient while its recorded revision
selected steady, the continuation receives an actual transient execution identity;
the original revision and evidence remain unchanged.

Production end-to-end verification remains with the parent after the combined
rollout. In particular, verify candidate `af2605a4-319a-49db-a5ac-b8ab69e642ac`:
no solver submission, a real native cancellation fence, retained request/evidence,
and normal acknowledged settlement. Local protocol fixtures do not establish that
production receipt or authorize deployment from this task.
