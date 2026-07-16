# D-2026-07-16-campaign-cell-evidence-dialog

## Production evidence

The production campaign cell for 20-32C at Re≈102k displayed seven points under
`FAILED POINTS`. Two angles retained two rejected steady-RANS attempts and two
rejected preliminary-URANS evidence records. Five retained two rejected RANS
attempts, one rejected preliminary record, and a later evidence-less
same-obligation continuation. No accepted full-URANS generation existed. The
same panel called the heterogeneous rows `3 attempts` or `4 attempts` and
printed raw `solver evidence rejected` classifications, so a user could not
tell whether RANS had merely handed off normally, preliminary URANS was still
running, or automatic recovery had ended without publishable evidence.

The side panel also behaved visually like a modal but did not own document
scroll. Wheel input moved the hidden campaign page behind it, and stacked
solver-evidence dialogs did not have a complete focus/scroll ownership
contract. The panel showed polar charts but not the stored airfoil shape that
identified the selected revision.

## Decision and alternatives

Ordinary RANS interruption history remains available through the existing
campaign-failure read model, under the truthful `RANS INTERRUPTIONS` label.
Automatic preliminary-URANS obligations use a separate exact read model. Its
headline conserves affected campaign points, including symmetric derived
angles, while every source obligation reports separately:

- physical CFD runs used and the configured physical-run limit;
- preliminary evidence records by recorded fidelity;
- infrastructure or setup submissions that ended before physical CFD and did
  not consume that budget;
- an active queued/running physical run;
- a terminal evidence-less continuation only when the ordered sequence proves
  that a classified incomplete preliminary window preceded the terminal
  continuation.

Rejected alternatives were:

- Rename `FAILED POINTS` but keep the aggregate attempt count. This remains
  wrong because result-attempt rows, engine submissions, and physical CFD runs
  have different meanings and budgets.
- Hide the rows after automatic escalation. This removes the confusion but also
  removes the immutable explanation for why no publishable point exists.
- Display raw solver classifications and job metadata. This preserves audit
  detail but makes users interpret internal fidelity, submission, and
  classification mechanics.
- Treat every evidence-less terminal submission as an interrupted continuation.
  Submission order can be reversed or unrelated; the inference is valid only
  when the latest consuming submission is terminal and evidence-less and an
  earlier consuming submission has exact preliminary evidence classified as
  requiring further integration.

The selected model preserves the full evidence history while translating it
into the automatic recovery journey: steady RANS handoff is normal, preliminary
URANS may be queued/running, and `results unavailable` means the bounded
automatic path ended without publishable evidence. It does not imply human
review or a setup change.

The campaign cell is an accessible modal dialog. Opening it locks the document
at its exact scroll position, traps focus, and restores both when closed. A
nested result-evidence dialog becomes the top modal layer without releasing the
document lock, makes the underlying panel inert, owns Escape and Tab, then
restores focus to its trigger. The panel itself remains independently
scrollable within `100dvh`.

The selected airfoil's pinned detail payload is the only geometry source. A
small real contour identifies the airfoil beside its name, and an Airfoil tab
shows the same stored profile and real derived dimensions. No fallback or
synthetic shape is rendered.

## Prevention and verification

The API regression reproduces the production-like evidence sequence and proves
the read model distinguishes RANS, preliminary evidence, physical attempt
budget, non-physical submissions, active work, legacy unknown fidelity, and the
exact interrupted-continuation ordering. False-positive guards cover reversed
submission order and an active submitted physical attempt. Symmetry coverage
proves one source obligation can truthfully account for both requested campaign
angles without duplicating the execution budget.

The browser regression opens an independently seeded campaign cell and checks
document scroll lock, panel wheel scrolling at both bounds, focus trap and
restoration, nested modal reference counting, exact geometry paths for the
thumbnail and profile, keyboard tab behavior, same-chart zoom preservation, and
390×844 overflow. It also proves the automatic panel contains no `FAILED
POINTS`, bare mixed `attempts` count, or raw `solver evidence rejected` copy.
