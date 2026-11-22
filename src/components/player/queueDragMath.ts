export const QUEUE_ROW_HEIGHT = 64;
export const QUEUE_SECTION_HEADER_HEIGHT = 42;

export const DRAG_HANDLE_HIT_WIDTH = 56;
export const EDGE_AUTOSCROLL_ZONE = 64;
export const MAX_AUTOSCROLL_PX_PER_FRAME = 14;

/** Height of the non-reorderable `ListHeaderComponent` (Now Playing header + active row). */
export function getListHeaderHeight(hasNowPlaying: boolean): number {
  'worklet';
  return hasNowPlaying ? QUEUE_SECTION_HEADER_HEIGHT + QUEUE_ROW_HEIGHT : 0;
}

/** Total item count in `reorderableListItems` (section headers + upcoming tracks). */
export function getTotalReorderableCount(
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  return (
    (userQueueCount > 0 ? 1 + userQueueCount : 0) +
    (nextUpCount > 0 ? 1 + nextUpCount : 0)
  );
}

/** Whether `listIndex` inside `reorderableListItems` is a section header. */
export function isHeaderIndex(
  listIndex: number,
  userQueueCount: number,
  nextUpCount: number,
): boolean {
  'worklet';
  if (listIndex < 0) return false;
  if (userQueueCount > 0 && listIndex === 0) return true;
  const nextUpHeaderIdx = userQueueCount > 0 ? userQueueCount + 1 : 0;
  return nextUpCount > 0 && listIndex === nextUpHeaderIdx;
}

/** Pixel height of item at `listIndex` inside `reorderableListItems`. */
export function getItemHeightAt(
  listIndex: number,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  return isHeaderIndex(listIndex, userQueueCount, nextUpCount)
    ? QUEUE_SECTION_HEADER_HEIGHT
    : QUEUE_ROW_HEIGHT;
}

/** O(1) top Y coordinate of `listIndex` in list content space (including ListHeaderComponent). */
export function getItemTopY(
  listIndex: number,
  hasNowPlaying: boolean,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  const base = hasNowPlaying ? QUEUE_SECTION_HEADER_HEIGHT + QUEUE_ROW_HEIGHT : 0;
  if (listIndex <= 0) return base;

  if (userQueueCount > 0) {
    const userSectionHeight =
      QUEUE_SECTION_HEADER_HEIGHT + userQueueCount * QUEUE_ROW_HEIGHT;
    if (listIndex <= userQueueCount) {
      return base + QUEUE_SECTION_HEADER_HEIGHT + (listIndex - 1) * QUEUE_ROW_HEIGHT;
    }
    if (listIndex === userQueueCount + 1) {
      return base + userSectionHeight;
    }
    const offsetInNextUp = listIndex - (userQueueCount + 2);
    return (
      base +
      userSectionHeight +
      QUEUE_SECTION_HEADER_HEIGHT +
      Math.max(0, offsetInNextUp) * QUEUE_ROW_HEIGHT
    );
  }

  if (nextUpCount > 0) {
    return base + QUEUE_SECTION_HEADER_HEIGHT + (listIndex - 1) * QUEUE_ROW_HEIGHT;
  }

  return base;
}

/** Total scrollable content height (ListHeaderComponent + all reorderable items). */
export function getTotalContentHeight(
  hasNowPlaying: boolean,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  const base = hasNowPlaying ? QUEUE_SECTION_HEADER_HEIGHT + QUEUE_ROW_HEIGHT : 0;
  const userH =
    userQueueCount > 0
      ? QUEUE_SECTION_HEADER_HEIGHT + userQueueCount * QUEUE_ROW_HEIGHT
      : 0;
  const nextH =
    nextUpCount > 0
      ? QUEUE_SECTION_HEADER_HEIGHT + nextUpCount * QUEUE_ROW_HEIGHT
      : 0;
  return base + userH + nextH;
}

/**
 * O(1) hit-test from content Y coordinate to draggable track index inside
 * `reorderableListItems`. Returns `-1` when Y hits Now Playing, a section
 * header, or lies outside the reorderable bounds.
 */
export function contentYToListIndex(
  contentY: number,
  hasNowPlaying: boolean,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  const totalCount = getTotalReorderableCount(userQueueCount, nextUpCount);
  if (totalCount === 0) return -1;

  const base = hasNowPlaying ? QUEUE_SECTION_HEADER_HEIGHT + QUEUE_ROW_HEIGHT : 0;
  if (contentY < base) return -1;

  let y = contentY - base;

  if (userQueueCount > 0) {
    const userSectionH =
      QUEUE_SECTION_HEADER_HEIGHT + userQueueCount * QUEUE_ROW_HEIGHT;
    if (y < userSectionH) {
      if (y < QUEUE_SECTION_HEADER_HEIGHT) return -1;
      const trackIdx = Math.floor((y - QUEUE_SECTION_HEADER_HEIGHT) / QUEUE_ROW_HEIGHT);
      return 1 + Math.min(trackIdx, userQueueCount - 1);
    }
    y -= userSectionH;
  }

  if (nextUpCount > 0) {
    const nextSectionH =
      QUEUE_SECTION_HEADER_HEIGHT + nextUpCount * QUEUE_ROW_HEIGHT;
    if (y < nextSectionH) {
      if (y < QUEUE_SECTION_HEADER_HEIGHT) return -1;
      const trackIdx = Math.floor((y - QUEUE_SECTION_HEADER_HEIGHT) / QUEUE_ROW_HEIGHT);
      const nextUpHeaderIdx = userQueueCount > 0 ? userQueueCount + 1 : 0;
      return nextUpHeaderIdx + 1 + Math.min(trackIdx, nextUpCount - 1);
    }
  }

  return -1;
}

/**
 * O(1) mapping from finger content Y coordinate to target index in
 * `reorderableListItems` (clamped to `[0, totalCount - 1]`, including section
 * headers so `calculateReorderPlan` can promote/demote across sections).
 * Returns `-1` when there are no reorderable items.
 */
export function contentYToTargetIndex(
  contentY: number,
  hasNowPlaying: boolean,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  const totalCount = getTotalReorderableCount(userQueueCount, nextUpCount);
  if (totalCount === 0) return -1;

  const base = hasNowPlaying ? QUEUE_SECTION_HEADER_HEIGHT + QUEUE_ROW_HEIGHT : 0;
  if (contentY <= base) return 0;

  let y = contentY - base;

  if (userQueueCount > 0) {
    const userSectionH =
      QUEUE_SECTION_HEADER_HEIGHT + userQueueCount * QUEUE_ROW_HEIGHT;
    if (y < userSectionH) {
      if (y < QUEUE_SECTION_HEADER_HEIGHT) return 0;
      const trackIdx = Math.floor((y - QUEUE_SECTION_HEADER_HEIGHT) / QUEUE_ROW_HEIGHT);
      return 1 + Math.min(trackIdx, userQueueCount - 1);
    }
    y -= userSectionH;
  }

  if (nextUpCount > 0) {
    const nextUpHeaderIdx = userQueueCount > 0 ? userQueueCount + 1 : 0;
    const nextSectionH =
      QUEUE_SECTION_HEADER_HEIGHT + nextUpCount * QUEUE_ROW_HEIGHT;
    if (y < nextSectionH) {
      if (y < QUEUE_SECTION_HEADER_HEIGHT) return nextUpHeaderIdx;
      const trackIdx = Math.floor((y - QUEUE_SECTION_HEADER_HEIGHT) / QUEUE_ROW_HEIGHT);
      return nextUpHeaderIdx + 1 + Math.min(trackIdx, nextUpCount - 1);
    }
  }

  return totalCount - 1;
}

/** Content Y position for the drop indicator line given `fromIndex` and `targetIndex`. */
export function getDropLineContentY(
  fromIndex: number,
  targetIndex: number,
  hasNowPlaying: boolean,
  userQueueCount: number,
  nextUpCount: number,
): number {
  'worklet';
  if (targetIndex < 0) return 0;
  const top = getItemTopY(targetIndex, hasNowPlaying, userQueueCount, nextUpCount);
  if (isHeaderIndex(targetIndex, userQueueCount, nextUpCount)) {
    if (userQueueCount > 0 && targetIndex === 0) {
      return top + QUEUE_SECTION_HEADER_HEIGHT;
    }
    return fromIndex > targetIndex ? top : top + QUEUE_SECTION_HEADER_HEIGHT;
  }
  return targetIndex > fromIndex ? top + QUEUE_ROW_HEIGHT : top;
}

/** Compute per-frame scroll delta (px) when finger enters top/bottom auto-scroll zones. */
export function computeEdgeAutoScrollDelta(
  fingerY: number,
  containerHeight: number,
): number {
  if (containerHeight <= 0) return 0;
  if (fingerY < EDGE_AUTOSCROLL_ZONE) {
    const ratio = Math.min(1, Math.max(0, (EDGE_AUTOSCROLL_ZONE - fingerY) / EDGE_AUTOSCROLL_ZONE));
    return -MAX_AUTOSCROLL_PX_PER_FRAME * ratio;
  }
  const bottomStart = containerHeight - EDGE_AUTOSCROLL_ZONE;
  if (fingerY > bottomStart) {
    const ratio = Math.min(1, Math.max(0, (fingerY - bottomStart) / EDGE_AUTOSCROLL_ZONE));
    return MAX_AUTOSCROLL_PX_PER_FRAME * ratio;
  }
  return 0;
}
