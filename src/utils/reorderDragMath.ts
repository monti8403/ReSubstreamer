export const DEFAULT_DRAG_HANDLE_HIT_WIDTH = 56;
export const DRAG_HOLD_DURATION_MS = 280;
export const DRAG_HOLD_SLOP_PX = 8;
export const EDGE_AUTOSCROLL_ZONE = 64;
export const MAX_AUTOSCROLL_PX_PER_FRAME = 14;

/**
 * Return a shallow copy of `items` with the element at `from` moved to `to`.
 * Returns the original array reference unchanged on invalid or no-op indices.
 */
export function reorderArray<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * O(1) hit-test from content Y coordinate to draggable item index inside a
 * uniform-stride region `[draggableStart, draggableStart + draggableCount - 1]`.
 * Returns `-1` when Y lies outside the draggable bounds.
 */
export function contentYToDraggableIndex(
  contentY: number,
  draggableTopY: number,
  draggableStart: number,
  draggableCount: number,
  rowStride: number,
): number {
  'worklet';
  if (draggableCount <= 0 || rowStride <= 0) return -1;
  const relY = contentY - draggableTopY;
  if (relY < 0) return -1;
  const offset = Math.floor(relY / rowStride);
  if (offset >= draggableCount) return -1;
  return draggableStart + offset;
}

/**
 * O(1) mapping from finger content Y coordinate to target index clamped to
 * `[draggableStart, draggableStart + draggableCount - 1]`.
 * Returns `-1` when there are no draggable items or `rowStride <= 0`.
 */
export function contentYToClampedTargetIndex(
  contentY: number,
  draggableTopY: number,
  draggableStart: number,
  draggableCount: number,
  rowStride: number,
): number {
  'worklet';
  if (draggableCount <= 0 || rowStride <= 0) return -1;
  const relY = contentY - draggableTopY;
  if (relY <= 0) return draggableStart;
  const offset = Math.floor(relY / rowStride);
  if (offset >= draggableCount) return draggableStart + draggableCount - 1;
  return draggableStart + offset;
}

/**
 * Content Y position for the drop indicator line in a uniform-stride region.
 */
export function getUniformDropLineContentY(
  fromIndex: number,
  targetIndex: number,
  draggableTopY: number,
  draggableStart: number,
  rowStride: number,
  rowGap = 0,
): number {
  'worklet';
  if (targetIndex < draggableStart || rowStride <= 0) return draggableTopY;
  const top = draggableTopY + (targetIndex - draggableStart) * rowStride;
  if (targetIndex > fromIndex) {
    return top + rowStride - rowGap / 2;
  }
  return top - rowGap / 2;
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
