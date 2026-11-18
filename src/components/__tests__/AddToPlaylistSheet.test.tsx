jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('react-native-reanimated', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => ReactActual.useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number, _config?: object, cb?: (finished: boolean) => void) => {
      if (cb) cb(true);
      return val;
    },
    runOnJS: (fn: Function) => fn,
    Easing: {
      out: () => () => 0,
      cubic: () => 0,
    },
  };
});

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { addToPlaylistStore } from '../../store/addToPlaylistStore';

const mockListAllPlaylists = jest.fn();
const mockGetPlaylistsSongContainment = jest.fn();
const mockRefreshPlaylistLibrary = jest.fn();
const mockAddSongsToPlaylist = jest.fn();
const mockResolveLocalTargetSongIds = jest.fn();
const mockResolveTargetSongIds = jest.fn();
const mockCreateNewPlaylist = jest.fn();

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#181818',
      textPrimary: '#fff',
      textSecondary: '#b3b3b3',
      label: '#888',
      border: '#222',
      primary: '#1D9BF0',
      red: '#e91429',
      green: '#30D158',
      orange: '#FF9F0A',
      partialDownload: '#FF9F0A',
      inputBg: '#282828',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'alreadyInPlaylist') return 'Already in playlist';
      if (key === 'alreadyInPlaylistCount') return `${opts?.count} already in playlist`;
      if (key === 'trackWithCount') return `${opts?.count} tracks`;
      if (key === 'tracksFromQueue') return `${opts?.count} tracks from queue`;
      return key;
    },
  }),
}));

jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

jest.mock('../CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

jest.mock('@react-native-vector-icons/ionicons/static', () => {
  const { Text } = require('react-native');
  return function MockIonicons(props: { name: string }) {
    return <Text testID={`icon-${props.name}`}>{props.name}</Text>;
  };
});

jest.mock('../../store/persistence/db', () => ({
  getDb: () => ({ __mock: true }),
}));

jest.mock('../../db/repository/playlists', () => ({
  listAllPlaylists: (...args: unknown[]) => mockListAllPlaylists(...args),
  getPlaylistsSongContainment: (...args: unknown[]) => mockGetPlaylistsSongContainment(...args),
  playlistBrowseRowToPlaylist: (r: { id: string; name: string; cover_art: string | null; song_count: number | null }) => ({
    id: r.id,
    name: r.name,
    coverArt: r.cover_art ?? undefined,
    songCount: r.song_count ?? 0,
    duration: 0,
  }),
}));

jest.mock('../../services/normalizedLibrarySync', () => ({
  refreshPlaylistLibrary: (...args: unknown[]) => mockRefreshPlaylistLibrary(...args),
}));

jest.mock('../../services/playlistService', () => ({
  addSongsToPlaylist: (...args: unknown[]) => mockAddSongsToPlaylist(...args),
  resolveLocalTargetSongIds: (...args: unknown[]) => mockResolveLocalTargetSongIds(...args),
  resolveTargetSongIds: (...args: unknown[]) => mockResolveTargetSongIds(...args),
}));

jest.mock('../../services/subsonicService', () => ({
  createNewPlaylist: (...args: unknown[]) => mockCreateNewPlaylist(...args),
}));

jest.mock('../../hooks/useSongCoverArt', () => ({
  resolveSongCoverArt: () => undefined,
}));

jest.mock('../../utils/coverArtId', () => ({
  coverArtForAlbum: () => undefined,
}));

import { AddToPlaylistSheet } from '../AddToPlaylistSheet';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  addToPlaylistStore.getState().hide();
  mockRefreshPlaylistLibrary.mockResolvedValue(undefined);
  mockAddSongsToPlaylist.mockResolvedValue({ success: true, addedIds: ['s1'] });
  mockListAllPlaylists.mockResolvedValue([
    { id: 'p1', name: 'Favorites Mix', cover_art: null, song_count: 10 },
    { id: 'p2', name: 'Workout', cover_art: null, song_count: 5 },
    { id: 'p3', name: 'Empty List', cover_art: null, song_count: 0 },
  ]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AddToPlaylistSheet', () => {
  it('disables playlists already containing the target song and shows the badge', async () => {
    mockResolveLocalTargetSongIds.mockResolvedValue(['s1']);
    mockGetPlaylistsSongContainment.mockResolvedValue(
      new Map([['p1', { existingCount: 1, isFullyContained: true }]]),
    );

    addToPlaylistStore.getState().showSong({ id: 's1', title: 'Track 1', isDir: false });
    const { getByText, queryAllByText } = render(<AddToPlaylistSheet />);

    await act(async () => {
      jest.advanceTimersByTime(800);
    });

    await waitFor(() => {
      expect(getByText('Favorites Mix')).toBeTruthy();
      expect(getByText('Already in playlist')).toBeTruthy();
    });

    expect(queryAllByText('Already in playlist')).toHaveLength(1);

    // Tapping the already-containing playlist must not invoke addSongsToPlaylist
    fireEvent.press(getByText('Favorites Mix'));
    expect(mockAddSongsToPlaylist).not.toHaveBeenCalled();

    // Tapping a non-containing playlist adds the song
    fireEvent.press(getByText('Workout'));
    await waitFor(() => {
      expect(mockAddSongsToPlaylist).toHaveBeenCalledWith('p2', ['s1']);
    });
  });

  it('shows partial count subtitle for multi-song targets and keeps the row clickable', async () => {
    mockResolveLocalTargetSongIds.mockResolvedValue(['s1', 's2', 's3']);
    mockGetPlaylistsSongContainment.mockResolvedValue(
      new Map([
        ['p1', { existingCount: 3, isFullyContained: true }],
        ['p2', { existingCount: 2, isFullyContained: false }],
      ]),
    );

    addToPlaylistStore.getState().showAlbum({
      id: 'a1',
      name: 'Great Album',
      songCount: 3,
      duration: 300,
      created: new Date(),
    });
    const { getByText } = render(<AddToPlaylistSheet />);

    await act(async () => {
      jest.advanceTimersByTime(800);
    });

    await waitFor(() => {
      expect(getByText('Already in playlist')).toBeTruthy();
      expect(getByText(/2 already in playlist/)).toBeTruthy();
    });

    // Partially contained playlist stays clickable and triggers addSongsToPlaylist
    fireEvent.press(getByText('Workout'));
    await waitFor(() => {
      expect(mockAddSongsToPlaylist).toHaveBeenCalledWith('p2', ['s1', 's2', 's3']);
    });
  });
});
