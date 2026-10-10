import { useMemo } from 'react';
import type { Child } from '../services/subsonicService';

export type HeaderSection = 'nowPlaying' | 'userQueue' | 'contextQueue';

export interface HeaderQueueListItem {
  type: 'header';
  id: string;
  section: HeaderSection;
  titleKey: 'nowPlayingHeader' | 'userQueue' | 'nextUp';
  count?: number;
}

export interface TrackQueueListItem {
  type: 'track';
  id: string;
  track: Child;
  isNowPlaying: boolean;
  relativeTrackIndex: number;
  absoluteIndex: number;
}

export type QueueListItem = HeaderQueueListItem | TrackQueueListItem;

export interface PartitionedQueue {
  nowPlaying: Child | null;
  userQueue: Child[];
  nextUp: Child[];
  visibleQueue: Child[];
  queueListItems: QueueListItem[];
  reorderableListItems: QueueListItem[];
  userQueueStartIndex: number;
  userQueueCount: number;
  nextUpStartIndex: number;
  nextUpCount: number;
  minDraggableIndex: number;
  isNowPlayingHeader: (relativeIndex: number) => boolean;
  isUserQueueHeader: (relativeIndex: number) => boolean;
  isContextQueueHeader: (relativeIndex: number) => boolean;
}

export interface ReorderPlan {
  fromAbsoluteIndex: number;
  toAbsoluteIndex: number;
  newUserQueueTrackIds: string[];
}

export function partitionQueue(
  queue: Child[],
  currentTrackIndex: number | null | undefined,
  userQueueTrackIds: readonly string[],
): PartitionedQueue {
  const activeIndex = currentTrackIndex ?? 0;
  if (!queue || queue.length === 0) {
    return {
      nowPlaying: null,
      userQueue: [],
      nextUp: [],
      visibleQueue: [],
      queueListItems: [],
      reorderableListItems: [],
      userQueueStartIndex: 0,
      userQueueCount: 0,
      nextUpStartIndex: 0,
      nextUpCount: 0,
      minDraggableIndex: 0,
      isNowPlayingHeader: () => false,
      isUserQueueHeader: () => false,
      isContextQueueHeader: () => false,
    };
  }

  const nowPlaying =
    activeIndex >= 0 && activeIndex < queue.length ? queue[activeIndex] : null;
  const upcoming = queue.slice(activeIndex + 1);

  const userQueueSet = new Set(userQueueTrackIds);
  const userQueue = upcoming.filter((item) => userQueueSet.has(item.id));
  const nextUp = upcoming.filter((item) => !userQueueSet.has(item.id));

  const visibleQueue = nowPlaying
    ? [nowPlaying, ...userQueue, ...nextUp]
    : [...userQueue, ...nextUp];

  const userQueueStartIndex = nowPlaying ? 1 : 0;
  const userQueueCount = userQueue.length;
  const nextUpStartIndex = userQueueStartIndex + userQueueCount;
  const nextUpCount = nextUp.length;
  const minDraggableIndex = userQueueStartIndex;

  const findAbsoluteIndex = (track: Child): number => {
    const queueKey = (track as any)._queueKey;
    if (queueKey) {
      const byKey = queue.findIndex(
        (t, i) => i >= activeIndex && (t as any)._queueKey === queueKey,
      );
      if (byKey >= 0) return byKey;
    }
    const found = queue.findIndex(
      (t, i) => i >= activeIndex && t.id === track.id,
    );
    return found >= 0 ? found : activeIndex;
  };

  const queueListItems: QueueListItem[] = [];
  const reorderableListItems: QueueListItem[] = [];

  if (nowPlaying) {
    queueListItems.push({
      type: 'header',
      id: 'section-header-now-playing',
      section: 'nowPlaying',
      titleKey: 'nowPlayingHeader',
    });
    queueListItems.push({
      type: 'track',
      id: (nowPlaying as any)._queueKey || `track-${nowPlaying.id}-active`,
      track: nowPlaying,
      isNowPlaying: true,
      relativeTrackIndex: 0,
      absoluteIndex: activeIndex,
    });
  }

  if (userQueueCount > 0) {
    const userHeader: HeaderQueueListItem = {
      type: 'header',
      id: 'section-header-user-queue',
      section: 'userQueue',
      titleKey: 'userQueue',
      count: userQueueCount,
    };
    queueListItems.push(userHeader);
    reorderableListItems.push(userHeader);

    userQueue.forEach((track, idx) => {
      const relIdx = userQueueStartIndex + idx;
      const trackItem: TrackQueueListItem = {
        type: 'track',
        id: (track as any)._queueKey || `track-${track.id}-${relIdx}`,
        track,
        isNowPlaying: false,
        relativeTrackIndex: relIdx,
        absoluteIndex: findAbsoluteIndex(track),
      };
      queueListItems.push(trackItem);
      reorderableListItems.push(trackItem);
    });
  }

  if (nextUpCount > 0) {
    const nextUpHeader: HeaderQueueListItem = {
      type: 'header',
      id: 'section-header-next-up',
      section: 'contextQueue',
      titleKey: 'nextUp',
    };
    queueListItems.push(nextUpHeader);
    reorderableListItems.push(nextUpHeader);

    nextUp.forEach((track, idx) => {
      const relIdx = nextUpStartIndex + idx;
      const trackItem: TrackQueueListItem = {
        type: 'track',
        id: (track as any)._queueKey || `track-${track.id}-${relIdx}`,
        track,
        isNowPlaying: false,
        relativeTrackIndex: relIdx,
        absoluteIndex: findAbsoluteIndex(track),
      };
      queueListItems.push(trackItem);
      reorderableListItems.push(trackItem);
    });
  }

  return {
    nowPlaying,
    userQueue,
    nextUp,
    visibleQueue,
    queueListItems,
    reorderableListItems,
    userQueueStartIndex,
    userQueueCount,
    nextUpStartIndex,
    nextUpCount,
    minDraggableIndex,
    isNowPlayingHeader: (relativeIndex: number) =>
      Boolean(nowPlaying) && relativeIndex === 0,
    isUserQueueHeader: (relativeIndex: number) =>
      userQueueCount > 0 && relativeIndex === userQueueStartIndex,
    isContextQueueHeader: (relativeIndex: number) =>
      nextUpCount > 0 && relativeIndex === nextUpStartIndex,
  };
}

export function calculateReorderPlan(
  queueListItems: QueueListItem[],
  from: number,
  to: number,
  activeIndex: number,
): ReorderPlan | null {
  if (from < 0 || from >= queueListItems.length) return null;
  const fromItem = queueListItems[from];
  if (fromItem.type !== 'track' || fromItem.isNowPlaying) return null;

  const hasNowPlaying = queueListItems.some(
    (i) => i.type === 'track' && i.isNowPlaying,
  );

  const nowPlayingIdx = hasNowPlaying
    ? queueListItems.findIndex((i) => i.type === 'track' && i.isNowPlaying)
    : -1;
  const minAllowedListIdx = nowPlayingIdx >= 0 ? nowPlayingIdx + 1 : 0;

  // Clamped target list index
  const clampedTo = Math.max(minAllowedListIdx, Math.min(to, queueListItems.length - 1));

  // First, extract the item from a copy of the list
  const nextList = [...queueListItems];
  const [removed] = nextList.splice(from, 1) as TrackQueueListItem[];

  // Find header positions in the list without the removed item
  const userHeaderIdxInNext = nextList.findIndex(
    (i) => i.type === 'header' && i.section === 'userQueue',
  );
  const contextHeaderIdxInNext = nextList.findIndex(
    (i) => i.type === 'header' && i.section === 'contextQueue',
  );

  let insertAt = clampedTo;
  const targetItem = queueListItems[clampedTo];

  if (targetItem.type === 'header') {
    if (targetItem.section === 'userQueue') {
      // Cannot place above the user queue header; place as the first user queue item
      insertAt = userHeaderIdxInNext >= 0 ? userHeaderIdxInNext + 1 : 0;
    } else if (targetItem.section === 'contextQueue') {
      if (from > clampedTo) {
        // Dragged UP from contextQueue onto/above contextQueue header:
        // Place immediately BEFORE contextQueue header (i.e. at the end of userQueue,
        // or as the only item of userQueue if userQueue was empty).
        insertAt = contextHeaderIdxInNext >= 0 ? contextHeaderIdxInNext : 0;
      } else {
        // Dragged DOWN from userQueue onto contextQueue header:
        // Demote to contextQueue: place immediately AFTER contextQueue header.
        insertAt = contextHeaderIdxInNext >= 0 ? contextHeaderIdxInNext + 1 : nextList.length;
      }
    } else if (targetItem.section === 'nowPlaying') {
      insertAt = userHeaderIdxInNext >= 0 ? userHeaderIdxInNext + 1 : minAllowedListIdx;
    }
  }

  insertAt = Math.max(0, Math.min(insertAt, nextList.length));
  nextList.splice(insertAt, 0, removed);

  // Extract updated track list from simulated list
  const trackItems = nextList.filter(
    (item): item is TrackQueueListItem => item.type === 'track',
  );

  // Find where the Next Up header is in nextList
  const updatedNextUpHeaderIdx = nextList.findIndex(
    (item) => item.type === 'header' && item.section === 'contextQueue',
  );

  // All tracks before Next Up header and after Now Playing are in user queue
  const newUserQueueTrackIds = nextList
    .slice(0, updatedNextUpHeaderIdx >= 0 ? updatedNextUpHeaderIdx : undefined)
    .filter(
      (item): item is TrackQueueListItem =>
        item.type === 'track' && !item.isNowPlaying,
    )
    .map((item) => item.track.id);

  const movedTrackIdx = trackItems.findIndex((i) => i.track.id === removed.track.id);
  if (hasNowPlaying && movedTrackIdx <= 0) {
    // Cannot displace active track
    return null;
  }

  const fromAbsoluteIndex = fromItem.absoluteIndex;
  const toAbsoluteIndex = hasNowPlaying
    ? activeIndex + movedTrackIdx
    : activeIndex + 1 + movedTrackIdx;

  return {
    fromAbsoluteIndex,
    toAbsoluteIndex,
    newUserQueueTrackIds,
  };
}

export function usePartitionedQueue(
  queue: Child[],
  currentTrackIndex: number | null | undefined,
  userQueueTrackIds: readonly string[],
): PartitionedQueue {
  return useMemo(
    () => partitionQueue(queue, currentTrackIndex, userQueueTrackIds),
    [queue, currentTrackIndex, userQueueTrackIds],
  );
}
