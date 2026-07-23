const BADGE_GAP = 12;
const BADGE_EDGE = 8;

export const POLAR_BADGE_EDGE = BADGE_EDGE;

export function containedBadgePosition(input: {
  anchorX: number;
  anchorY: number;
  badgeWidth: number;
  badgeHeight: number;
  containerWidth: number;
  containerHeight: number;
}): { left: number; top: number } {
  const {
    anchorX,
    anchorY,
    badgeWidth,
    badgeHeight,
    containerWidth,
    containerHeight,
  } = input;
  const maxLeft = Math.max(
    BADGE_EDGE,
    containerWidth - badgeWidth - BADGE_EDGE,
  );
  const maxTop = Math.max(
    BADGE_EDGE,
    containerHeight - badgeHeight - BADGE_EDGE,
  );
  const preferredLeft =
    anchorX + BADGE_GAP + badgeWidth <= containerWidth - BADGE_EDGE
      ? anchorX + BADGE_GAP
      : anchorX - BADGE_GAP - badgeWidth;
  return {
    left: Math.min(maxLeft, Math.max(BADGE_EDGE, preferredLeft)),
    top: Math.min(maxTop, Math.max(BADGE_EDGE, anchorY - badgeHeight / 2)),
  };
}
