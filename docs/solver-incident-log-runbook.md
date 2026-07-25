# Solver incident log

The solver incident log is the operator and AI-agent view of immutable
recovery events. It supplements `CompletionLedger.md`; it does not replace the
ledger and never edits it automatically.

## Surfaces

- Admin Health shows one compact **Solver recovery** status bar. Expanding it
  opens the newest-first event log. Expanding one event reveals its exact
  solver identity, recovery version, owner, job/attempt references, occurrence
  key, timestamps, recurrence counts, and stored metadata.
- `GET /api/admin/solver-incidents?sinceHours=24&limit=100` returns the same
  authenticated data as structured JSON. Open events remain present even when
  older than `sinceHours`; that window limits resolved history only.
- `GET /api/admin/health` includes `solverIncidentEvents` for the rendered
  Health surface.

Both endpoints use the normal admin pre-handler. Agents must use the owner's
authenticated browser/admin session; there is no unauthenticated diagnostic
backdoor and no sync or OAuth secret is exposed.

## Agent reconciliation with `CompletionLedger.md`

1. Fetch the structured event log before a solver reliability investigation.
2. Group unresolved events by `stage`, `reason`,
   `solverImplementationKey`, and `remediationVersion`.
3. Compare those groups with active solver/reliability work already recorded in
   `CompletionLedger.md`.
4. Add or amend one ledger item for an unresolved implementation or operational
   gap. Do not create one ledger item per physical point.
5. Link the runtime evidence using the occurrence/event ids and recovery
   version. Preserve the immutable incident rows even after the ledger item is
   resolved.
6. Remove the ledger item only after the correction is implemented, its
   regression passes, the deployment is verified through the affected surface,
   and the corresponding runtime pattern is resolved or superseded by a
   source-pinned remediation generation.

`userActionRequired` is always `false` for this log. A `system_attention`
event means the solver/controller owner must correct a recurring pattern; it
must never be presented as an instruction for the administrator to retry,
change setup, or investigate the implementation.
