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

jest.mock('../../components/TrackRow', () => {
  const { Text, View } = require('react-native');
  return {
    TrackRow: ({ track }: { track: { id: string; title: string } }) => (
      <View testID={`normal-row-${track.id}`}>
        <Text>{track.title}</Text>
      </View>
    ),
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
      const items = props.data ?? [];
      const visibleItems = items.length > 50 ? items.slice(0, 20) : items;
      return (
        <View testID="flash-list">
          {props.ListHeaderComponent}
          {items.length === 0 && props.ListEmptyComponent}
          {visibleItems.map((item: any, index: number) => (
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

let mockHeaderLeft: (() => React.ReactNode) | undefined;
let mockHeaderRight: (() => React.ReactNode) | undefined;
jest.mock('expo-router', () => {
  const { TouchableOpacity, Text, View } = require('react-native');
  const Toolbar = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  Toolbar.Button = (props: any) => {
    const labelText = typeof props.children === 'string' ? props.children : props.icon;
    return (
      <TouchableOpacity
        testID={props.testID ?? `toolbar-button-${labelText}`}
        onPress={props.onPress}
      >
        <Text>{labelText}</Text>
      </TouchableOpacity>
    );
  };
  Toolbar.View = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return {
    useLocalSearchParams: () => ({ id: 'pl-1' }),
    useNavigation: () => ({
      setOptions: (opts: { headerLeft?: () => React.ReactNode; headerRight?: () => React.ReactNode }) => {
        if ('headerLeft' in opts) mockHeaderLeft = opts.headerLeft;
        if ('headerRight' in opts) mockHeaderRight = opts.headerRight;
      },
    }),
    Stack: { Toolbar },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }),
}));
const mockThemeColors = {
  background: '#121212',
  card: '#1e1e1e',
  inputBg: '#2a2a2a',
  border: '#333333',
  textPrimary: '#ffffff',
  textSecondary: '#aaaaaa',
  primary: '#1D9BF0',
  red: '#e91429',
};
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: mockThemeColors }),
}));
jest.mock('../../hooks/useTransitionComplete', () => ({ useTransitionComplete: () => true }));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'none' }));
jest.mock('../../hooks/useLayoutMode', () => ({ useLayoutMode: () => 'compact' }));
jest.mock('../../hooks/useRefreshControlKey', () => ({ useRefreshControlKey: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({
  useSongCoverArt: (t: { id: string }) => `ca-${t.id}`,
}));
jest.mock('../../components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
jest.mock('../../components/DownloadButton', () => ({ DownloadButton: () => null }));
jest.mock('../../components/MoreOptionsButton', () => ({ MoreOptionsButton: () => null }));
jest.mock('../../components/MarqueeText', () => {
  const { Text } = require('react-native');
  return { MarqueeText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text> };
});
jest.mock('../../components/BottomChrome', () => ({ BottomChrome: () => null }));
jest.mock('../../components/DetailScreenBackground', () => ({ DetailScreenBackground: () => null }));
jest.mock('../../components/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../../components/DetailHeroButtons', () => ({
  PlayAllButton: () => null,
  ShufflePlayButton: () => null,
}));

const mockFetchPlaylistDetail = jest.fn();
jest.mock('../../services/detailFetchService', () => ({
  fetchPlaylistDetail: (...args: unknown[]) => mockFetchPlaylistDetail(...args),
}));

const mockSyncCachedPlaylistTracks = jest.fn();
jest.mock('../../services/musicCacheService', () => ({
  enqueuePlaylistDownload: jest.fn(),
  syncCachedPlaylistTracks: (...args: unknown[]) => mockSyncCachedPlaylistTracks(...args),
}));

jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  refreshCoverArt: jest.fn(),
}));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));

const mockUpdatePlaylistOrder = jest.fn();
const mockUpdatePlaylistDetails = jest.fn();
jest.mock('../../services/subsonicService', () => ({
  updatePlaylistOrder: (...args: unknown[]) => mockUpdatePlaylistOrder(...args),
  updatePlaylistDetails: (...args: unknown[]) => mockUpdatePlaylistDetails(...args),
}));

jest.mock('../../store/persistence/db', () => ({ getDb: () => null }));
jest.mock('../../db/repository/details', () => ({ getPlaylistDetail: jest.fn() }));
jest.mock('../../store/authStore', () => ({
  authStore: Object.assign(
    (sel: (s: { username: string }) => unknown) => sel({ username: 'tester' }),
    { getState: () => ({ username: 'tester' }) },
  ),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: Object.assign(
    (sel: (s: { offlineMode: boolean }) => unknown) => sel({ offlineMode: false }),
    { getState: () => ({ offlineMode: false }) },
  ),
}));

let mockCachedItems: Record<string, unknown> = {};
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: Object.assign(
    (sel: (s: { cachedItems: Record<string, unknown> }) => unknown) =>
      sel({ cachedItems: mockCachedItems }),
    { getState: () => ({ cachedItems: mockCachedItems }) },
  ),
}));

const mockBumpLibraryUpdated = jest.fn();
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: mockBumpLibraryUpdated }) },
}));

const mockShowError = jest.fn();
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: {
    getState: () => ({ show: jest.fn(), hide: jest.fn(), showError: mockShowError }),
  },
  runWithOverlay: jest.fn(),
}));

import React from 'react';
import { Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { type Child, type PlaylistWithSongs } from '../../services/subsonicService';
import { PlaylistDetailScreen } from '../playlist-detail';

function makeTrack(id: string, title = `Track ${id}`): Child {
  return {
    id,
    title,
    artist: `Artist ${id}`,
    duration: 120,
    isDir: false,
    parent: 'p',
  } as Child;
}

function enterEditMode(screen: ReturnType<typeof render>) {
  if (Platform.OS === 'ios') {
    const pencilBtn = screen.getByTestId('toolbar-button-pencil');
    act(() => {
      fireEvent.press(pencilBtn);
    });
  } else {
    const headerJsx = mockHeaderRight!() as any;
    const editBtn = headerJsx.props.children[1];
    act(() => {
      editBtn.props.onPress();
    });
  }
}

function pressSave(screen: ReturnType<typeof render>) {
  if (Platform.OS === 'ios') {
    const saveBtn = screen.getByTestId('toolbar-button-Save');
    act(() => {
      fireEvent.press(saveBtn);
    });
  } else {
    const headerJsx = mockHeaderRight!() as any;
    act(() => {
      headerJsx.props.onPress();
    });
  }
}

function pressCancel(screen: ReturnType<typeof render>) {
  if (Platform.OS === 'ios') {
    const cancelBtn = screen.getByTestId('toolbar-button-Cancel');
    act(() => {
      fireEvent.press(cancelBtn);
    });
  } else {
    const headerJsx = mockHeaderLeft!() as any;
    act(() => {
      headerJsx.props.onPress();
    });
  }
}

function layoutEditList(screen: ReturnType<typeof render>, headerHeight = 200) {
  fireEvent(screen.getByTestId('playlist-edit-reorderable-list'), 'layout', {
    nativeEvent: { layout: { width: 400, height: 700 } },
  });
  fireEvent(screen.getByTestId('playlist-edit-reorderable-list-header'), 'layout', {
    nativeEvent: { layout: { width: 400, height: headerHeight } },
  });
}

describe('PlaylistDetailScreen — edit mode with ReorderableFlashList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlashListProps = {};
    mockHeaderLeft = undefined;
    mockHeaderRight = undefined;
    mockCachedItems = {};
    for (const key of Object.keys(mockSwipeRightActionsByKey)) {
      delete mockSwipeRightActionsByKey[key];
    }
    mockUpdatePlaylistOrder.mockResolvedValue(true);
    mockUpdatePlaylistDetails.mockResolvedValue(true);
  });

  it('keeps ListHeaderComponent identity stable across typing and drag reordering, then saves updated metadata and order', async () => {
    const playlist: PlaylistWithSongs = {
      id: 'pl-1',
      name: 'Road Trip',
      comment: 'Original note',
      public: false,
      songCount: 3,
      duration: 360,
      owner: 'tester',
      entry: [
        makeTrack('s1', 'Song One'),
        makeTrack('s2', 'Song Two'),
        makeTrack('s3', 'Song Three'),
      ],
    };
    mockFetchPlaylistDetail.mockResolvedValue(playlist);

    const screen = render(<PlaylistDetailScreen />);
    await screen.findByTestId('normal-row-s1');

    enterEditMode(screen);
    await screen.findByTestId('playlist-edit-reorderable-list');
    expect(mockFlashListProps.maintainVisibleContentPosition).toEqual({ disabled: true });

    // Capture the outer ListHeaderComponent wrapper reference before typing and dragging
    const headerWrapperBefore = mockFlashListProps.ListHeaderComponent;
    expect(headerWrapperBefore).toBeTruthy();

    layoutEditList(screen, 200);

    // Edit name and multiline description without causing parent re-renders
    const nameInput = screen.getByPlaceholderText('Playlist Name');
    const commentInput = screen.getByPlaceholderText('Description (optional)');
    fireEvent.changeText(nameInput, '  Weekend Mix  ');
    fireEvent.changeText(commentInput, 'Updated note');
    expect(mockFlashListProps.ListHeaderComponent === headerWrapperBefore).toBe(true);

    // paddingTop = insets.top (40) + HEADER_BAR_HEIGHT (44) = 84; header = 200 => draggableTopY = 284
    // Row 0 [284, 348), Row 1 [348, 412), Row 2 [412, 476)
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 370, y: 310 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();

    // Drag Row 0 down to Row 2
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 370, y: 430 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    // Order is now Song Two, Song Three, Song One; ListHeaderComponent wrapper identity stays identical
    expect(mockFlashListProps.ListHeaderComponent === headerWrapperBefore).toBe(true);
    expect(screen.getByText('1. Song Two')).toBeTruthy();
    expect(screen.getByText('2. Song Three')).toBeTruthy();
    expect(screen.getByText('3. Song One')).toBeTruthy();

    // Toggle public switch
    fireEvent(screen.getByLabelText('Public playlist'), 'valueChange', true);

    await act(async () => {
      pressSave(screen);
    });

    await waitFor(() => {
      expect(mockUpdatePlaylistOrder).toHaveBeenCalledWith('pl-1', 'Weekend Mix', ['s2', 's3', 's1']);
      expect(mockUpdatePlaylistDetails).toHaveBeenCalledWith('pl-1', {
        name: 'Weekend Mix',
        comment: 'Updated note',
        public: true,
      });
    });
    expect(mockBumpLibraryUpdated).toHaveBeenCalled();
  });

  it('handles duplicate tracks (including shared object refs) cleanly on drag and swipe-delete', async () => {
    const repeated = makeTrack('s1', 'Encore');
    const middle = makeTrack('s2', 'Interlude');
    const playlist: PlaylistWithSongs = {
      id: 'pl-1',
      name: 'Repeats',
      songCount: 3,
      duration: 360,
      owner: 'tester',
      entry: [repeated, middle, repeated],
    };
    mockFetchPlaylistDetail.mockResolvedValue(playlist);
    mockCachedItems = { 'pl-1': { itemId: 'pl-1', type: 'playlist', songIds: ['s1', 's2', 's1'] } };

    const screen = render(<PlaylistDetailScreen />);
    await screen.findByTestId('normal-row-s2');

    enterEditMode(screen);
    await screen.findByTestId('playlist-edit-reorderable-list');
    layoutEditList(screen, 200);

    // Every duplicate instance must have a unique key
    const keys = mockFlashListProps.data.map((item: Child, i: number) =>
      mockFlashListProps.keyExtractor(item, i),
    );
    expect(new Set(keys).size).toBe(3);

    // Drag first Encore (index 0, y=310) onto second Encore (index 2, y=430)
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 370, y: 310 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 370, y: 430 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    // Order is now [Interlude, Encore, Encore]
    expect(screen.getByText('1. Interlude')).toBeTruthy();
    expect(screen.getByText('2. Encore')).toBeTruthy();
    expect(screen.getByText('3. Encore')).toBeTruthy();

    // Swipe-delete only the second item (index 1, key keys[0] which moved to index 1)
    const movedKey = mockFlashListProps.keyExtractor(mockFlashListProps.data[1], 1);
    act(() => {
      mockSwipeRightActionsByKey[movedKey][0].onPress();
    });

    expect(mockFlashListProps.data).toHaveLength(2);
    expect(screen.getByText('1. Interlude')).toBeTruthy();
    expect(screen.getByText('2. Encore')).toBeTruthy();

    await act(async () => {
      pressSave(screen);
    });

    await waitFor(() => {
      expect(mockUpdatePlaylistOrder).toHaveBeenCalledWith('pl-1', 'Repeats', ['s2', 's1']);
      expect(mockSyncCachedPlaylistTracks).toHaveBeenCalledWith('pl-1', ['s2', 's1'], {
        allowFullClear: true,
      });
    });
  });

  it('reorders a large 1,500-track playlist after scrolling and supports cancel / empty-name guard', async () => {
    const manyTracks = Array.from({ length: 1500 }, (_, i) =>
      makeTrack(`t${i}`, `Track ${i}`),
    );
    const playlist: PlaylistWithSongs = {
      id: 'pl-1',
      name: 'Mega Playlist',
      songCount: 1500,
      duration: 1500 * 120,
      owner: 'tester',
      entry: manyTracks,
    };
    mockFetchPlaylistDetail.mockResolvedValue(playlist);

    const screen = render(<PlaylistDetailScreen />);
    await screen.findByTestId('playlist-edit-reorderable-list').catch(() => null);
    await waitFor(() => expect(mockFlashListProps.data?.length).toBe(1500));

    enterEditMode(screen);
    await screen.findByTestId('playlist-edit-reorderable-list');
    layoutEditList(screen, 200);

    // Simulate scrolled down to index ~1000:
    // draggableTopY = 284; row 1000 top = 284 + 1000*64 = 64284
    act(() => {
      mockFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 64284 } } });
    });

    // Touch y=32 -> contentY = 64316 -> index 1000; move to y=160 -> contentY = 64444 -> index 1002
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 370, y: 32 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();

    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 370, y: 160 }],
      });
    });
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });

    expect(mockFlashListProps.data[1000].id).toBe('t1001');
    expect(mockFlashListProps.data[1001].id).toBe('t1002');
    expect(mockFlashListProps.data[1002].id).toBe('t1000');

    // Empty name validation blocks save and stays in edit mode
    fireEvent.changeText(screen.getByPlaceholderText('Playlist Name'), '   ');
    await act(async () => {
      pressSave(screen);
    });
    expect(mockShowError).toHaveBeenCalled();
    expect(mockUpdatePlaylistOrder).not.toHaveBeenCalled();

    // Cancel exits edit mode cleanly
    pressCancel(screen);
    await waitFor(() => {
      expect(screen.queryByTestId('playlist-edit-reorderable-list')).toBeNull();
    });
  });
});
