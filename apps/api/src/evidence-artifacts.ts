export function selectVisibleEvidenceArtifacts<
  T extends { id: string; kind: string },
>(artifacts: T[], currentArchiveSourceId: string | null): T[] {
  if (!currentArchiveSourceId) return artifacts;
  return artifacts.filter(
    (artifact) =>
      (artifact.kind !== "engine_bundle" &&
        artifact.kind !== "openfoam_bundle") ||
      artifact.id === currentArchiveSourceId,
  );
}
