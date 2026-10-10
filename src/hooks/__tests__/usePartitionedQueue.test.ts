import { partitionQueue, calculateReorderPlan } from '../usePartitionedQueue';
import type { Child } from '../../services/subsonicService';

function makeTrack(id: string, title: string): Child {
  return {
    id,
    title,
    parent: 'parent',
    isDir: false,
  } as Child;
}

describe('usePartitionedQueue / partitionQueue', () => {
  it('handles empty queue gracefully', () => {
    const result = partitionQueue([], 0, []);
    expect(result.nowPlaying).toBeNull();
    expect(result.visibleQueue).toEqual([]);
    expect(result.queueListItems).toEqual([]);
    expect(result.userQueueCount).toBe(0);
    expect(result.nextUpCount).toBe(0);
    expect(result.isNowPlayingHeader(0)).toBe(false);
    expect(result.isUserQueueHeader(0)).toBe(false);
    expect(result.isContextQueueHeader(0)).toBe(false);
  });

  it('handles queue with only currently playing track', () => {
    const t0 = makeTrack('0', 'Track 0');
    const result = partitionQueue([t0], 0, []);
    expect(result.nowPlaying).toBe(t0);
    expect(result.visibleQueue).toEqual([t0]);
    expect(result.userQueueCount).toBe(0);
    expect(result.nextUpCount).toBe(0);
    expect(result.isNowPlayingHeader(0)).toBe(true);
    expect(result.isUserQueueHeader(1)).toBe(false);
    expect(result.isContextQueueHeader(1)).toBe(false);

    expect(result.queueListItems).toHaveLength(2);
    expect(result.queueListItems[0]).toEqual({
      type: 'header',
      id: 'section-header-now-playing',
      section: 'nowPlaying',
      titleKey: 'nowPlayingHeader',
    });
    expect(result.queueListItems[1]).toMatchObject({
      type: 'track',
      track: t0,
      isNowPlaying: true,
      relativeTrackIndex: 0,
      absoluteIndex: 0,
    });
  });

  it('partitions clean order [nowPlaying] -> [userQueue] -> [nextUp]', () => {
    const t0 = makeTrack('0', 'Now Playing');
    const u1 = makeTrack('u1', 'User Track 1');
    const u2 = makeTrack('u2', 'User Track 2');
    const n1 = makeTrack('n1', 'NextUp Track 1');
    const n2 = makeTrack('n2', 'NextUp Track 2');

    // Feed in interleaved array to prove partitioning fixes ordering
    const originalQueue = [t0, n1, u1, n2, u2];
    const userQueueTrackIds = ['u1', 'u2'];

    const result = partitionQueue(originalQueue, 0, userQueueTrackIds);

    expect(result.nowPlaying).toBe(t0);
    expect(result.userQueue).toEqual([u1, u2]);
    expect(result.nextUp).toEqual([n1, n2]);
    expect(result.visibleQueue).toEqual([t0, u1, u2, n1, n2]);

    expect(result.userQueueStartIndex).toBe(1);
    expect(result.userQueueCount).toBe(2);
    expect(result.nextUpStartIndex).toBe(3);
    expect(result.nextUpCount).toBe(2);
    expect(result.minDraggableIndex).toBe(1);

    // Test separate queueListItems
    // Indices:
    // 0: Header(nowPlaying)
    // 1: Track(t0)
    // 2: Header(userQueue)
    // 3: Track(u1)
    // 4: Track(u2)
    // 5: Header(contextQueue)
    // 6: Track(n1)
    // 7: Track(n2)
    expect(result.queueListItems).toHaveLength(8);
    expect(result.queueListItems[0]).toMatchObject({ type: 'header', section: 'nowPlaying' });
    expect(result.queueListItems[1]).toMatchObject({ type: 'track', track: t0, isNowPlaying: true });
    expect(result.queueListItems[2]).toMatchObject({ type: 'header', section: 'userQueue', count: 2 });
    expect(result.queueListItems[3]).toMatchObject({ type: 'track', track: u1, isNowPlaying: false });
    expect(result.queueListItems[4]).toMatchObject({ type: 'track', track: u2, isNowPlaying: false });
    expect(result.queueListItems[5]).toMatchObject({ type: 'header', section: 'contextQueue' });
    expect(result.queueListItems[6]).toMatchObject({ type: 'track', track: n1, isNowPlaying: false });
    expect(result.queueListItems[7]).toMatchObject({ type: 'track', track: n2, isNowPlaying: false });
  });

  it('handles empty userQueue correctly (only nowPlaying + nextUp)', () => {
    const t0 = makeTrack('0', 'Now Playing');
    const n1 = makeTrack('n1', 'NextUp Track 1');
    const n2 = makeTrack('n2', 'NextUp Track 2');

    const result = partitionQueue([t0, n1, n2], 0, []);

    expect(result.nowPlaying).toBe(t0);
    expect(result.userQueueCount).toBe(0);
    expect(result.nextUpCount).toBe(2);
    expect(result.visibleQueue).toEqual([t0, n1, n2]);

    // Indices:
    // 0: Header(nowPlaying)
    // 1: Track(t0)
    // 2: Header(contextQueue)
    // 3: Track(n1)
    // 4: Track(n2)
    expect(result.queueListItems).toHaveLength(5);
    expect(result.queueListItems[0]).toMatchObject({ type: 'header', section: 'nowPlaying' });
    expect(result.queueListItems[1]).toMatchObject({ type: 'track', track: t0 });
    expect(result.queueListItems[2]).toMatchObject({ type: 'header', section: 'contextQueue' });
    expect(result.queueListItems[3]).toMatchObject({ type: 'track', track: n1 });
    expect(result.queueListItems[4]).toMatchObject({ type: 'track', track: n2 });
  });

  describe('calculateReorderPlan', () => {
    const t0 = makeTrack('0', 'Now Playing');
    const u1 = makeTrack('u1', 'User Track 1');
    const u2 = makeTrack('u2', 'User Track 2');
    const n1 = makeTrack('n1', 'NextUp Track 1');
    const n2 = makeTrack('n2', 'NextUp Track 2');

    // List structure:
    // 0: Header(nowPlaying)
    // 1: Track(t0, isNowPlaying: true)
    // 2: Header(userQueue)
    // 3: Track(u1)
    // 4: Track(u2)
    // 5: Header(contextQueue)
    // 6: Track(n1)
    // 7: Track(n2)
    const { queueListItems } = partitionQueue([t0, u1, u2, n1, n2], 0, ['u1', 'u2']);

    it('rejects dragging headers or active track', () => {
      // Dragging Header(nowPlaying) at index 0
      expect(calculateReorderPlan(queueListItems, 0, 3, 0)).toBeNull();
      // Dragging Track(t0) at index 1
      expect(calculateReorderPlan(queueListItems, 1, 3, 0)).toBeNull();
      // Dragging Header(userQueue) at index 2
      expect(calculateReorderPlan(queueListItems, 2, 4, 0)).toBeNull();
      // Out of bounds
      expect(calculateReorderPlan(queueListItems, -1, 3, 0)).toBeNull();
      expect(calculateReorderPlan(queueListItems, 99, 3, 0)).toBeNull();
    });

    it('dropping directly on Header(userQueue) places track as first user queue item', () => {
      // Drag n1 (index 6) to index 2 (Header userQueue)
      const plan = calculateReorderPlan(queueListItems, 6, 2, 0);
      expect(plan).not.toBeNull();
      // It should land at index 1 among tracks (right after active track t0)
      expect(plan?.toAbsoluteIndex).toBe(1);
      // It should be promoted to user queue at the first position
      expect(plan?.newUserQueueTrackIds).toEqual(['n1', 'u1', 'u2']);
    });

    it('dropping directly on Header(contextQueue) promotes from below to userQueue, demotes from above to nextUp', () => {
      // Drag n2 (index 7) up onto Header(contextQueue) at index 5
      const planFromBelow = calculateReorderPlan(queueListItems, 7, 5, 0);
      expect(planFromBelow).not.toBeNull();
      // Added to the end of userQueue (after u1 and u2)
      expect(planFromBelow?.toAbsoluteIndex).toBe(3);
      expect(planFromBelow?.newUserQueueTrackIds).toEqual(['u1', 'u2', 'n2']);

      // Drag u1 (index 3) down onto Header(contextQueue) at index 5
      const planFromAbove = calculateReorderPlan(queueListItems, 3, 5, 0);
      expect(planFromAbove).not.toBeNull();
      // Demoted: becomes first track in nextUp
      expect(planFromAbove?.newUserQueueTrackIds).toEqual(['u2']);
    });

    it('promotes track when dragged from nextUp into userQueue', () => {
      // Drag n2 (index 7) to index 4 (between u1 and u2)
      const plan = calculateReorderPlan(queueListItems, 7, 4, 0);
      expect(plan).not.toBeNull();
      expect(plan?.newUserQueueTrackIds).toEqual(['u1', 'n2', 'u2']);
    });

    it('demotes track when dragged from userQueue into nextUp', () => {
      // Drag u1 (index 3) to index 7 (after n1)
      const plan = calculateReorderPlan(queueListItems, 3, 7, 0);
      expect(plan).not.toBeNull();
      expect(plan?.newUserQueueTrackIds).toEqual(['u2']);
    });

    it('promotes next-up track when userQueue is empty and dragged above Header(contextQueue)', () => {
      // Empty user queue list:
      // 0: Header(nowPlaying)
      // 1: Track(t0)
      // 2: Header(contextQueue)
      // 3: Track(n1)
      // 4: Track(n2)
      const emptyUserRes = partitionQueue([t0, n1, n2], 0, []);
      // Drag n1 (index 3) to index 1 or 2 (above Header contextQueue)
      const plan = calculateReorderPlan(emptyUserRes.queueListItems, 3, 1, 0);
      expect(plan).not.toBeNull();
      expect(plan?.toAbsoluteIndex).toBe(1);
      expect(plan?.newUserQueueTrackIds).toEqual(['n1']);
    });

    it('reorderableListItems excludes nowPlaying and allows promoting to userQueue at index 0', () => {
      // With reorderableListItems (Now Playing in ListHeaderComponent):
      // 0: Header(contextQueue)
      // 1: Track(n1)
      // 2: Track(n2)
      const emptyUserRes = partitionQueue([t0, n1, n2], 0, []);
      expect(emptyUserRes.reorderableListItems.length).toBe(3);
      expect(emptyUserRes.reorderableListItems[0].type).toBe('header');
      expect((emptyUserRes.reorderableListItems[0] as any).section).toBe('contextQueue');

      // Drag n1 (index 1) to index 0 (onto/above Header contextQueue)
      const plan = calculateReorderPlan(emptyUserRes.reorderableListItems, 1, 0, 0);
      expect(plan).not.toBeNull();
      expect(plan?.toAbsoluteIndex).toBe(1);
      expect(plan?.newUserQueueTrackIds).toEqual(['n1']);
    });
  });
});
