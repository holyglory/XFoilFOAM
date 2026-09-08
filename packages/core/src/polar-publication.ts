export function polarEvidencePublicationRank(
  state: "accepted" | "needs_urans",
  fidelity: string | null,
  regime: "rans" | "urans" | null,
): number {
  return (
    (state === "accepted" ? 200 : 100) +
    (fidelity === "urans_full"
      ? 30
      : fidelity === "urans_precalc" || regime === "urans"
        ? 20
        : 10)
  );
}
