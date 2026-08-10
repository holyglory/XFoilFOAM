# User Issue Ledger: Operations / deployment source

| ID | Applies to | Mistake pattern | Required behavior | Prevention and verification |
| --- | --- | --- | --- | --- |
| UIL-OPERATIONS-DEPLOYMENT-SOURCE-001 | Production branch promotion and visible admin behavior | Deploying a divergent recovery branch removed previously delivered remote-solver health from the production Health page even though the remote solver remained healthy. | Production releases come from `master`. A candidate that is not a descendant of the currently deployed source must be explicitly reconciled against that source, and previously delivered operator-visible health behavior must not disappear silently. | Before promotion, compare the candidate and deployed source revisions, run the focused remote-fleet API/UI regressions, request the exact Health route through a browser-equivalent surface, and verify both production roles report the promoted `master` revision. |
