jest.mock('@/store/persistence/kvStorage', () =>
  require('@/store/persistence/__mocks__/kvStorage'),
);

const mockHapticsSelection = jest.fn();
jest.mock('@/utils/haptics', () => ({
  selectionAsync: () => mockHapticsSelection(),
}));

const mockClearUserQueue = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/playerService', () => ({
  clearUserQueue: (...args: unknown[]) => mockClearUserQueue(...args),
}));

const mockReorderQueue = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/moreOptionsService', () => ({
  reorderQueue: (...args: unknown[]) => mockReorderQueue(...args),
}));

jest.mock('@/hooks/useSongCoverArt', () => ({
  useSongCoverArt: (track: { id: string }) => `cover-${track.id}`,
}));

jest.mock('@/components/CachedImage', () => {
  const { View } = require('react-native');
  return {
    CachedImage: ({ coverArtId }: { coverArtId?: string }) => (
      <View testID={`cached-image-${coverArtId ?? 'none'}`} />
    ),
  };
});

jest.mock('@/components/SwipeableRow', () => ({
  closeOpenRow: jest.fn(),
}));

const mockRenderedRowProps: Record<string, any> = {};
jest.mock('@/components/QueueItemRow', () => {
  const { Pressable, Text } = require('react-native');
  return {
    QUEUE_ROW_HEIGHT: 64,
    QueueItemRow: (props: any) => {
      mockRenderedRowProps[props.queueKey ?? props.track.id] = props;
      return (
        <Pressable
          testID={`queue-row-${props.track.id}-${props.index}`}
          onPress={() => props.onPress(props.index)}
          onLongPress={() => props.onLongPress?.(props.track)}
        >
          <Text>{props.track.title}</Text>
        </Pressable>
      );
    },
  };
});

const mockScrollToOffset = jest.fn();
let mockFlashListProps: any = {};
jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(props: any, ref: any) {
      mockFlashListProps = props;
      React.useImperativeHandle(ref, () => ({
        scrollToOffset: mockScrollToOffset,
      }));
      return (
        <View testID="flash-list">
          {props.ListHeaderComponent}
          {props.data?.map((item: any, index: number) => (
            <View key={props.keyExtractor ? props.keyExtractor(item, index) : String(index)}>
              {props.renderItem({ item, index })}
            </View>
          ))}
        </View>
      );
    }),
  };
});

const mockPanCallbacks: {
  onTouchesDown?: (e: any, stateManager: any) => void;
  onTouchesMove?: (e: any) => void;
  onFinalize?: () => void;
} = {};
jest.mock('react-native-gesture-handler', () => {
  const makePan = () => {
    const g: any = {
      manualActivation: () => g,
      shouldCancelWhenOutside: () => g,
      onTouchesDown: (cb: any) => {
        mockPanCallbacks.onTouchesDown = cb;
        return g;
      },
      onTouchesMove: (cb: any) => {
        mockPanCallbacks.onTouchesMove = cb;
        return g;
      },
      onFinalize: (cb: any) => {
        mockPanCallbacks.onFinalize = cb;
        return g;
      },
    };
    return g;
  };
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: {
      Pan: makePan,
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: any) => React.useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    runOnJS: (fn: Function) => fn,
  };
});

import React, { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { type FlashListRef } from '@shopify/flash-list';

import { type ThemeColors } from '@/constants/theme';
import { type QueueListItem } from '@/hooks/usePartitionedQueue';
import { type Child } from '@/services/subsonicService';
import { playerStore } from '@/store/playerStore';
import { ensureQueueKey } from '@/utils/queueKeys';

import { ReorderableQueueList } from '../ReorderableQueueList';

const mockColors = {
  background: '#121212',
  card: '#181818',
  textPrimary: '#ffffff',
  textSecondary: '#b3b3b3',
  label: '#888888',
  border: 'rgba(255,255,255,0.08)',
  primary: '#1D9BF0',
  red: '#e91429',
  green: '#30D158',
  orange: '#FF9F0A',
  partialDownload: '#FF9F0A',
  inputBg: '#282828',
} as ThemeColors;

const makeTrack = (id: string, title = `Track ${id}`): Child =>
  ({
    id,
    title,
    artist: `Artist ${id}`,
    duration: 180,
    isDir: false,
    parent: 'p',
  }) as Child;

describe('ReorderableQueueList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlashListProps = {};
    for (const key of Object.keys(mockRenderedRowProps)) {
      delete mockRenderedRowProps[key];
    }
    playerStore.setState({
      queue: [],
      currentTrack: null,
      currentTrackIndex: null,
      userQueueKeys: [],
      userQueueTrackIds: [],
    });
  });

  it('configures FlashList v2 with maintainVisibleContentPosition disabled and renders partitioned sections', () => {
    const t0 = makeTrack('t0', 'Now Playing Song');
    const u1 = makeTrack('u1', 'Queued Song');
    const n1 = makeTrack('n1', 'Next Up Song 1');
    const n2 = makeTrack('n2', 'Next Up Song 2');
    const queue = [t0, u1, n1, n2];
    const u1Key = ensureQueueKey(u1);

    playerStore.setState({
      queue,
      currentTrack: t0,
      currentTrackIndex: 0,
      userQueueKeys: [u1Key],
      userQueueTrackIds: ['u1'],
    });

    const onItemPress = jest.fn();
    const onItemLongPress = jest.fn();

    const { getByText, getByLabelText } = render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={0}
        colors={mockColors}
        queueColors={mockColors}
        onItemPress={onItemPress}
        onItemLongPress={onItemLongPress}
      />,
    );

    expect(mockFlashListProps.maintainVisibleContentPosition).toEqual({ disabled: true });
    expect(mockFlashListProps.drawDistance).toBe(350);

    expect(getByText('Now Playing Song')).toBeTruthy();
    expect(getByText('Queued Song')).toBeTruthy();
    expect(getByText('Next Up Song 1')).toBeTruthy();
    expect(getByText('Next Up Song 2')).toBeTruthy();

    fireEvent.press(getByText('Next Up Song 1'));
    expect(onItemPress).toHaveBeenCalledWith(2);

    fireEvent(getByText('Next Up Song 2'), 'longPress');
    expect(onItemLongPress).toHaveBeenCalledWith(n2);

    fireEvent.press(getByLabelText('Clear Queue'));
    expect(mockClearUserQueue).toHaveBeenCalledTimes(1);
  });

  it('shows the Back to top pill only after scrolling past 450px and scrolls to offset 0 on press', () => {
    const tracks = [makeTrack('t0'), makeTrack('t1'), makeTrack('t2')];
    const listRef = createRef<FlashListRef<QueueListItem> | null>();

    const { queryByTestId, getByTestId } = render(
      <ReorderableQueueList
        queue={tracks}
        currentTrackIndex={0}
        colors={mockColors}
        queueColors={mockColors}
        onItemPress={jest.fn()}
        onItemLongPress={jest.fn()}
        listRef={listRef}
      />,
    );

    expect(queryByTestId('queue-scroll-to-top')).toBeNull();

    act(() => {
      mockFlashListProps.onScroll({ nativeEvent: { contentOffset: { y: 500 } } });
    });

    const pill = getByTestId('queue-scroll-to-top');
    expect(pill).toBeTruthy();

    fireEvent.press(pill);
    expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    expect(mockHapticsSelection).toHaveBeenCalled();

    act(() => {
      mockFlashListProps.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
    });
    expect(queryByTestId('queue-scroll-to-top')).toBeNull();
  });

  it('handles drag gesture activation only in right handle band and commits reorder on release', () => {
    const t0 = makeTrack('t0', 'Song 0');
    const n1 = makeTrack('n1', 'Song 1');
    const n2 = makeTrack('n2', 'Song 2');
    const n3 = makeTrack('n3', 'Song 3');
    const queue = [t0, n1, n2, n3];
    const onDragStateChange = jest.fn();

    const { getByTestId, getByText, queryByText } = render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={0}
        colors={mockColors}
        queueColors={mockColors}
        onItemPress={jest.fn()}
        onItemLongPress={jest.fn()}
        onDragStateChange={onDragStateChange}
      />,
    );

    // Measure outer container
    fireEvent(getByTestId('reorderable-queue-container'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 600 } },
    });

    // Touch outside the right-hand drag handle band (x = 120 < 400 - 56) -> fail
    const failSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 120, y: 170 }] },
        failSM,
      );
    });
    expect(failSM.fail).toHaveBeenCalled();
    expect(failSM.activate).not.toHaveBeenCalled();

    // Touch on Next Up header (y = 120) -> fail
    const headerSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 120 }] },
        headerSM,
      );
    });
    expect(headerSM.fail).toHaveBeenCalled();
    expect(headerSM.activate).not.toHaveBeenCalled();

    // Touch handle on Song 1 (y = 170 -> index 1 in reorderableListItems: header=0, Song1=1)
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 170 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();
    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(mockFlashListProps.scrollEnabled).toBe(false);
    expect(mockRenderedRowProps[ensureQueueKey(n1)]?.isDragging).toBe(true);

    // Drag down onto Song 3 (y = 300 -> index 3 in reorderableListItems)
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 380, y: 300 }],
      });
    });

    // Release
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    expect(onDragStateChange).toHaveBeenCalledWith(false);
    expect(mockFlashListProps.scrollEnabled).toBe(true);
    expect(mockReorderQueue).toHaveBeenCalledWith(1, 3, []);
    expect(queryByText('Song 1')).toBeTruthy();
  });

  it('renders empty queue gracefully without crashing', () => {
    const { queryByTestId } = render(
      <ReorderableQueueList
        queue={[]}
        currentTrackIndex={null}
        colors={mockColors}
        queueColors={mockColors}
        onItemPress={jest.fn()}
        onItemLongPress={jest.fn()}
      />,
    );
    expect(queryByTestId('queue-scroll-to-top')).toBeNull();
    expect(mockFlashListProps.data).toEqual([]);
  });

  it('auto-scrolls near viewport edges via rAF, rejects multi-touch, and commits cross-section promotion', () => {
    const rafQueue: Array<(t: number) => void> = [];
    const rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
    const cafSpy = jest
      .spyOn(global, 'cancelAnimationFrame')
      .mockImplementation(() => {});

    try {
      const tracks = Array.from({ length: 20 }, (_, i) => makeTrack(`s${i}`, `Song ${i}`));
      const u1Key = ensureQueueKey(tracks[1]);
      playerStore.setState({
        queue: tracks,
        currentTrack: tracks[0],
        currentTrackIndex: 0,
        userQueueKeys: [u1Key],
        userQueueTrackIds: ['s1'],
      });

      const { getByTestId } = render(
        <ReorderableQueueList
          queue={tracks}
          currentTrackIndex={0}
          colors={mockColors}
          queueColors={mockColors}
          onItemPress={jest.fn()}
          onItemLongPress={jest.fn()}
        />,
      );

      fireEvent(getByTestId('reorderable-queue-container'), 'layout', {
        nativeEvent: { layout: { width: 400, height: 300 } },
      });

      // Multi-touch must fail immediately
      const multiSM = { activate: jest.fn(), fail: jest.fn() };
      act(() => {
        mockPanCallbacks.onTouchesDown?.(
          { numberOfTouches: 2, allTouches: [{ x: 380, y: 170 }, { x: 200, y: 180 }] },
          multiSM,
        );
      });
      expect(multiSM.fail).toHaveBeenCalled();

      // Single-touch near bottom edge (y = 280 in 300px viewport) activates drag + triggers bottom autoscroll
      const dragSM = { activate: jest.fn(), fail: jest.fn() };
      act(() => {
        mockPanCallbacks.onTouchesDown?.(
          { numberOfTouches: 1, allTouches: [{ x: 380, y: 280 }] },
          dragSM,
        );
      });
      expect(dragSM.activate).toHaveBeenCalled();
      expect(rafQueue.length).toBeGreaterThan(0);

      act(() => {
        for (let f = 0; f < 6; f += 1) {
          const nextFrame = rafQueue.shift();
          nextFrame?.((f + 1) * 16);
        }
      });
      expect(mockScrollToOffset).toHaveBeenCalledWith(
        expect.objectContaining({ offset: expect.any(Number), animated: false }),
      );

      // Drag back near top edge then release onto user queue header region
      act(() => {
        mockPanCallbacks.onTouchesMove?.({
          numberOfTouches: 1,
          allTouches: [{ x: 380, y: 150 }],
        });
      });
      act(() => {
        mockPanCallbacks.onFinalize?.();
      });
      expect(mockReorderQueue).toHaveBeenCalled();

      // Any trailing queued frame cleanly stops when dragActiveRef is false
      act(() => {
        const trailing = rafQueue.shift();
        trailing?.(32);
      });
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });

  it('promotes a Next Up track without metadata while preserving keys when absolute index stays equal', () => {
    const t0 = makeTrack('t0', 'Now Playing');
    const u1 = makeTrack('u1', 'User Queued');
    const noMetaTrack = { id: 'nometa', title: 'No Meta', isDir: false, parent: 'p' } as Child;
    const smallQueue = [t0, u1, noMetaTrack];
    playerStore.setState({
      queue: smallQueue,
      currentTrack: t0,
      currentTrackIndex: 0,
      userQueueKeys: [ensureQueueKey(u1)],
      userQueueTrackIds: ['u1'],
    });

    const { getByTestId } = render(
      <ReorderableQueueList
        queue={smallQueue}
        currentTrackIndex={0}
        colors={mockColors}
        queueColors={mockColors}
        onItemPress={jest.fn()}
        onItemLongPress={jest.fn()}
      />,
    );

    fireEvent(getByTestId('reorderable-queue-container'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 600 } },
    });

    // Layout: ListHeader(106) + 0:UQ hdr(42->148) + 1:u1(64->212) + 2:NextUp hdr(42->254) + 3:nometa(64->318)
    // Touch at y=280 grabs nometa (absIdx=2); dragging to y=220 drops onto NextUp header -> promotes with keysChanged=true at absIdx 2.
    const promoSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 280 }] },
        promoSM,
      );
    });
    expect(promoSM.activate).toHaveBeenCalled();

    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 380, y: 220 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    expect(mockReorderQueue).toHaveBeenCalledWith(
      2,
      2,
      [ensureQueueKey(u1), ensureQueueKey(noMetaTrack)],
    );
  });
});
