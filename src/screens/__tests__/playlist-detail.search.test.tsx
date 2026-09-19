jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Child } from '../../services/subsonicService';
import type { TrackRowProps } from '../../components/TrackRow';

const mockTrackRowProps: TrackRowProps[] = [];
jest.mock('../../components/TrackRow', () => {
  const { Text, View } = require('react-native');
  return {
    TrackRow: (props: TrackRowProps) => {
      mockTrackRowProps.push(props);
      return (
        <View testID={`track-row-${props.track.id}`}>
          <Text testID={`title-${props.track.id}`}>{props.track.title}</Text>
        </View>
      );
    },
  };
});

jest.mock('@shopify/flash-list', () => {
  const { View } = require('react-native');
  return {
    FlashList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0 && ListEmptyComponent}
        {data.map((item, index) => (
          <View key={(item as any)?.id ?? index}>{renderItem({ item, index })}</View>
        ))}
      </View>
    ),
  };
});
jest.mock('react-native-reorderable-list', () => {
  const { View } = require('react-native');
  const ReorderableList = () => <View />;
  return {
    __esModule: true,
    default: ReorderableList,
    ReorderableListItem: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    useReorderableDrag: () => jest.fn(),
  };
});

let mockHeaderRight: (() => React.ReactNode) | undefined;
jest.mock('expo-router', () => {
  const { TouchableOpacity, Text, View } = require('react-native');
  const Toolbar = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  Toolbar.Button = (props: any) => (
    <TouchableOpacity testID={props.testID ?? `toolbar-button-${props.icon}`} onPress={props.onPress}>
      <Text>{props.icon}</Text>
    </TouchableOpacity>
  );
  Toolbar.View = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return {
    useLocalSearchParams: () => ({ id: 'pl-1' }),
    useNavigation: () => ({
      setOptions: (opts: { headerRight?: () => React.ReactNode }) => {
        if (opts.headerRight) mockHeaderRight = opts.headerRight;
      },
    }),
    Stack: { Toolbar },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }),
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

jest.mock('../../hooks/useTransitionComplete', () => ({
  useTransitionComplete: () => true,
}));
jest.mock('../../hooks/useDownloadStatus', () => ({
  useDownloadStatus: () => 'none',
}));
jest.mock('../../hooks/useLayoutMode', () => ({
  useLayoutMode: () => 'compact',
}));
jest.mock('../../hooks/useRefreshControlKey', () => ({
  useRefreshControlKey: () => 'key',
}));
jest.mock('../../hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => 'ca-1',
}));
jest.mock('../../components/CachedImage', () => ({
  CachedImage: () => null,
}));
jest.mock('../../components/DownloadButton', () => ({
  DownloadButton: () => null,
}));
jest.mock('../../components/MoreOptionsButton', () => ({
  MoreOptionsButton: () => null,
}));
jest.mock('../../components/MarqueeText', () => ({
  MarqueeText: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('../../components/BottomChrome', () => ({
  BottomChrome: () => null,
}));
jest.mock('../../components/DetailScreenBackground', () => ({
  DetailScreenBackground: () => null,
}));
jest.mock('../../components/DetailHeroButtons', () => ({
  PlayAllButton: () => null,
  ShufflePlayButton: () => null,
}));
jest.mock('../../components/SwipeableRow', () => {
  const { View } = require('react-native');
  return {
    SwipeableRow: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    closeOpenRow: jest.fn(),
  };
});

const playlist = {
  id: 'pl-1',
  name: 'Rock Playlist',
  coverArt: 'ca-pl',
  songCount: 3,
  duration: 540,
  owner: 'tester',
  entry: [
    { id: 's1', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 354 },
    { id: 's2', title: 'Hotel California', artist: 'Eagles', album: 'Hotel California', duration: 390 },
    { id: 's3', title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', duration: 482 },
  ] as Child[],
};

jest.mock('../../services/detailFetchService', () => ({
  fetchPlaylistDetail: jest.fn(async () => playlist),
}));
jest.mock('../../services/musicCacheService', () => ({
  enqueuePlaylistDownload: jest.fn(),
  syncCachedPlaylistTracks: jest.fn(),
}));
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  refreshCoverArt: jest.fn(),
}));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/subsonicService', () => ({
  updatePlaylistDetails: jest.fn(),
  updatePlaylistOrder: jest.fn(),
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
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: Object.assign(
    (sel: (s: { cachedItems: Record<string, unknown> }) => unknown) => sel({ cachedItems: {} }),
    { getState: () => ({ cachedItems: {} }) },
  ),
}));
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: jest.fn() }) },
}));
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: { getState: () => ({ show: jest.fn(), hide: jest.fn() }) },
  runWithOverlay: jest.fn(),
}));

import { PlaylistDetailScreen } from '../playlist-detail';
import { Platform } from 'react-native';

beforeEach(() => {
  mockTrackRowProps.length = 0;
  mockHeaderRight = undefined;
});

describe('PlaylistDetailScreen — search in playlist', () => {
  it('filters tracks by title, artist, or album when searching, keeping full playlist in songs prop', async () => {
    const screen = render(<PlaylistDetailScreen />);

    await screen.findByTestId('title-s1');
    expect(screen.getByTestId('title-s2')).toBeDefined();
    expect(screen.getByTestId('title-s3')).toBeDefined();

    // Trigger search button (iOS toolbar or Android headerRight)
    if (Platform.OS === 'ios') {
      const iosBtn = screen.getByTestId('toolbar-button-magnifyingglass');
      act(() => {
        fireEvent.press(iosBtn);
      });
    } else {
      expect(mockHeaderRight).toBeDefined();
      const headerJsx = mockHeaderRight!() as any;
      const searchBtn = headerJsx.props.children[0];
      act(() => {
        searchBtn.props.onPress();
      });
    }

    // Search bar should now be visible
    const input = await screen.findByPlaceholderText('Search in playlist...');
    expect(input).toBeDefined();

    // Filter by title "Hotel"
    act(() => {
      fireEvent.changeText(input, 'Hotel');
    });

    await waitFor(() => {
      expect(screen.getByTestId('title-s2')).toBeDefined();
      expect(screen.queryByTestId('title-s1')).toBeNull();
      expect(screen.queryByTestId('title-s3')).toBeNull();
    });

    const lastMatch = mockTrackRowProps[mockTrackRowProps.length - 1];
    expect(lastMatch.track.title).toBe('Hotel California');
    expect(lastMatch.songs).toHaveLength(3);

    const playTrackMock = jest.requireMock('../../services/playerService').playTrack;
    playTrackMock.mockClear();
    lastMatch.onPress!();
    expect(playTrackMock).toHaveBeenCalledTimes(1);
    expect(playTrackMock.mock.calls[0][0].id).toBe('s2');
    expect(playTrackMock.mock.calls[0][1]).toHaveLength(3);
    expect(playTrackMock.mock.calls[0][1][0].id).toBe('s2');
    const remainingIds = playTrackMock.mock.calls[0][1].slice(1).map((t: any) => t.id);
    expect(remainingIds).toEqual(expect.arrayContaining(['s1', 's3']));

    // Filter by artist "Queen"
    act(() => {
      fireEvent.changeText(input, 'queen');
    });

    await waitFor(() => {
      expect(screen.getByTestId('title-s1')).toBeDefined();
      expect(screen.queryByTestId('title-s2')).toBeNull();
      expect(screen.queryByTestId('title-s3')).toBeNull();
    });

    // Filter by album "Led Zeppelin"
    act(() => {
      fireEvent.changeText(input, 'Zeppelin IV');
    });

    await waitFor(() => {
      expect(screen.getByTestId('title-s3')).toBeDefined();
      expect(screen.queryByTestId('title-s1')).toBeNull();
      expect(screen.queryByTestId('title-s2')).toBeNull();
    });

    // Search with no matches
    act(() => {
      fireEvent.changeText(input, 'Nonexistent Song');
    });

    const emptyText = await screen.findByText('No results found');
    expect(emptyText).toBeDefined();

    // Clear search using clear button
    const clearButton = screen.getByLabelText('Clear');
    act(() => {
      fireEvent.press(clearButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId('title-s1')).toBeDefined();
      expect(screen.getByTestId('title-s2')).toBeDefined();
      expect(screen.getByTestId('title-s3')).toBeDefined();
    });

    // Cancel search using cancel button
    const cancelButton = screen.getByTestId('playlist-search-cancel-button');
    act(() => {
      fireEvent.press(cancelButton);
    });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search in playlist...')).toBeNull();
      expect(screen.getByTestId('title-s1')).toBeDefined();
      expect(screen.getByTestId('title-s2')).toBeDefined();
      expect(screen.getByTestId('title-s3')).toBeDefined();
    });
  });
});
