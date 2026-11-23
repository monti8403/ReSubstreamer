jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

const mockHapticsSelection = jest.fn();
jest.mock('../../utils/haptics', () => ({
  selectionAsync: () => mockHapticsSelection(),
}));

const mockCloseOpenRow = jest.fn();
const mockSwipeRightActionsByKey: Record<string, Array<{ onPress: () => void }>> = {};
jest.mock('../../components/SwipeableRow', () => {
  const { View } = require('react-native');
  return {
    SwipeableRow: ({
      children,
      rightActions,
      recyclingKey,
    }: {
      children: React.ReactNode;
      rightActions?: Array<{ onPress: () => void }>;
      recyclingKey?: string;
    }) => {
      if (recyclingKey && rightActions) {
        mockSwipeRightActionsByKey[recyclingKey] = rightActions;
      }
      return <View>{children}</View>;
    },
    closeOpenRow: () => mockCloseOpenRow(),
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
          {props.data?.length === 0 && props.ListEmptyComponent}
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
  onStart?: (e: any) => void;
  onTouchesMove?: (e: any) => void;
  onFinalize?: () => void;
} = {};
jest.mock('react-native-gesture-handler', () => {
  const makePan = () => {
    const g: any = {
      activateAfterLongPress: () => g,
      failOffsetX: () => g,
      failOffsetY: () => g,
      maxPointers: () => g,
      shouldCancelWhenOutside: () => g,
      onTouchesDown: (cb: any) => {
        mockPanCallbacks.onTouchesDown = cb;
        return g;
      },
      onStart: (cb: any) => {
        mockPanCallbacks.onStart = cb;
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
    withTiming: (v: any) => v,
    runOnJS: (fn: Function) => fn,
  };
});

let mockHeaderRight: (() => React.ReactNode) | undefined;
jest.mock('expo-router', () => ({
  useNavigation: () => ({
    setOptions: (opts: { headerRight?: () => React.ReactNode }) => {
      mockHeaderRight = opts.headerRight;
    },
  }),
}));

jest.mock('expo-router/react-navigation', () => {
  const React = require('react');
  return {
    HeaderHeightContext: React.createContext(64),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#121212',
      card: '#1e1e1e',
      inputBg: '#2a2a2a',
      border: '#333333',
      textPrimary: '#ffffff',
      textSecondary: '#aaaaaa',
      primary: '#1D9BF0',
      red: '#e91429',
    },
  }),
}));

const mockAlert = jest.fn();
const mockConfirm = jest.fn();
jest.mock('../../hooks/useThemedAlert', () => ({
  useThemedAlert: () => ({
    alert: (...args: unknown[]) => mockAlert(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
  }),
}));

let mockAppActive = true;
jest.mock('../../hooks/useAppActive', () => ({
  useAppActive: () => mockAppActive,
}));

jest.mock('../../components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
jest.mock('../../components/GradientBackground', () => {
  const { View } = require('react-native');
  return {
    GradientBackground: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('../../components/EmptyState', () => {
  const { Text, View } = require('react-native');
  return {
    EmptyState: ({ title, subtitle }: { title: string; subtitle: string }) => (
      <View testID="empty-state">
        <Text>{title}</Text>
        <Text>{subtitle}</Text>
      </View>
    ),
  };
});

const mockGetDownloadSpeed = jest.fn(() => 2048);
const mockGetActiveDownloadCount = jest.fn(() => 1);
jest.mock('../../services/downloadSpeedTracker', () => ({
  getDownloadSpeed: () => mockGetDownloadSpeed(),
  getActiveDownloadCount: () => mockGetActiveDownloadCount(),
}));

const mockCancelDownload = jest.fn();
const mockClearDownloadQueue = jest.fn();
const mockForceRecoverDownloadsAsync = jest.fn();
const mockRetryDownload = jest.fn();
jest.mock('../../services/musicCacheService', () => ({
  cancelDownload: (...args: unknown[]) => mockCancelDownload(...args),
  clearDownloadQueue: (...args: unknown[]) => mockClearDownloadQueue(...args),
  forceRecoverDownloadsAsync: (...args: unknown[]) => mockForceRecoverDownloadsAsync(...args),
  retryDownload: (...args: unknown[]) => mockRetryDownload(...args),
}));

const mockReorderQueue = jest.fn();
jest.mock('../../store/musicCacheStore', () => {
  const { create } = require('zustand');
  const store = create(() => ({
    downloadQueue: [],
    cachedItems: {},
    maxConcurrentDownloads: 3,
    reorderQueue: (...args: unknown[]) => mockReorderQueue(...args),
  }));
  return { musicCacheStore: store };
});

jest.mock('../../store/connectivityStore', () => {
  const { create } = require('zustand');
  return {
    connectivityStore: create(() => ({
      isServerReachable: true,
      hasConnection: true,
    })),
  };
});

jest.mock('../../store/offlineModeStore', () => {
  const { create } = require('zustand');
  return {
    offlineModeStore: create(() => ({
      offlineMode: false,
    })),
  };
});

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import { connectivityStore } from '../../store/connectivityStore';
import { musicCacheStore, type DownloadQueueItem } from '../../store/musicCacheStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { DownloadQueueScreen } from '../download-queue';

function makeQueueItem(
  queueId: string,
  status: DownloadQueueItem['status'],
  overrides: Partial<DownloadQueueItem> = {},
): DownloadQueueItem {
  return {
    queueId,
    itemId: `item-${queueId}`,
    type: 'album',
    name: `Album ${queueId}`,
    artist: `Artist ${queueId}`,
    totalSongs: 10,
    completedSongs: status === 'downloading' ? 3 : 0,
    status,
    addedAt: 1000,
    queuePosition: 1,
    ...overrides,
  };
}

describe('DownloadQueueScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlashListProps = {};
    mockHeaderRight = undefined;
    mockAppActive = true;
    for (const key of Object.keys(mockSwipeRightActionsByKey)) {
      delete mockSwipeRightActionsByKey[key];
    }
    musicCacheStore.setState({
      downloadQueue: [],
      cachedItems: {},
      maxConcurrentDownloads: 3,
    });
    connectivityStore.setState({
      isServerReachable: true,
      hasConnection: true,
    });
    offlineModeStore.setState({
      offlineMode: false,
    });
  });

  it('renders EmptyState and clears headerRight when the download queue is empty', () => {
    const screen = render(<DownloadQueueScreen />);

    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(mockHeaderRight).toBeUndefined();
    expect(mockFlashListProps.maintainVisibleContentPosition).toEqual({ disabled: true });
  });

  it('sorts downloading -> queued -> error, shows paused notices, top-up progress, and handles header actions', () => {
    const qErr = makeQueueItem('e1', 'error', { error: 'Network timeout', queuePosition: 1 });
    const qQueued = makeQueueItem('q1', 'queued', { queuePosition: 2 });
    const qActive = makeQueueItem('d1', 'downloading', {
      itemId: 'alb-partial',
      completedSongs: 2,
      totalSongs: 5,
      queuePosition: 3,
    });

    musicCacheStore.setState({
      downloadQueue: [qErr, qQueued, qActive],
      cachedItems: {
        'alb-partial': {
          itemId: 'alb-partial',
          type: 'album',
          name: 'Partial Album',
          expectedSongCount: 10,
          songIds: ['s1', 's2', 's3'],
          downloadedAt: 100,
          lastSyncAt: 100,
        },
      },
    });
    offlineModeStore.setState({ offlineMode: true });

    const screen = render(<DownloadQueueScreen />);

    // Sorted display order: d1, q1, e1
    expect(mockFlashListProps.data.map((i: DownloadQueueItem) => i.queueId)).toEqual(['d1', 'q1', 'e1']);
    expect(mockFlashListProps.getItemType(qActive, 0)).toBe('downloading');
    expect(mockFlashListProps.getItemType(qQueued, 1)).toBe('queued');
    expect(mockFlashListProps.getItemType(qErr, 2)).toBe('error');

    // Top-up progress: 3 existing + 2 completed = 5 of 10
    expect(screen.getByText('5 of 10 tracks')).toBeTruthy();
    expect(screen.getByText('Network timeout')).toBeTruthy();
    expect(
      screen.getByText("Downloads are paused while Offline Mode is on. They'll resume automatically when you turn it off."),
    ).toBeTruthy();

    // Unreachable server notice when online but server unreachable
    act(() => {
      offlineModeStore.setState({ offlineMode: false });
      connectivityStore.setState({ isServerReachable: false });
    });
    expect(
      screen.getByText("Your server can't be reached right now, so downloads are waiting. They'll continue once it's back."),
    ).toBeTruthy();

    // Header buttons: Recover & Clear
    expect(mockHeaderRight).toBeDefined();
    const headerJsx = mockHeaderRight!() as any;
    const recoverBtn = headerJsx.props.children[0];
    const clearBtn = headerJsx.props.children[1];

    act(() => {
      recoverBtn.props.onPress();
    });
    expect(mockForceRecoverDownloadsAsync).toHaveBeenCalledTimes(1);

    act(() => {
      clearBtn.props.onPress();
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    act(() => {
      mockConfirm.mock.calls[0][0].onConfirm();
    });
    expect(mockClearDownloadQueue).toHaveBeenCalledTimes(1);
  });

  it('restricts dragging to queued rows, translates display indices to store indices, and clamps drops', () => {
    const d1 = makeQueueItem('d1', 'downloading', { queuePosition: 1 });
    const q1 = makeQueueItem('q1', 'queued', { queuePosition: 2 });
    const q2 = makeQueueItem('q2', 'queued', { queuePosition: 3 });
    const q3 = makeQueueItem('q3', 'queued', { queuePosition: 4 });
    const e1 = makeQueueItem('e1', 'error', { queuePosition: 5 });

    // Store deliberately not in sorted display order
    musicCacheStore.setState({
      downloadQueue: [e1, q1, d1, q2, q3],
    });

    const screen = render(<DownloadQueueScreen />);

    fireEvent(screen.getByTestId('download-queue-reorderable-list'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    fireEvent(screen.getByTestId('download-queue-reorderable-list-header'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 100 } },
    });

    // Geometry: contentPaddingTop=64 + header=100 + leadingRowsHeight(1*114)=114 => draggableTopY = 278
    // Touch outside right 80px handle band (x = 200 < 320) -> fail
    const leftSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 200, y: 310 }] },
        leftSM,
      );
    });
    expect(leftSM.fail).toHaveBeenCalled();

    // Touch downloading row handle (y = 220 < 278) -> fail
    const activeSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 360, y: 220 }] },
        activeSM,
      );
    });
    expect(activeSM.fail).toHaveBeenCalled();

    // Touch error row handle (queued range is [278, 278 + 3*94 = 560); y = 590 >= 560) -> fail
    const errorSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 360, y: 590 }] },
        errorSM,
      );
    });
    expect(errorSM.fail).toHaveBeenCalled();

    // Grab q1 (display index 1, y = 310) and drag past bottom into error section (y = 700)
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 360, y: 310 }] },
        dragSM,
      );
    });
    act(() => {
      mockPanCallbacks.onStart?.({ y: 310 });
    });
    expect(screen.getByTestId('download-queue-reorderable-list-drag-overlay')).toBeTruthy();

    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 360, y: 700 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    // Clamped target is display index 3 (q3). In store [e1(0), q1(1), d1(2), q2(3), q3(4)]: q1=1 -> q3=4
    expect(mockReorderQueue).toHaveBeenCalledWith(1, 4);

    // Mid-drag completion of downloading item: grab q1 (display index 1, y=310), drag to q2 (y=400),
    // then d1 finishes leaving [q1, q2, q3, e1] -> q1 is now at store index 1, q2 at 2
    mockReorderQueue.mockClear();
    const drag2SM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 360, y: 310 }] },
        drag2SM,
      );
    });
    act(() => {
      mockPanCallbacks.onStart?.({ y: 310 });
    });
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 360, y: 400 }],
      });
    });
    act(() => {
      musicCacheStore.setState({
        downloadQueue: [e1, q1, q2, q3],
      });
    });
    // Now d1 is gone so draggableTopY shifted from 278 to 164; moving finger to y=260 targets q2 (index 1)
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 360, y: 260 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });
    expect(mockReorderQueue).toHaveBeenCalledWith(1, 2);
  });

  it('handles retry on error rows and swipe removal confirmation only for active downloads', () => {
    const d1 = makeQueueItem('d1', 'downloading', { artist: undefined });
    const q1 = makeQueueItem('q1', 'queued');
    const e1 = makeQueueItem('e1', 'error');

    musicCacheStore.setState({
      downloadQueue: [d1, q1, e1],
    });

    const screen = render(<DownloadQueueScreen />);

    // Tap retry icon on error row
    const retryIcon = screen.getByTestId('icon-refresh');
    fireEvent.press(retryIcon);
    expect(mockRetryDownload).toHaveBeenCalledWith('e1');

    // Swipe remove queued row -> cancels immediately without confirmation alert
    act(() => {
      mockSwipeRightActionsByKey.q1[0].onPress();
    });
    expect(mockCancelDownload).toHaveBeenCalledWith('q1');
    expect(mockAlert).not.toHaveBeenCalled();

    // Swipe remove downloading row -> asks confirmation alert first
    act(() => {
      mockSwipeRightActionsByKey.d1[0].onPress();
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const buttons = mockAlert.mock.calls[0][2];
    act(() => {
      buttons[1].onPress();
    });
    expect(mockCancelDownload).toHaveBeenCalledWith('d1');
  });
});
