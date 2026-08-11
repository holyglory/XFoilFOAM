# User Issue Ledger: Testing

| ID | Applies to | Mistake pattern | Required behavior | Prevention and verification |
| --- | --- | --- | --- | --- |
| UIL-TESTING-001 | Browser/UI verification skill selection | A production screenshot triggered formal layout verification even though the defect concerned status semantics and operational truth, with no concrete geometry risk. | Use formal browser-layout verification only for geometry, visibility, clipping, overlap, responsive fit, media rendering, or target-coverage risks. Copy, status semantics, runtime diagnosis, data correctness, and ordinary route checks use focused behavioral verification unless visual verification is explicitly requested or a concrete layout risk is identified. | Before loading a visual-verification skill, name the visual risk and the browser assertion that detects it. If neither exists, do not invoke the skill. |
