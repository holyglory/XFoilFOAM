# Pending OpenCFD 2606 canary DB-ACK recovery

`scripts/deploy/recover-pending-opencfd2606-canary-db-ack.sh` is the
incident-specific launcher for the failed 2026-07-17 r2 cutover. It is not a
general deployment command. It accepts only the original bound production
release, the three exact predecessor journals, the failed-r2 pristine marker
tuple, and one fully manifested reviewed target tree.

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
4. collision-checked preservation of every replaceable r2 service image;
5. target image builds, migration, service recreation, repaired four-point
   canary, database cleanup acknowledgements, and cutover finalization.

The same Compose project name (`app`) and explicit project directory are used
throughout so the existing named PostgreSQL and results volumes remain the
deployment targets. `media-repair` returns to its initial running state only
after terminal success. A failed or interrupted transaction keeps
`media-repair` and the sweeper stopped and requests that the 2606 pool remain
disabled.

## Required bindings

Before invocation, re-inventory production while holding descriptor 9 and
supply the full 64-character container IDs and exact `sha256:` image IDs for
`api`, `worker`, `node-api`, `sweeper`, `media-repair`, and `postgres`. Supply
the exact results-volume identity digest and re-hash the latest failed
same-build replay journal immediately before use. Prefixes or values copied
from an earlier inventory are intentionally rejected.

Create the staging `.deployment-source.json` from the final reviewed target
commit. Supply its exact revision, source-tree digest, file count, changed-path
digest, and independent file digests for the rebuild runner, canary, migration
0072, migration verifier, contract helper, recovery launcher, and Compose
definition. The launcher refuses any byte or executable-mode drift.

The target build ID must be new. The admin cookie is passed only through the
environment and is never written to a journal. All state journals and backup
proofs are owner-controlled mode 0600; their directories are mode 0700.

## Backup-and-copy hook contract

`BACKUP_AND_COPY_HOOK` must be an absolute, non-symlink executable whose
SHA-256 is supplied independently. The launcher calls it only after
`media-repair` is stopped and while descriptor 9 is locked. It receives:

- `ENV_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, and
  `COMPOSE_PROJECT_DIRECTORY`;
- exclusive output paths in `DATABASE_BACKUP_FILE`,
  `DATABASE_BACKUP_MANIFEST`, and `DATABASE_BACKUP_OFF_VPS_RECEIPT`;
- the exact expected PostgreSQL container and image IDs;
- `MEDIA_QUIESCE_JOURNAL` and `DEPLOY_LOCK_HELD=1`.

The hook must fail if an output already exists, invoke the repository's
PostgreSQL Docker backup workflow against the exact full container ID, produce
a database-scope custom-format backup, perform its strong scratch-database
restore verification, then upload an immutable off-VPS copy. It must download
that exact remote version again and compare SHA-256 and byte size before
atomically publishing the receipt. Database passwords must not appear in
command arguments.

The off-VPS receipt is a private JSON object with purpose
`airfoils-pro-postgres-off-vps-copy`; an immutable `gs`, `s3`, or `ssh`
destination locator and version; the source container ID; backup, manifest,
and downloaded-copy digests and sizes; verification method
`remote-download-sha256`; and a verification timestamp after the strong local
restore. The contract helper validates every field and chronology before any
build begins.

## Rollback boundary and records

Before building, the launcher tags the exact current images as
`airfoils-pro-rollback-<service>:r2-<target-revision-12>-<changeset-12>`.
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
