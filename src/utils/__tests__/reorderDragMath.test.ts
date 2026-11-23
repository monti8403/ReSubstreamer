import {
  computeEdgeAutoScrollDelta,
  contentYToClampedTargetIndex,
  contentYToDraggableIndex,
  DEFAULT_DRAG_HANDLE_HIT_WIDTH,
  EDGE_AUTOSCROLL_ZONE,
  getUniformDropLineContentY,
  MAX_AUTOSCROLL_PX_PER_FRAME,
  reorderArray,
} from '../reorderDragMath';

describe('reorderDragMath', () => {
  describe('reorderArray', () => {
    it('moves items forward and backward without mutating input', () => {
      const original = ['a', 'b', 'c', 'd'];
      expect(reorderArray(original, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
      expect(reorderArray(original, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
      expect(original).toEqual(['a', 'b', 'c', 'd']);
    });

    it('preserves duplicates accurately when moving by index', () => {
      const first = { id: 's1', instance: 1 };
      const second = { id: 's2', instance: 2 };
      const third = { id: 's1', instance: 3 };
      const list = [first, second, third];

      const moved = reorderArray(list, 0, 2);
      expect(moved[0]).toBe(second);
      expect(moved[1]).toBe(third);
      expect(moved[2]).toBe(first);
    });

    it('returns the original array reference for no-ops and out-of-bounds indices', () => {
      const list = ['a', 'b', 'c'];
      expect(reorderArray(list, 1, 1)).toBe(list);
      expect(reorderArray(list, -1, 1)).toBe(list);
      expect(reorderArray(list, 1, -1)).toBe(list);
      expect(reorderArray(list, 3, 1)).toBe(list);
      expect(reorderArray(list, 1, 3)).toBe(list);

      const empty: string[] = [];
      expect(reorderArray(empty, 0, 0)).toBe(empty);

      const single = ['only'];
      expect(reorderArray(single, 0, 0)).toBe(single);
    });
  });

  describe('contentYToDraggableIndex', () => {
    it('returns -1 when empty or stride is non-positive', () => {
      expect(contentYToDraggableIndex(100, 50, 0, 0, 64)).toBe(-1);
      expect(contentYToDraggableIndex(100, 50, 0, 3, 0)).toBe(-1);
      expect(contentYToDraggableIndex(100, 50, 0, 3, -10)).toBe(-1);
    });

    it('maps contentY accurately at boundaries and rejects outside bounds', () => {
      // Top = 100, start = 2, count = 3, stride = 64 -> range [100, 292)
      expect(contentYToDraggableIndex(99.9, 100, 2, 3, 64)).toBe(-1);
      expect(contentYToDraggableIndex(100, 100, 2, 3, 64)).toBe(2);
      expect(contentYToDraggableIndex(163.9, 100, 2, 3, 64)).toBe(2);
      expect(contentYToDraggableIndex(164, 100, 2, 3, 64)).toBe(3);
      expect(contentYToDraggableIndex(228, 100, 2, 3, 64)).toBe(4);
      expect(contentYToDraggableIndex(291.9, 100, 2, 3, 64)).toBe(4);
      expect(contentYToDraggableIndex(292, 100, 2, 3, 64)).toBe(-1);
    });

    it('handles large 5,000-row lists in O(1)', () => {
      expect(contentYToDraggableIndex(500 + 4999 * 64 + 10, 500, 0, 5000, 64)).toBe(4999);
      expect(contentYToDraggableIndex(500 + 5000 * 64, 500, 0, 5000, 64)).toBe(-1);
    });
  });

  describe('contentYToClampedTargetIndex', () => {
    it('returns -1 when empty or stride is non-positive', () => {
      expect(contentYToClampedTargetIndex(100, 50, 1, 0, 64)).toBe(-1);
      expect(contentYToClampedTargetIndex(100, 50, 1, 3, 0)).toBe(-1);
    });

    it('clamps above top to draggableStart and past bottom to last draggable index', () => {
      // Top = 200, start = 1, count = 4, stride = 94 (84 + 10 gap)
      expect(contentYToClampedTargetIndex(0, 200, 1, 4, 94)).toBe(1);
      expect(contentYToClampedTargetIndex(200, 200, 1, 4, 94)).toBe(1);
      expect(contentYToClampedTargetIndex(294, 200, 1, 4, 94)).toBe(2);
      expect(contentYToClampedTargetIndex(482, 200, 1, 4, 94)).toBe(4);
      expect(contentYToClampedTargetIndex(99999, 200, 1, 4, 94)).toBe(4);
    });
  });

  describe('getUniformDropLineContentY', () => {
    it('returns draggableTopY for invalid target or non-positive stride', () => {
      expect(getUniformDropLineContentY(1, -1, 120, 1, 64)).toBe(120);
      expect(getUniformDropLineContentY(1, 0, 120, 1, 64)).toBe(120);
      expect(getUniformDropLineContentY(1, 1, 120, 1, 0)).toBe(120);
    });

    it('positions drop line above target when moving up/stationary and below when moving down', () => {
      // Without rowGap
      expect(getUniformDropLineContentY(2, 2, 100, 0, 64, 0)).toBe(228);
      expect(getUniformDropLineContentY(2, 0, 100, 0, 64, 0)).toBe(100);
      expect(getUniformDropLineContentY(0, 2, 100, 0, 64, 0)).toBe(292);

      // With rowGap = 10, stride = 94, draggableStart = 1, draggableTopY = 200
      // Moving down from 1 to 3: top = 200 + 2*94 = 388; bottom center = 388 + 94 - 5 = 477
      expect(getUniformDropLineContentY(1, 3, 200, 1, 94, 10)).toBe(477);
      // Moving up from 3 to 1: top = 200; top center = 200 - 5 = 195
      expect(getUniformDropLineContentY(3, 1, 200, 1, 94, 10)).toBe(195);
    });
  });

  describe('computeEdgeAutoScrollDelta and constants', () => {
    it('exports expected drag constants and computes smooth edge scroll deltas', () => {
      expect(DEFAULT_DRAG_HANDLE_HIT_WIDTH).toBe(56);
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
});
