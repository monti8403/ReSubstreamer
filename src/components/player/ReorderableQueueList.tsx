import Ionicons from '@react-native-vector-icons/ionicons/static';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Pressable,
  StyleSheet,
  Text,
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

import { CachedImage } from '@/components/CachedImage';
import { QUEUE_ROW_HEIGHT, QueueItemRow } from '@/components/QueueItemRow';
import { closeOpenRow } from '@/components/SwipeableRow';
import { type ThemeColors } from '@/constants/theme';
import {
  calculateReorderPlan,
  usePartitionedQueue,
  type QueueListItem,
  type TrackQueueListItem,
} from '@/hooks/usePartitionedQueue';
import { useSongCoverArt } from '@/hooks/useSongCoverArt';
import { reorderQueue } from '@/services/moreOptionsService';
import { clearUserQueue } from '@/services/playerService';
import { type Child } from '@/services/subsonicService';
import { playerStore } from '@/store/playerStore';
import { formatTrackDuration } from '@/utils/formatters';
import * as Haptics from '@/utils/haptics';
import { ensureQueueKey } from '@/utils/queueKeys';

import { QueueSectionHeader } from './QueueSectionHeader';
import {
  computeEdgeAutoScrollDelta,
  contentYToListIndex,
  contentYToTargetIndex,
  DRAG_HANDLE_HIT_WIDTH,
  DRAG_HOLD_DURATION_MS,
  DRAG_HOLD_SLOP_PX,
  getDropLineContentY,
  getTotalContentHeight,
} from './queueDragMath';

const SCROLL_TO_TOP_THRESHOLD = 450;

export interface ReorderableQueueListProps {
  queue: Child[];
  currentTrackIndex: number | null;
  colors: ThemeColors;
  queueColors: ThemeColors;
  onItemPress: (absoluteIndex: number) => void;
  onItemLongPress: (track: Child) => void;
  contentContainerStyle?: StyleProp<ViewStyle>;
  listRef?: React.RefObject<FlashListRef<QueueListItem> | null>;
  onDragStateChange?: (dragging: boolean) => void;
}

interface DragGhostRowProps {
  track: Child;
  colors: ThemeColors;
}

const DragGhostRow = memo(function DragGhostRow({ track, colors }: DragGhostRowProps) {
  const coverArtId = useSongCoverArt(track);
  const durationText = track.duration != null ? formatTrackDuration(track.duration) : '—';

  return (
    <View
      style={[
        styles.ghostRowInner,
        {
          backgroundColor: colors.card,
          borderColor: colors.primary,
        },
      ]}
    >
      <View style={styles.ghostCoverWrap}>
        <CachedImage
          coverArtId={coverArtId}
          size={50}
          style={styles.ghostCover}
          resizeMode="cover"
        />
      </View>
      <View style={styles.ghostInfo}>
        <View style={styles.ghostLine}>
          <Text style={[styles.ghostTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={[styles.ghostDuration, { color: colors.textSecondary }]}>
            {durationText}
          </Text>
        </View>
        {track.artist ? (
          <Text style={[styles.ghostArtist, { color: colors.textSecondary }]} numberOfLines={1}>
            {track.artist}
          </Text>
        ) : null}
      </View>
      <View style={styles.ghostHandle}>
        <Ionicons name="reorder-three-outline" size={24} color={colors.primary} />
      </View>
    </View>
  );
});

/**
 * Shared FlashList-based queue renderer with container-level ghost-row drag
 * reordering, horizontal row swipes, and a floating scroll-to-top pill for
 * long queues.
 */
export const ReorderableQueueList = memo(function ReorderableQueueList({
  queue,
  currentTrackIndex,
  colors,
  queueColors,
  onItemPress,
  onItemLongPress,
  contentContainerStyle,
  listRef,
  onDragStateChange,
}: ReorderableQueueListProps) {
  const { t } = useTranslation();

  const userQueueKeys = playerStore((s) => s.userQueueKeys);
  const userQueueTrackIds = playerStore((s) => s.userQueueTrackIds);
  const activeUserQueueFilter =
    userQueueKeys.length > 0 ? userQueueKeys : userQueueTrackIds;

  const {
    nowPlaying,
    reorderableListItems,
    userQueueCount,
    nextUpCount,
  } = usePartitionedQueue(queue, currentTrackIndex, activeUserQueueFilter);

  const hasNowPlaying = Boolean(nowPlaying);

  const internalListRef = useRef<FlashListRef<QueueListItem> | null>(null);
  const setFlashListRef = useCallback(
    (instance: FlashListRef<QueueListItem> | null) => {
      internalListRef.current = instance;
      if (listRef) {
        (listRef as { current: FlashListRef<QueueListItem> | null }).current = instance;
      }
    },
    [listRef],
  );

  const [draggedIndex, setDraggedIndex] = useState(-1);
  const [showScrollToTop, setShowScrollToTop] = useState(false);

  const showScrollToTopRef = useRef(false);
  const scrollOffsetRef = useRef(0);
  const containerHeightRef = useRef(0);
  const fingerYRef = useRef(0);
  const dragActiveRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  const reorderableItemsRef = useRef(reorderableListItems);
  reorderableItemsRef.current = reorderableListItems;
  const currentTrackIndexRef = useRef(currentTrackIndex);
  currentTrackIndexRef.current = currentTrackIndex;
  const countsRef = useRef({ hasNowPlaying, userQueueCount, nextUpCount });
  countsRef.current = { hasNowPlaying, userQueueCount, nextUpCount };

  const containerWidthSV = useSharedValue(0);
  const containerHeightSV = useSharedValue(0);
  const scrollOffsetSV = useSharedValue(0);
  const hasNowPlayingSV = useSharedValue(hasNowPlaying);
  const userQueueCountSV = useSharedValue(userQueueCount);
  const nextUpCountSV = useSharedValue(nextUpCount);

  useEffect(() => {
    hasNowPlayingSV.value = hasNowPlaying;
    userQueueCountSV.value = userQueueCount;
    nextUpCountSV.value = nextUpCount;
  }, [hasNowPlaying, userQueueCount, nextUpCount, hasNowPlayingSV, userQueueCountSV, nextUpCountSV]);

  const isDraggingSV = useSharedValue(false);
  const pendingDragIndexSV = useSharedValue(-1);
  const dragFromIndexSV = useSharedValue(-1);
  const dragTargetIndexSV = useSharedValue(-1);
  const fingerYSV = useSharedValue(0);
  const ghostTopSV = useSharedValue(0);
  const dropLineYSV = useSharedValue(0);

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
      const { hasNowPlaying: np, userQueueCount: uq, nextUpCount: nu } = countsRef.current;
      const maxOffset = Math.max(0, getTotalContentHeight(np, uq, nu) - h);
      const nextOffset = Math.max(0, Math.min(maxOffset, scrollOffsetRef.current + delta));

      if (nextOffset !== scrollOffsetRef.current) {
        scrollOffsetRef.current = nextOffset;
        scrollOffsetSV.value = nextOffset;
        internalListRef.current?.scrollToOffset({ offset: nextOffset, animated: false });

        const targetIdx = contentYToTargetIndex(nextOffset + fingerYRef.current, np, uq, nu);
        if (targetIdx >= 0) {
          if (targetIdx !== dragTargetIndexSV.value) {
            void Haptics.selectionAsync();
          }
          dragTargetIndexSV.value = targetIdx;
          const lineContentY = getDropLineContentY(
            dragFromIndexSV.value,
            targetIdx,
            np,
            uq,
            nu,
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
      closeOpenRow();
      dragActiveRef.current = true;
      fingerYRef.current = fingerY;
      setDraggedIndex(listIdx);
      onDragStateChange?.(true);
      void Haptics.selectionAsync();
      startAutoScroll();
    },
    [onDragStateChange, startAutoScroll],
  );

  const handleDragTargetChangeJS = useCallback((fingerY: number, targetChanged: boolean) => {
    fingerYRef.current = fingerY;
    if (targetChanged) {
      void Haptics.selectionAsync();
    }
  }, []);

  const handleDragFinishJS = useCallback(
    (from: number, to: number) => {
      dragActiveRef.current = false;
      stopAutoScroll();
      setDraggedIndex(-1);
      onDragStateChange?.(false);

      if (from < 0 || to < 0) return;

      const plan = calculateReorderPlan(
        reorderableItemsRef.current,
        from,
        to,
        currentTrackIndexRef.current ?? 0,
      );
      if (!plan) return;

      const currentKeys = playerStore.getState().userQueueKeys;
      const keysChanged =
        plan.newUserQueueKeys.length !== currentKeys.length ||
        plan.newUserQueueKeys.some((k, idx) => k !== currentKeys[idx]);

      if (plan.fromAbsoluteIndex !== plan.toAbsoluteIndex || keysChanged) {
        void reorderQueue(
          plan.fromAbsoluteIndex,
          plan.toAbsoluteIndex,
          plan.newUserQueueKeys,
        );
      }
    },
    [onDragStateChange, stopAutoScroll],
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
        if (w <= 0 || touch.x < w - DRAG_HANDLE_HIT_WIDTH) {
          pendingDragIndexSV.value = -1;
          stateManager.fail();
          return;
        }
        const contentY = scrollOffsetSV.value + touch.y;
        const listIdx = contentYToListIndex(
          contentY,
          hasNowPlayingSV.value,
          userQueueCountSV.value,
          nextUpCountSV.value,
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
        const maxGhostTop = Math.max(0, h - QUEUE_ROW_HEIGHT);
        const maxDropY = Math.max(0, h - 2);

        isDraggingSV.value = true;
        dragFromIndexSV.value = listIdx;
        dragTargetIndexSV.value = listIdx;
        fingerYSV.value = touchY;
        ghostTopSV.value = Math.min(
          maxGhostTop,
          Math.max(0, touchY - QUEUE_ROW_HEIGHT / 2),
        );
        const lineContentY = getDropLineContentY(
          listIdx,
          listIdx,
          hasNowPlayingSV.value,
          userQueueCountSV.value,
          nextUpCountSV.value,
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
        const maxGhostTop = Math.max(0, h - QUEUE_ROW_HEIGHT);
        const maxDropY = Math.max(0, h - 2);

        fingerYSV.value = touchY;
        ghostTopSV.value = Math.min(
          maxGhostTop,
          Math.max(0, touchY - QUEUE_ROW_HEIGHT / 2),
        );

        const targetIdx = contentYToTargetIndex(
          scrollOffsetSV.value + touchY,
          hasNowPlayingSV.value,
          userQueueCountSV.value,
          nextUpCountSV.value,
        );
        let didTargetChange = false;
        if (targetIdx >= 0) {
          didTargetChange = targetIdx !== dragTargetIndexSV.value;
          dragTargetIndexSV.value = targetIdx;
          const lineContentY = getDropLineContentY(
            dragFromIndexSV.value,
            targetIdx,
            hasNowPlayingSV.value,
            userQueueCountSV.value,
            nextUpCountSV.value,
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
    dragTargetIndexSV,
    dropLineYSV,
    fingerYSV,
    ghostTopSV,
    handleDragFinishJS,
    handleDragStartJS,
    handleDragTargetChangeJS,
    hasNowPlayingSV,
    isDraggingSV,
    nextUpCountSV,
    pendingDragIndexSV,
    scrollOffsetSV,
    userQueueCountSV,
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

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      scrollOffsetRef.current = y;
      scrollOffsetSV.value = y;
      const shouldShow = y > SCROLL_TO_TOP_THRESHOLD;
      if (shouldShow !== showScrollToTopRef.current) {
        showScrollToTopRef.current = shouldShow;
        setShowScrollToTop(shouldShow);
      }
    },
    [scrollOffsetSV],
  );

  const handleScrollToTop = useCallback(() => {
    void Haptics.selectionAsync();
    internalListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const handleClearUserQueue = useCallback(() => {
    void clearUserQueue();
  }, []);

  const draggedItem: QueueListItem | null =
    draggedIndex >= 0 && draggedIndex < reorderableListItems.length
      ? reorderableListItems[draggedIndex]
      : null;
  const draggedTrackItem: TrackQueueListItem | null =
    draggedItem && draggedItem.type === 'track' ? draggedItem : null;
  const draggedItemId = draggedTrackItem ? draggedTrackItem.id : null;

  const nowPlayingHeader = useMemo(
    () =>
      nowPlaying ? (
        <View>
          <QueueSectionHeader
            title={t('nowPlayingHeader')}
            count={1}
            colors={colors}
          />
          <QueueItemRow
            track={nowPlaying}
            index={currentTrackIndex ?? 0}
            isActive={true}
            isInUserQueue={false}
            queueKey={ensureQueueKey(nowPlaying)}
            colors={queueColors}
            onPress={onItemPress}
            onLongPress={onItemLongPress}
          />
        </View>
      ) : null,
    [nowPlaying, t, colors, currentTrackIndex, queueColors, onItemPress, onItemLongPress],
  );

  const renderItem = useCallback(
    ({ item }: { item: QueueListItem }) => {
      if (item.type === 'header') {
        const title =
          item.section === 'nowPlaying'
            ? t('nowPlayingHeader')
            : item.section === 'userQueue'
              ? t('userQueue')
              : t('nextUp');

        return (
          <QueueSectionHeader
            title={title}
            count={item.count}
            onClear={item.section === 'userQueue' ? handleClearUserQueue : undefined}
            colors={colors}
          />
        );
      }

      return (
        <QueueItemRow
          track={item.track}
          index={item.absoluteIndex}
          isActive={item.isNowPlaying}
          isInUserQueue={Boolean(item.isUserQueue)}
          queueKey={item.id}
          isDragging={item.id === draggedItemId}
          colors={queueColors}
          onPress={onItemPress}
          onLongPress={onItemLongPress}
        />
      );
    },
    [
      t,
      handleClearUserQueue,
      colors,
      draggedItemId,
      queueColors,
      onItemPress,
      onItemLongPress,
    ],
  );

  const keyExtractor = useCallback((item: QueueListItem) => item.id, []);
  const getItemType = useCallback((item: QueueListItem) => item.type, []);

  const ghostAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ghostTopSV.value }, { scale: 1.02 }],
  }));

  const dropLineAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dropLineYSV.value }],
  }));

  const isDragActive = draggedTrackItem !== null;

  return (
    <View
      testID="reorderable-queue-container"
      style={styles.container}
      onLayout={handleLayout}
    >
      <GestureDetector gesture={panGesture}>
        <View style={styles.container}>
          <FlashList
            ref={setFlashListRef}
            data={reorderableListItems}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            extraData={draggedItemId}
            ListHeaderComponent={nowPlayingHeader}
            drawDistance={350}
            maintainVisibleContentPosition={{ disabled: true }}
            scrollEnabled={!isDragActive}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            onScrollBeginDrag={closeOpenRow}
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
            contentContainerStyle={contentContainerStyle}
          />
        </View>
      </GestureDetector>

      {draggedTrackItem && (
        <View style={styles.dragOverlay} pointerEvents="none">
          <Animated.View
            style={[
              styles.dropIndicator,
              { backgroundColor: colors.primary },
              dropLineAnimatedStyle,
            ]}
          />
          <Animated.View style={[styles.ghostRowContainer, ghostAnimatedStyle]}>
            <DragGhostRow track={draggedTrackItem.track} colors={colors} />
          </Animated.View>
        </View>
      )}

      {showScrollToTop && !isDragActive && (
        <Pressable
          testID="queue-scroll-to-top"
          onPress={handleScrollToTop}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('scrollToTop')}
          style={({ pressed }) => [
            styles.scrollToTopPill,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="chevron-up" size={16} color={colors.textPrimary} />
          <Text style={[styles.scrollToTopText, { color: colors.textPrimary }]}>
            {t('scrollToTop')}
          </Text>
        </Pressable>
      )}
    </View>
  );
});

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
    left: 16,
    right: 16,
    height: 2,
    borderRadius: 1,
  },
  ghostRowContainer: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: QUEUE_ROW_HEIGHT,
  },
  ghostRowInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  ghostCoverWrap: {
    width: 40,
    height: 40,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  ghostCover: {
    width: 40,
    height: 40,
  },
  ghostInfo: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
  },
  ghostLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ghostTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: '600',
  },
  ghostDuration: {
    fontSize: 14,
  },
  ghostArtist: {
    fontSize: 14,
    marginTop: 2,
  },
  ghostHandle: {
    marginLeft: 8,
  },
  scrollToTopPill: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  scrollToTopText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
});
