# Stopped hub report storage

The hub report-storage worker copies signed transport reports for cancelled, stopped remote executions with an expired or cancelled promise, the unresolved-delivery disposition, no live ingestion lease and no running attempt. It uses the ordinary GCS archiver for reports that already meet its scientific and raw ownership rules.

For other signed snapshots, the worker first copies and reopens a versioned manifest. Each object-valued scientific result has one immutable GCS object keyed by the SHA-256 of the exact PostgreSQL result text. A manifest preserves the original prefix and suffix surrounding the root result token. Null snapshots preserve the whole original. A generation pin includes its full decimal generation, compressed size, SHA-256 and CRC32C. The manifest also binds the dispatch, each sequence, the original PG body size/SHA, the independent application signature and the source inventory. Decimal spelling, unknown properties and Unicode round-trip exactly. Existing `jsonl` and worker `legacy-jsonl` archives keep their original formats and identities.

For a nonlatest report whose every point already appears in an earlier signed warm source with the same case and AoA, the worker may attach the verified manifest and replace the SQL body with its archived header. Historical null-result snapshots can also release once their empty inventory and progress receipt match. It preserves the latest report, the first warm source for a point, and actual scientific and diagnostic receipt owners as full SQL sources with verified GCS copies. A last SQL reference may release only the known protected hash used by an authenticated member, subject to references in both report tables.

## Deployment and selection

Install the forward archive-format constraint with the matching hub API and sweeper. The existing report-storage child starts the recurring service automatically on a verified hub with a configured evidence bucket. It checks the database, the serving API's advertised formats, and the actual API and sweeper readers before attaching the report. Every normal reader uses its own current generation read. Within a bounded page it can reuse an already authenticated scientific generation. HZ keeps its existing registered reader. The feature requires no additional cloud identity.

Production Compose supplies these settings.

| Setting | Default | Meaning |
|---|---|---|
| `AIRFOILFOAM_STOPPED_SHARED_REPORT_SCOPE` | `all` | Scan closed owners fairly. An execution UUID limits work to one owner. `off` pauses this service. |
| `AIRFOILFOAM_STOPPED_SHARED_REPORT_RECEIPTS` | `/data/airfoilfoam/report-archives/shared-result-v1` | Durable, private directory on the existing results volume. |
| `AIRFOILFOAM_HUB_REPORT_API_URL` | `http://node-api:4000` | Internal address used to check the serving hub reader. |

Each turn inspects up to 32 report keys from one owner and writes at most one bounded manifest. Different owners take turns. The reader caps each report and scientific result at 64 MiB of original text and each page at 128 MiB of reconstructed reports. Larger originals remain intact and produce an explicit error. Runtime role, ownership, signature, source, object or reader disagreements preserve the SQL form. A confirmed complete frontier sleeps between checks and resumes on changes to the signed report/progress frontier or scientific/diagnostic receipts.

## Receipts and recovery

The worker persists a verified page receipt before pointer attachment and commits the archive member rows, compact header and reference release together. A crash before attachment leaves the original in SQL. A restart after attachment follows the actual catalog rows. Content-addressed result uploads use create-only generation preconditions. A concurrent writer reopens the existing generation and verifies its exact original; a missing or corrupt dependency fails the operation.

Under each execution directory, `verified/` holds the original proof with result and manifest pins, `receipts/` holds page outcomes, and `windows/` and `cursor.json` record bounded progress. `totals.json` reconciles verified distinct generation bytes, members with actual SQL pointers, and the original versus current report-field sizes. SQL reference sizes and any actually deleted protected result values are measured separately. A local SQL release measurement counts only if its exact generation and all its canonical member pointers committed. RSS is recorded in bytes. SQL value reduction, live protected payloads, unique cloud bytes and operating-system allocation are different measurements.

The service creates no scientific, diagnostic or raw custody receipt, updates no lease or promise, and publishes no coefficients or fits. Legitimate late transfers still go through the existing registered evidence endpoints.
