import {
  computeEdgeAutoScrollDelta,
  contentYToListIndex,
  contentYToTargetIndex,
  EDGE_AUTOSCROLL_ZONE,
  getDropLineContentY,
  getItemHeightAt,
  getItemTopY,
  getListHeaderHeight,
  getTotalContentHeight,
  getTotalReorderableCount,
  isHeaderIndex,
  MAX_AUTOSCROLL_PX_PER_FRAME,
  QUEUE_ROW_HEIGHT,
  QUEUE_SECTION_HEADER_HEIGHT,
} from '../queueDragMath';

describe('queueDragMath', () => {
  const H_H = QUEUE_SECTION_HEADER_HEIGHT; // 42
  const H_R = QUEUE_ROW_HEIGHT; // 64
  const NP_H = H_H + H_R; // 106

  it('computes header height and total reorderable counts across empty and populated shapes', () => {
    expect(getListHeaderHeight(false)).toBe(0);
    expect(getListHeaderHeight(true)).toBe(NP_H);

    expect(getTotalReorderableCount(0, 0)).toBe(0);
    expect(getTotalReorderableCount(2, 0)).toBe(3);
    expect(getTotalReorderableCount(0, 4)).toBe(5);
    expect(getTotalReorderableCount(3, 5)).toBe(10);
  });

  it('identifies header indices and item heights accurately', () => {
    // Only Next Up
    expect(isHeaderIndex(0, 0, 3)).toBe(true);
    expect(isHeaderIndex(1, 0, 3)).toBe(false);
    expect(getItemHeightAt(0, 0, 3)).toBe(H_H);
    expect(getItemHeightAt(2, 0, 3)).toBe(H_R);

    // User Queue + Next Up
    // 0: UQ header, 1: u1, 2: u2, 3: NextUp header, 4: n1
    expect(isHeaderIndex(-1, 2, 2)).toBe(false);
    expect(isHeaderIndex(0, 2, 2)).toBe(true);
    expect(isHeaderIndex(1, 2, 2)).toBe(false);
    expect(isHeaderIndex(2, 2, 2)).toBe(false);
    expect(isHeaderIndex(3, 2, 2)).toBe(true);
    expect(isHeaderIndex(4, 2, 2)).toBe(false);
    expect(getItemHeightAt(0, 2, 2)).toBe(H_H);
    expect(getItemHeightAt(3, 2, 2)).toBe(H_H);
    expect(getItemHeightAt(4, 2, 2)).toBe(H_R);
  });

  it('computes O(1) top Y and total content height for both user-queue and huge queues', () => {
    // NowPlaying (106) + UQ(42 + 2*64 = 170) + NextUp(42 + 3*64 = 234) = 510
    expect(getTotalContentHeight(true, 2, 3)).toBe(510);
    expect(getItemTopY(0, true, 2, 3)).toBe(106); // UQ header
    expect(getItemTopY(1, true, 2, 3)).toBe(148); // u1
    expect(getItemTopY(2, true, 2, 3)).toBe(212); // u2
    expect(getItemTopY(3, true, 2, 3)).toBe(276); // NextUp header
    expect(getItemTopY(4, true, 2, 3)).toBe(318); // n1
    expect(getItemTopY(5, true, 2, 3)).toBe(382); // n2
    expect(getItemTopY(6, true, 2, 3)).toBe(446); // n3

    // Without NowPlaying or UserQueue
    expect(getItemTopY(0, false, 0, 4)).toBe(0);
    expect(getItemTopY(1, false, 0, 4)).toBe(H_H);
    expect(getItemTopY(3, false, 0, 4)).toBe(H_H + 2 * H_R);
    expect(getTotalContentHeight(false, 0, 0)).toBe(0);
    expect(getItemTopY(0, false, 0, 0)).toBe(0);

    // Large 5,000-track queue
    const hugeTotal = getTotalContentHeight(true, 50, 5000);
    expect(hugeTotal).toBe(NP_H + (H_H + 50 * H_R) + (H_H + 5000 * H_R));
    // Index 51 is NextUp header; index 5051 is track 4999 (last item)
    expect(getItemTopY(51, true, 50, 5000)).toBe(NP_H + H_H + 50 * H_R);
    expect(getItemTopY(5051, true, 50, 5000)).toBe(hugeTotal - H_R);
  });

  it('hit-tests contentYToListIndex at boundaries and rejects non-draggable regions', () => {
    expect(contentYToListIndex(50, true, 0, 0)).toBe(-1);

    // With NowPlaying + UQ(2) + NextUp(2): total height = 106 + 170 + 170 = 446
    expect(contentYToListIndex(-10, true, 2, 2)).toBe(-1);
    expect(contentYToListIndex(105.9, true, 2, 2)).toBe(-1); // NowPlaying
    expect(contentYToListIndex(106, true, 2, 2)).toBe(-1); // UQ header
    expect(contentYToListIndex(147.9, true, 2, 2)).toBe(-1); // still UQ header
    expect(contentYToListIndex(148, true, 2, 2)).toBe(1); // u1
    expect(contentYToListIndex(211.9, true, 2, 2)).toBe(1); // bottom of u1
    expect(contentYToListIndex(212, true, 2, 2)).toBe(2); // u2
    expect(contentYToListIndex(276, true, 2, 2)).toBe(-1); // NextUp header
    expect(contentYToListIndex(317.9, true, 2, 2)).toBe(-1); // still NextUp header
    expect(contentYToListIndex(318, true, 2, 2)).toBe(4); // n1
    expect(contentYToListIndex(382, true, 2, 2)).toBe(5); // n2
    expect(contentYToListIndex(446, true, 2, 2)).toBe(-1); // past bottom

    // No UserQueue: 0 is NextUp header, 1 is n1
    expect(contentYToListIndex(106, true, 0, 3)).toBe(-1);
    expect(contentYToListIndex(148, true, 0, 3)).toBe(1);
    expect(contentYToListIndex(212, true, 0, 3)).toBe(2);

    // Large 5,000-track queue lookup near bottom
    const lastTop = getItemTopY(5051, true, 50, 5000);
    expect(contentYToListIndex(lastTop + 10, true, 50, 5000)).toBe(5051);
  });

  it('clamps contentYToTargetIndex across headers and out-of-bounds Y', () => {
    expect(contentYToTargetIndex(50, true, 0, 0)).toBe(-1);
    // Above reorderable region -> 0 (first header)
    expect(contentYToTargetIndex(-50, true, 2, 2)).toBe(0);
    expect(contentYToTargetIndex(10, true, 2, 2)).toBe(0);
    // Inside UQ header -> 0
    expect(contentYToTargetIndex(120, true, 2, 2)).toBe(0);
    // Inside NextUp header -> 3
    expect(contentYToTargetIndex(290, true, 2, 2)).toBe(3);
    // Inside n2 -> 5
    expect(contentYToTargetIndex(400, true, 2, 2)).toBe(5);
    // Past bottom -> clamped to last index (5)
    expect(contentYToTargetIndex(99999, true, 2, 2)).toBe(5);
    // No UserQueue: NextUp header at 0
    expect(contentYToTargetIndex(120, true, 0, 3)).toBe(0);
    expect(contentYToTargetIndex(160, true, 0, 3)).toBe(1);
  });

  it('computes drop indicator content Y for tracks and cross-section headers', () => {
    // Negative target -> 0
    expect(getDropLineContentY(1, -1, true, 2, 2)).toBe(0);

    // Dragging downward onto track -> bottom edge of target
    expect(getDropLineContentY(1, 4, true, 2, 2)).toBe(getItemTopY(4, true, 2, 2) + H_R);
    // Dragging upward onto track -> top edge of target
    expect(getDropLineContentY(4, 1, true, 2, 2)).toBe(getItemTopY(1, true, 2, 2));
    // Dropping onto UQ header (0) -> top of u1
    expect(getDropLineContentY(4, 0, true, 2, 2)).toBe(getItemTopY(0, true, 2, 2) + H_H);
    // Dragging from below (4) onto NextUp header (3) -> top of header (promote to UQ)
    expect(getDropLineContentY(4, 3, true, 2, 2)).toBe(getItemTopY(3, true, 2, 2));
    // Dragging from above (1) onto NextUp header (3) -> bottom of header (demote to NextUp)
    expect(getDropLineContentY(1, 3, true, 2, 2)).toBe(getItemTopY(3, true, 2, 2) + H_H);
  });

  it('computes edge auto-scroll delta smoothly at top, middle, and bottom', () => {
    expect(computeEdgeAutoScrollDelta(10, 0)).toBe(0);
    expect(computeEdgeAutoScrollDelta(0, 600)).toBe(-MAX_AUTOSCROLL_PX_PER_FRAME);
    expect(computeEdgeAutoScrollDelta(EDGE_AUTOSCROLL_ZONE / 2, 600)).toBeCloseTo(
      -MAX_AUTOSCROLL_PX_PER_FRAME / 2,
    );
    expect(computeEdgeAutoScrollDelta(300, 600)).toBe(0);
    expect(computeEdgeAutoScrollDelta(600 - EDGE_AUTOSCROLL_ZONE / 2, 600)).toBeCloseTo(
      MAX_AUTOSCROLL_PX_PER_FRAME / 2,
    );
    expect(computeEdgeAutoScrollDelta(600, 600)).toBe(MAX_AUTOSCROLL_PX_PER_FRAME);
  });
});
