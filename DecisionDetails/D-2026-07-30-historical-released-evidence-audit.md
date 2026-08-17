# D-2026-07-30 — Historical released-evidence audit is non-publishing

## Decision

Allow an operator to reduce one released completed URANS archive only by
providing the exact result id, result-attempt id, and current verified
generation-pinned GCS/Zstandard archive id.  Stage its immutable scientific
interpretation with the distinct `historical_archive_audit` source and append
the reducer outcome in the same transaction as a historical-audit decision.
The audit has no authority to select a canonical interpretation, update a
result pointer, rebuild a polar cache, refresh campaign progress, create a
recovery action, request URANS, or create verification work.  A continuation
can be recorded only as a one-to-three-period `continue_exact_case` advisory.
It is not a background retry class: a reducer/store failure settles that audit
receipt terminally, and another read requires a new explicit invocation with
the same three immutable identities.  If the released result is intentionally
made live later, only a separate `archive_backfill` interpretation with normal
queue authority may become canonical; an audit interpretation never suppresses
that work or becomes eligible for a canonical selection. A parked publication
receipt may revive only when the exact archived attempt is current again (or
the existing exact PRECALC lineage proves its authority). Revival detaches any
child that failed solely because the result was released and creates a fresh
normal child, while an already accepted exact normal child is retained and
replays only its canonical selection without another reducer read. A different
newer generation leaves the parked receipt inert.

The audit run itself is source-bound: its typed no-publication contract, exact
result, attempt, archive, and reducer version cannot be changed after
creation. Each audit run can materialize exactly one append-only decision only
through its one claimed child execution receipt. The child must be inserted as
an unclaimed `pending` receipt, transition to `hydrating` with a live lease
under a locked `running` parent audit,
and settle its scientific terminal state only while that lease is still live.
Settlement writes the child receipt first and the decision second in the
interpretation transaction, then re-reads their exact join before commit. A
deferred child-to-decision foreign key, receipt shape/index, lifecycle, and
paired child/run validators reject a decision without execution, a terminal
scientific child without a decision, retargeted receipt identity, a second
child, a child lease under a terminal parent, or a stale terminal writer.
Provider/pointer failures that did not
produce an authenticated reducer result settle as operational `failed` records,
not fabricated `missing_evidence` decisions. A deleted result/attempt may
cascade its child and decision while retaining the audit run as a
non-executable forensic record; either child-level or owner-level cascade
handling marks a retained planned/running/completed audit immediately `failed`
with the explicit incomplete-source reason. This enforces lifecycle provenance for ordinary
application writers; a privileged database superuser can still bypass database
triggers, so database access remains a separate trust boundary and not proof
that remote reducer I/O occurred. The forward migration takes
`ACCESS EXCLUSIVE MODE NOWAIT` locks in child → decision → run → attempt order while it
backfills only unambiguous legacy pairs. This prevents install/retarget races
and makes concurrent writers retry safely rather than accepting a partial
forensic fact.

## Why

The historic GCS migration has valuable raw evidence whose original result was
intentionally released from live publication.  Three plausible approaches
were considered:

1. Reopen the result and run the ordinary archive-publication queue.  This
   would reuse the existing reducer path but could silently change a public
   polar or campaign accounting.
2. Perform a read-only report only.  This avoids mutation but loses the
   versioned reproducible interpretation needed to compare the retained
   archive scientifically.
3. Use a separate exact-source audit receipt and provenance class.  This
   retains append-only scientific evidence while the selector and scheduler
   reject audit provenance.

Option 3 is selected.  The audit-stage transaction repeats the current,
completed, solved FAST/FINAL URANS and complete GCS archive proof while
holding its exact receipt and released result.  The database trigger repeats
the run contract and provenance checks for decision inserts, while the
canonical-selection and projection gates reject audit provenance outright.
Writing a decision alone was rejected because it could claim a scientific
outcome without proving that the exact child execution happened; trusting an
application callback alone was rejected because a no-op could stage an orphan
interpretation. The child-first paired receipt makes both states impossible at
commit while preserving source-owner cascades. This is more work than a report,
but it preserves immutable evidence without giving an automated history pass
the power to publish or schedule solver work.
