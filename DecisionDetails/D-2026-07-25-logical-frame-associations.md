# D-2026-07-25-logical-frame-associations

## Production evidence

Remote OpenCFD 2606 result `f6de170f-0b74-4fe1-825c-22b6585bffd8`
published an accepted three-period clean tail for its AoA 1 case. Pressure
frames 25 and 84 are distinct real time steps and separate immutable remote
artifact rows, but their PNG bytes have the same SHA-256
`9e4d0e8f6d0ab91bfcfff09fffad4147e2b72bcf186730d7507e2caad4ebe5d5`.
The hub correctly stored those bytes at one content-addressed key. Its prior
association uniqueness omitted the frame index, however, so importing the
second row hit the first row and returned HTTP 409:
`exact-attempt artifact association changed immutable metadata`.

The GCS archive itself had already authenticated and remained immutable. This
was an import data-model defect, not a CFD or archive-integrity failure.

## Selected contract

The logical identity for a frame artifact is its exact result/attempt owner,
kind, field, role, physical content identity, and immutable `frameIndex`.
Non-frame artifacts retain their prior identity because their frame index is
empty. Replay lookup uses the same discriminator before comparing all remaining
immutable metadata.

This permits multiple logical time steps to reference one physical
content-addressed file. It does not permit one frame index to change metadata,
ownership, checksums, or bytes.

## Alternatives rejected

1. Store another physical copy of identical PNG bytes. This preserves URLs but
   defeats content-addressed storage and scales poorly across long URANS frame
   tracks.
2. Keep only one association for identical bytes. This loses a real time step,
   makes the frame track incomplete, and can leave UI playback without the
   image owned by that index.
3. Add the entire JSON metadata document to uniqueness. This is overly broad,
   risks index-size failures, and would allow unrelated mutable metadata
   differences to manufacture new artifact identities.
4. Ignore the second insert when bytes match. This recreates option 2 and hides
   the evidence loss.

## Prevention and verification

The API regression submits one exact attempt with two pressure-frame artifacts
whose bytes, kind, field, role, checksum, and resulting local storage key are
identical but whose frame indices are 25 and 84. Before the correction, the
same request reproduced production's HTTP 409. After migration 0090 and the
matching replay predicate, initial import and exact replay both return HTTP
200, both logical rows remain present, their indices are 25 and 84, and both
rows share one physical storage key.

The full 51-test remote-sync validation file, the seven-test remote-delivery
migration suite, and DB/API/sweeper TypeScript checks pass against an isolated
database migrated from the repository history.
