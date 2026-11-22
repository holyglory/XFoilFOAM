# Original attempt backups on a registered worker

The controller archives the exact PostgreSQL text of settled worker attempts under the worker's own 0207 identity. It uses the existing SSH aliases, the hub's confirmed metadata workload account and the canonical evidence bucket. The worker stores the immutable catalog receipt. The attempt payload, current result, interpretation, dispatch and delivery state remain available through their normal paths.

## Freeze and copy

Run in a pinned checkout of the same release as the operator helpers on both hosts. Use a private directory on durable controller storage. The SQLite database holds source identities, priority and verified generations. Compressed transfer bytes stay in bounded memory or the worker's temporary pack file.

```sh
originals() { python3 scripts/deploy/hz-attempt-originals.py "$@"; }
originals inventory --directory "$ORIGINALS_STATE" --until-complete
originals backup --apply --directory "$ORIGINALS_STATE" --until-complete \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
originals status --directory "$ORIGINALS_STATE"
```

To use an already frozen list, add `--scope "$FROZEN_JSONL"` to both inventory and backup. Each line contains `attemptId`, `sourceSha256` and the exact PostgreSQL `sourceByteSize`. The scope-file digest, HZ source instance, registered solver and SSH targets bind the checkpoint. A changed source fails closed. Without a supplied list, inventory keysets the live database to its initial high-water UUID, and a later explicit `inventory --refresh` revisits older keys. `--limit` bounds each page to 1–64 rows. The default decoded-source budget is 16 MiB. `--page-bytes` accepts up to the native 0207 limit of 32 MiB. A single original larger than the configured page budget requires raising that budget within the native limit. Use `--pages N` for a finite number of pages.

The worker verifies the actual producing job, local attempt and result association, configured upstream, registered instance, original worker submission intent and signed execution envelope. The hub independently checks the registered worker. For priority it binds the actual HZ point acknowledgment to the canonical hub attempt, result, job and original source hash and length. Priority selects the highest-volume exact matches first. Attempts with no hub result can still be copied when their HZ ownership and original bytes are proven. Open sources are deferred. An unproven owner remains separately visible in the inventory. Use `backup --retry-deferred` after open sources settle.

The full 0207 document contains its original attempt, result and job IDs. Object metadata and its content-addressed key also name the source instance. Identical local and hub UUID strings still belong to their respective instances. A matching hub payload does not replace the HZ receipt. The operator reuses exact HZ catalog entries and existing immutable generations and writes new objects conditionally. Each returned generation is read and authenticated, then recorded durably on the controller. Registration reads that pinned generation again and compares its owner, original PostgreSQL bytes and complete series inventory against HZ under the normal source locks. A lost registration reply resumes from the pinned proof. The worker's shared deployment lock covers one bounded registration page at a time.

This operation inserts only native 0207 archive receipts. It does not enable shortening or write working-volume duplicates while the original is inline. The status distinguishes measured source and history bytes, observed catalog insertions, existing receipts, deferred work and unregistered uploads. Read status from another shell while the job runs. A transient transport or deployment pause is retried in continuous-pass mode. An integrity or credential failure stops at the current checkpoint.
