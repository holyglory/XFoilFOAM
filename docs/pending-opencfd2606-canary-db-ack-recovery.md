# Pending OpenCFD 2606 canary DB-ACK recovery

`scripts/deploy/recover-pending-opencfd2606-canary-db-ack.sh` is the
incident-specific launcher for the failed 2026-07-17 r3 retention retry. It is
not a general deployment command. It accepts only the original bound 6338577
production symlink, a separately staged exact cd0967 current-source release,
all four immutable predecessor journals, the failed-r3 pristine marker tuple,
and one fully manifested reviewed r4 target tree.

## Transaction boundary

The launcher acquires `/tmp/airfoils-pro-deploy.lock` on descriptor 9 before it
reads mutable production state. An outer transaction may instead acquire the
same file on descriptor 9 and invoke the launcher with `DEPLOY_LOCK_HELD=1`.
The descriptor is inherited by the rebuild runner and remains locked across:

1. source, predecessor-journal, container/image, volume, pool, queue, and idle
   validation;
2. stopping the initially running `media-repair` service;
3. the fresh database backup, strong scratch restore, immutable off-VPS copy,
   and remote-download checksum proof;
4. collision-checked preservation of every replaceable r3 service image;
5. target image builds, migration, service recreation, repaired four-point
   canary, database cleanup acknowledgements, and cutover finalization.

The same Compose project name (`app`) and explicit project directory are used
throughout so the existing named PostgreSQL and results volumes remain the
deployment targets. `media-repair` returns to its initial running state only
after terminal success. A failed or interrupted transaction keeps
`media-repair` and the sweeper stopped and requests that the 2606 pool remain
disabled.

## Required bindings

Before invocation, set `CURRENT_SOURCE_DIR` to the exact manifested cd0967
release. It is neither the bound 6338577 symlink nor the r4 target. The source
contract verifies all three directories independently while continuing to
compute the reviewed target changeset from the original 6338577 baseline.

Re-inventory production while holding descriptor 9 and
supply the full 64-character container IDs and exact `sha256:` image IDs for
`api`, `worker`, `node-api`, `sweeper`, `media-repair`, and `postgres`. Supply
the exact results-volume identity digest and re-hash the latest failed
same-build replay journal immediately before use. Prefixes or values copied
from an earlier inventory are intentionally rejected.

Create the staging `.deployment-source.json` from the final reviewed target
commit. Supply its exact revision, source-tree digest, file count, changed-path
digest, and independent file digests for the rebuild runner, canary, migration
0072, migration verifier, contract helper, recovery launcher, canonical
backup-and-copy hook, and Compose definition. The launcher refuses any byte or
executable-mode drift.

The target build ID must be exactly
`prod-20260717-<target-revision-12>-r4`. The admin cookie is passed only through the
environment and is never written to a journal. All state journals and backup
proofs are owner-controlled mode 0600; their directories are mode 0700.

## Backup-and-copy hook contract

The launcher uses only the hash-pinned staged
`scripts/deploy/create-verified-canary-postgres-backup.sh`; an arbitrary
operator hook cannot replace it. The independently hash-pinned
`POSTGRES_BACKUP_TOOL` remains an absolute regular file. The launcher calls the
canonical hook only after `media-repair` is stopped and while descriptor 9 is
locked. It receives:

- `ENV_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, and
  `COMPOSE_PROJECT_DIRECTORY`;
- stable output paths in `DATABASE_BACKUP_FILE`,
  `DATABASE_BACKUP_MANIFEST`, and `DATABASE_BACKUP_OFF_VPS_RECEIPT`;
- the exact expected PostgreSQL container and image IDs;
- `MEDIA_QUIESCE_JOURNAL` and `DEPLOY_LOCK_HELD=1`.

The hook derives a restart-safe state from those paths. An exact strongly
verified local pair is reused byte-for-byte; a structurally complete but
unverified pair finishes strong verification before any remote operation.
Dump-only, manifest-only, and hash/size-unmatched local publications move to a
private no-clobber quarantine and are fsynced without deleting evidence.
Unsafe paths and complete pairs with different source provenance are hard
collisions and remain untouched.

For both the dump and manifest, the hook attempts create-only GCS publication,
resolves the committed numeric generation even after a lost upload response,
then downloads that exact generation and verifies SHA-256 and byte size. An
existing exact object reuses its generation; different content is never
overwritten. The manifest object name includes its own digest so a legitimate
new verification record cannot collide merely because the dump bytes match.

Only after both generation-pinned downloads pass does the hook construct the
receipt. Its temporary inode is created and fsynced in the receipt's own
mode-0700 parent, published through an exclusive hard link, and followed by a
parent-directory fsync and exact byte validation. A replay revalidates and
reuses the exact receipt without rewriting it; a different receipt fails as a
collision. Database passwords must not appear in command arguments.

The off-VPS receipt is a private JSON object with purpose
`airfoils-pro-postgres-off-vps-copy`; immutable GCS dump and manifest locators
and numeric generations; the source container and image IDs; both downloaded
objects' digests and sizes; verification method
`remote-download-sha256`; and a verification timestamp after the strong local
restore. The contract helper validates every field and chronology before any
build begins.

## Rollback boundary and records

Before building, the launcher tags the exact current images as
`airfoils-pro-rollback-<service>:r3-to-r4-<target-revision-12>-<changeset-12>`.
A pre-existing tag is accepted only when it resolves to the same exact image;
a collision fails closed. No image pruning or automatic rollback is allowed.
The recovery journal identity contains all tag-to-image and container
mappings, both runtime snapshots, the strong backup proof, and every source and
predecessor digest.

Failure before a durable canary receipt is recorded as
`pre-receipt-rollback-eligible`, meaning a separate reviewed rollback may use
the preserved tags. Once a receipt exists—or when the marker/receipt state is
ambiguous—image rollback is forbidden because database acknowledgement state
may already have crossed the cutover boundary.

The delegated rebuild verifies `APP_DIR` and its deployment manifest against
the exact cd0967 current source while using only the r4 target as the Compose
build context and deployment-script source. `DEPLOY_SOURCE_REVISION` and
`DEPLOY_SOURCE_TREE_SHA256` remain cd0967, so a pending cutover marker must keep
that exact source tuple. Only terminal continuation may clear it; substituting
the r4 target tuple is a hard failure. The final environment must nevertheless
carry the exact matching r4 `AIRFOILFOAM_BUILD_ID` and
`ENGINE_EXPECTED_BUILD_ID` pair.
