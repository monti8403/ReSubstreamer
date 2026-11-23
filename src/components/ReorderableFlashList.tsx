import { FlashList, type FlashListRef } from '@shopify/flash-list';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { closeOpenRow } from '@/components/SwipeableRow';
import { LIST_DRAW_DISTANCE } from '@/constants/layout';
import * as Haptics from '@/utils/haptics';
import {
  computeEdgeAutoScrollDelta,
  contentYToClampedTargetIndex,
  contentYToDraggableIndex,
  DEFAULT_DRAG_HANDLE_HIT_WIDTH,
  DRAG_HOLD_DURATION_MS,
  DRAG_HOLD_SLOP_PX,
  getUniformDropLineContentY,
} from '@/utils/reorderDragMath';

export interface ReorderableFlashListRenderInfo<T> {
  item: T;
  index: number;
  isDragging: boolean;
}

export interface ReorderableFlashListProps<T> {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: ReorderableFlashListRenderInfo<T>) => ReactElement | null;
  renderGhost: (item: T, index: number) => ReactElement | null;
  onReorder: (from: number, to: number) => void;
  /** Visual card height of a draggable row, excluding `rowGap`. */
  rowHeight: number;
  /** Vertical spacing between rows. Defaults to `0`. */
  rowGap?: number;
  /** First draggable index inside `data`. Defaults to `0`. */
  draggableStart?: number;
  /** Number of draggable items starting at `draggableStart`. Defaults to `Math.max(0, data.length - draggableStart)`. */
  draggableCount?: number;
  /** Combined height of non-draggable rows preceding `draggableStart`. Defaults to `0`. */
  leadingRowsHeight?: number;
  /** Estimated combined height of non-draggable rows after the draggable range. Defaults to `0`. */
  trailingRowsHeight?: number;
  /** Top padding applied via `contentContainerStyle.paddingTop`. Defaults to `0`. */
  contentPaddingTop?: number;
  /** Bottom padding applied via `contentContainerStyle.paddingBottom`. Defaults to `0`. */
  contentPaddingBottom?: number;
  /** Width in points from the right container edge where the drag handle activates. */
  dragHandleHitWidth?: number;
  /** Horizontal inset of the floating ghost card container. Defaults to `8`. */
  ghostHorizontalInset?: number;
  /** Horizontal inset of the drop indicator bar. Defaults to `16`. */
  dropIndicatorInset?: number;
  /** Color of the drop indicator bar. */
  accentColor: string;
  getItemType?: (item: T, index: number) => string | number | undefined;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  contentContainerStyle?: StyleProp<ViewStyle>;
  drawDistance?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  showsVerticalScrollIndicator?: boolean;
  onScrollBeginDrag?: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  listRef?: RefObject<FlashListRef<T> | null>;
  testID?: string;
}

/**
 * Generic FlashList v2 reorderable list with container-level right-band drag
 * handle detection, floating ghost row overlay, drop indicator bar, and
 * edge auto-scrolling.
 */
export function ReorderableFlashList<T>({
  data,
  keyExtractor,
  renderItem,
  renderGhost,
  onReorder,
  rowHeight,
  rowGap = 0,
  draggableStart = 0,
  draggableCount,
  leadingRowsHeight = 0,
  trailingRowsHeight = 0,
  contentPaddingTop = 0,
  contentPaddingBottom = 0,
  dragHandleHitWidth = DEFAULT_DRAG_HANDLE_HIT_WIDTH,
  ghostHorizontalInset = 8,
  dropIndicatorInset = 16,
  accentColor,
  getItemType,
  ListHeaderComponent,
  ListEmptyComponent,
  contentContainerStyle,
  drawDistance = LIST_DRAW_DISTANCE,
  keyboardShouldPersistTaps,
  showsVerticalScrollIndicator = false,
  onScrollBeginDrag,
  onDragStateChange,
  listRef,
  testID = 'reorderable-flash-list',
}: ReorderableFlashListProps<T>) {
  const effectiveDraggableCount =
    draggableCount ?? Math.max(0, data.length - draggableStart);
  const rowStride = rowHeight + rowGap;

  const internalListRef = useRef<FlashListRef<T> | null>(null);
  const setFlashListRef = useCallback(
    (instance: FlashListRef<T> | null) => {
      internalListRef.current = instance;
      if (listRef) {
        (listRef as { current: FlashListRef<T> | null }).current = instance;
      }
    },
    [listRef],
  );

  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const draggedKeyRef = useRef<string | null>(null);

  const scrollOffsetRef = useRef(0);
  const containerHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const headerHeightRef = useRef(0);
  const fingerYRef = useRef(0);
  const dragActiveRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  const dataRef = useRef(data);
  dataRef.current = data;
  const keyExtractorRef = useRef(keyExtractor);
  keyExtractorRef.current = keyExtractor;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDragStateChangeRef = useRef(onDragStateChange);
  onDragStateChangeRef.current = onDragStateChange;

  const draggableStartRef = useRef(draggableStart);
  draggableStartRef.current = draggableStart;
  const draggableCountRef = useRef(effectiveDraggableCount);
  draggableCountRef.current = effectiveDraggableCount;
  const rowStrideRef = useRef(rowStride);
  rowStrideRef.current = rowStride;
  const rowGapRef = useRef(rowGap);
  rowGapRef.current = rowGap;
  const trailingRowsHeightRef = useRef(trailingRowsHeight);
  trailingRowsHeightRef.current = trailingRowsHeight;
  const contentPaddingTopRef = useRef(contentPaddingTop);
  contentPaddingTopRef.current = contentPaddingTop;
  const contentPaddingBottomRef = useRef(contentPaddingBottom);
  contentPaddingBottomRef.current = contentPaddingBottom;
  const leadingRowsHeightRef = useRef(leadingRowsHeight);
  leadingRowsHeightRef.current = leadingRowsHeight;
  const draggableTopYRef = useRef(
    contentPaddingTop + headerHeightRef.current + leadingRowsHeight,
  );

  const containerWidthSV = useSharedValue(0);
  const containerHeightSV = useSharedValue(0);
  const scrollOffsetSV = useSharedValue(0);
  const draggableTopYSV = useSharedValue(draggableTopYRef.current);
  const draggableStartSV = useSharedValue(draggableStart);
  const draggableCountSV = useSharedValue(effectiveDraggableCount);
  const rowHeightSV = useSharedValue(rowHeight);
  const rowStrideSV = useSharedValue(rowStride);
  const rowGapSV = useSharedValue(rowGap);
  const dragHandleHitWidthSV = useSharedValue(dragHandleHitWidth);

  const isDraggingSV = useSharedValue(false);
  const pendingDragIndexSV = useSharedValue(-1);
  const dragFromIndexSV = useSharedValue(-1);
  const dragTargetIndexSV = useSharedValue(-1);
  const fingerYSV = useSharedValue(0);
  const ghostTopSV = useSharedValue(0);
  const dropLineYSV = useSharedValue(0);

  const syncDraggableTopY = useCallback(() => {
    const nextTop =
      contentPaddingTopRef.current +
      headerHeightRef.current +
      leadingRowsHeightRef.current;
    draggableTopYRef.current = nextTop;
    draggableTopYSV.value = nextTop;
  }, [draggableTopYSV]);

  useEffect(() => {
    if (!ListHeaderComponent) {
      headerHeightRef.current = 0;
    }
    syncDraggableTopY();
  }, [contentPaddingTop, leadingRowsHeight, ListHeaderComponent, syncDraggableTopY]);

  useEffect(() => {
    draggableStartSV.value = draggableStart;
    draggableCountSV.value = effectiveDraggableCount;
    rowHeightSV.value = rowHeight;
    rowStrideSV.value = rowStride;
    rowGapSV.value = rowGap;
    dragHandleHitWidthSV.value = dragHandleHitWidth;
  }, [
    draggableStart,
    effectiveDraggableCount,
    rowHeight,
    rowStride,
    rowGap,
    dragHandleHitWidth,
    draggableStartSV,
    draggableCountSV,
    rowHeightSV,
    rowStrideSV,
    rowGapSV,
    dragHandleHitWidthSV,
  ]);

  const stopAutoScroll = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      dragActiveRef.current = false;
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  const tickAutoScroll = useCallback(() => {
    if (!dragActiveRef.current) {
      rafIdRef.current = null;
      return;
    }

    const h = containerHeightRef.current;
    const delta = computeEdgeAutoScrollDelta(fingerYRef.current, h);
    if (delta !== 0) {
      const start = draggableStartRef.current;
      const count = draggableCountRef.current;
      const stride = rowStrideRef.current;
      const topY = draggableTopYRef.current;
      const computedTotal =
        topY +
        count * stride +
        trailingRowsHeightRef.current +
        contentPaddingBottomRef.current;
      const totalHeight = Math.max(computedTotal, contentHeightRef.current);
      const maxOffset = Math.max(0, totalHeight - h);
      const nextOffset = Math.max(0, Math.min(maxOffset, scrollOffsetRef.current + delta));

      if (nextOffset !== scrollOffsetRef.current) {
        scrollOffsetRef.current = nextOffset;
        scrollOffsetSV.value = nextOffset;
        internalListRef.current?.scrollToOffset({ offset: nextOffset, animated: false });

        const targetIdx = contentYToClampedTargetIndex(
          nextOffset + fingerYRef.current,
          topY,
          start,
          count,
          stride,
        );
        if (targetIdx >= 0) {
          if (targetIdx !== dragTargetIndexSV.value) {
            void Haptics.selectionAsync();
          }
          dragTargetIndexSV.value = targetIdx;
          const lineContentY = getUniformDropLineContentY(
            dragFromIndexSV.value,
            targetIdx,
            topY,
            start,
            stride,
            rowGapRef.current,
          );
          const maxDropY = Math.max(0, h - 2);
          dropLineYSV.value = Math.min(maxDropY, Math.max(0, lineContentY - nextOffset));
        }
      }
    }

    rafIdRef.current = requestAnimationFrame(tickAutoScroll);
  }, [dragFromIndexSV, dragTargetIndexSV, dropLineYSV, scrollOffsetSV]);

  const startAutoScroll = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(tickAutoScroll);
    }
  }, [tickAutoScroll]);

  const handleDragStartJS = useCallback(
    (listIdx: number, fingerY: number) => {
      const item = dataRef.current[listIdx];
      if (!item) {
        isDraggingSV.value = false;
        dragFromIndexSV.value = -1;
        dragTargetIndexSV.value = -1;
        return;
      }
      closeOpenRow();
      const key = keyExtractorRef.current(item, listIdx);
      draggedKeyRef.current = key;
      dragActiveRef.current = true;
      fingerYRef.current = fingerY;
      setDraggedKey(key);
      onDragStateChangeRef.current?.(true);
      void Haptics.selectionAsync();
      startAutoScroll();
    },
    [dragFromIndexSV, dragTargetIndexSV, isDraggingSV, startAutoScroll],
  );

  const handleDragTargetChangeJS = useCallback((fingerY: number, targetChanged: boolean) => {
    fingerYRef.current = fingerY;
    if (targetChanged) {
      void Haptics.selectionAsync();
    }
  }, []);

  const handleDragFinishJS = useCallback(
    (_from: number, to: number) => {
      dragActiveRef.current = false;
      stopAutoScroll();
      const key = draggedKeyRef.current;
      draggedKeyRef.current = null;
      setDraggedKey(null);
      onDragStateChangeRef.current?.(false);

      if (key === null || to < 0) return;

      const items = dataRef.current;
      const actualFrom = items.findIndex(
        (item, index) => keyExtractorRef.current(item, index) === key,
      );
      const start = draggableStartRef.current;
      const count = draggableCountRef.current;
      if (count <= 0) return;

      const end = start + count - 1;
      if (actualFrom < start || actualFrom > end) return;

      const clampedTo = Math.max(start, Math.min(end, to));
      if (actualFrom !== clampedTo) {
        onReorderRef.current(actualFrom, clampedTo);
      }
    },
    [stopAutoScroll],
  );

  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .activateAfterLongPress(DRAG_HOLD_DURATION_MS)
      .failOffsetX([-DRAG_HOLD_SLOP_PX, DRAG_HOLD_SLOP_PX])
      .failOffsetY([-DRAG_HOLD_SLOP_PX, DRAG_HOLD_SLOP_PX])
      .maxPointers(1)
      .shouldCancelWhenOutside(false)
      .onTouchesDown((e, stateManager) => {
        'worklet';
        if (
          isDraggingSV.value ||
          e.numberOfTouches !== 1 ||
          e.allTouches.length === 0
        ) {
          pendingDragIndexSV.value = -1;
          stateManager.fail();
          return;
        }
        const touch = e.allTouches[0];
        const w = containerWidthSV.value;
        if (w <= 0 || touch.x < w - dragHandleHitWidthSV.value) {
          pendingDragIndexSV.value = -1;
          stateManager.fail();
          return;
        }

        const contentY = scrollOffsetSV.value + touch.y;
        const listIdx = contentYToDraggableIndex(
          contentY,
          draggableTopYSV.value,
          draggableStartSV.value,
          draggableCountSV.value,
          rowStrideSV.value,
        );
        if (listIdx < 0) {
          pendingDragIndexSV.value = -1;
          stateManager.fail();
          return;
        }
        pendingDragIndexSV.value = listIdx;
      })
      .onStart((e) => {
        'worklet';
        const listIdx = pendingDragIndexSV.value;
        if (listIdx < 0 || isDraggingSV.value) return;
        pendingDragIndexSV.value = -1;
        const touchY = e.y;
        const h = containerHeightSV.value;
        const currentRowHeight = rowHeightSV.value;
        const maxGhostTop = Math.max(0, h - currentRowHeight);
        const maxDropY = Math.max(0, h - 2);

        isDraggingSV.value = true;
        dragFromIndexSV.value = listIdx;
        dragTargetIndexSV.value = listIdx;
        fingerYSV.value = touchY;
        ghostTopSV.value = Math.min(
          maxGhostTop,
          Math.max(0, touchY - currentRowHeight / 2),
        );
        const lineContentY = getUniformDropLineContentY(
          listIdx,
          listIdx,
          draggableTopYSV.value,
          draggableStartSV.value,
          rowStrideSV.value,
          rowGapSV.value,
        );
        dropLineYSV.value = Math.min(
          maxDropY,
          Math.max(0, lineContentY - scrollOffsetSV.value),
        );
        runOnJS(handleDragStartJS)(listIdx, touchY);
      })
      .onTouchesMove((e) => {
        'worklet';
        if (!isDraggingSV.value || e.allTouches.length === 0) return;
        const touchY = e.allTouches[0].y;
        const h = containerHeightSV.value;
        const currentRowHeight = rowHeightSV.value;
        const maxGhostTop = Math.max(0, h - currentRowHeight);
        const maxDropY = Math.max(0, h - 2);

        fingerYSV.value = touchY;
        ghostTopSV.value = Math.min(
          maxGhostTop,
          Math.max(0, touchY - currentRowHeight / 2),
        );

        const targetIdx = contentYToClampedTargetIndex(
          scrollOffsetSV.value + touchY,
          draggableTopYSV.value,
          draggableStartSV.value,
          draggableCountSV.value,
          rowStrideSV.value,
        );
        let didTargetChange = false;
        if (targetIdx >= 0) {
          didTargetChange = targetIdx !== dragTargetIndexSV.value;
          dragTargetIndexSV.value = targetIdx;
          const lineContentY = getUniformDropLineContentY(
            dragFromIndexSV.value,
            targetIdx,
            draggableTopYSV.value,
            draggableStartSV.value,
            rowStrideSV.value,
            rowGapSV.value,
          );
          dropLineYSV.value = Math.min(
            maxDropY,
            Math.max(0, lineContentY - scrollOffsetSV.value),
          );
        }
        runOnJS(handleDragTargetChangeJS)(touchY, didTargetChange);
      })
      .onFinalize(() => {
        'worklet';
        pendingDragIndexSV.value = -1;
        if (!isDraggingSV.value) return;
        const from = dragFromIndexSV.value;
        const to = dragTargetIndexSV.value;
        isDraggingSV.value = false;
        dragFromIndexSV.value = -1;
        dragTargetIndexSV.value = -1;
        runOnJS(handleDragFinishJS)(from, to);
      });
  }, [
    containerHeightSV,
    containerWidthSV,
    dragFromIndexSV,
    dragHandleHitWidthSV,
    dragTargetIndexSV,
    draggableCountSV,
    draggableStartSV,
    draggableTopYSV,
    dropLineYSV,
    fingerYSV,
    ghostTopSV,
    handleDragFinishJS,
    handleDragStartJS,
    handleDragTargetChangeJS,
    isDraggingSV,
    pendingDragIndexSV,
    rowGapSV,
    rowHeightSV,
    rowStrideSV,
    scrollOffsetSV,
  ]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      containerWidthSV.value = width;
      containerHeightSV.value = height;
      containerHeightRef.current = height;
    },
    [containerHeightSV, containerWidthSV],
  );

  const handleHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => {
      headerHeightRef.current = e.nativeEvent.layout.height;
      syncDraggableTopY();
    },
    [syncDraggableTopY],
  );

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    contentHeightRef.current = height;
  }, []);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      scrollOffsetRef.current = y;
      scrollOffsetSV.value = y;
    },
    [scrollOffsetSV],
  );

  const measuredHeader = useMemo(
    () =>
      ListHeaderComponent ? (
        <View testID={`${testID}-header`} onLayout={handleHeaderLayout}>
          {ListHeaderComponent}
        </View>
      ) : null,
    [ListHeaderComponent, handleHeaderLayout, testID],
  );

  const draggedEntry = useMemo(() => {
    if (draggedKey === null) return null;
    for (let i = 0; i < data.length; i += 1) {
      const item = data[i];
      if (keyExtractor(item, i) === draggedKey) {
        return { item, index: i };
      }
    }
    return null;
  }, [data, draggedKey, keyExtractor]);

  const isDragActive = draggedEntry !== null;

  const renderFlashItem = useCallback(
    ({ item, index }: { item: T; index: number }) =>
      renderItem({
        item,
        index,
        isDragging: draggedKey !== null && keyExtractor(item, index) === draggedKey,
      }),
    [draggedKey, keyExtractor, renderItem],
  );

  const ghostAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ghostTopSV.value }, { scale: 1.02 }],
  }));

  const dropLineAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dropLineYSV.value }],
  }));

  return (
    <View testID={testID} style={styles.container} onLayout={handleLayout}>
      <GestureDetector gesture={panGesture}>
        <View style={styles.container}>
          <FlashList
            ref={setFlashListRef}
            data={data}
            renderItem={renderFlashItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            extraData={draggedKey}
            ListHeaderComponent={measuredHeader}
            ListEmptyComponent={ListEmptyComponent}
            drawDistance={drawDistance}
            maintainVisibleContentPosition={{ disabled: true }}
            scrollEnabled={!isDragActive}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            onContentSizeChange={handleContentSizeChange}
            onScrollBeginDrag={onScrollBeginDrag}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            showsVerticalScrollIndicator={showsVerticalScrollIndicator}
            bounces={false}
            overScrollMode="never"
            contentContainerStyle={contentContainerStyle}
          />
        </View>
      </GestureDetector>

      {draggedEntry && (
        <View
          testID={`${testID}-drag-overlay`}
          style={styles.dragOverlay}
          pointerEvents="none"
        >
          <Animated.View
            style={[
              styles.dropIndicator,
              {
                left: dropIndicatorInset,
                right: dropIndicatorInset,
                backgroundColor: accentColor,
              },
              dropLineAnimatedStyle,
            ]}
          />
          <Animated.View
            style={[
              styles.ghostRowContainer,
              {
                left: ghostHorizontalInset,
                right: ghostHorizontalInset,
                height: rowHeight,
              },
              ghostAnimatedStyle,
            ]}
          >
            {renderGhost(draggedEntry.item, draggedEntry.index)}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  dragOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
  },
  dropIndicator: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
  },
  ghostRowContainer: {
    position: 'absolute',
  },
});
