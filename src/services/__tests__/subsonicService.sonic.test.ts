const mockGetOpenSubsonicExtensions = jest.fn();
const mockGetSonicSimilarTracks = jest.fn();
const mockFindSonicPath = jest.fn();
const mockPing = jest.fn();
const mockGetUser = jest.fn();

jest.mock('subsonic-api', () => ({
  __esModule: true,
  default: class MockSubsonicAPI {
    getOpenSubsonicExtensions = mockGetOpenSubsonicExtensions;
    getSonicSimilarTracks = mockGetSonicSimilarTracks;
    findSonicPath = mockFindSonicPath;
    ping = mockPing;
    getUser = mockGetUser;
  },
}));
jest.mock('expo-crypto', () => ({
  getRandomValues: jest.fn((arr: Uint8Array) => arr),
  getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array(16)),
  digestStringAsync: jest.fn().mockResolvedValue('mocktoken'),
  CryptoDigestAlgorithm: { MD5: 'MD5' },
  CryptoEncoding: { HEX: 'hex' },
}));
jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);
jest.mock('../../store/authStore', () => ({
  authStore: { getState: jest.fn() },
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: jest.fn(() => ({ offlineMode: false })) },
}));
jest.mock('../../store/playbackSettingsStore', () => ({
  playbackSettingsStore: { getState: jest.fn() },
  FORMAT_PRESETS: [],
}));

import { authStore } from '../../store/authStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { serverInfoStore } from '../../store/serverInfoStore';
import {
  clearApiCache,
  findSonicPath,
  getOpenSubsonicExtensions,
  getSonicSimilarTracks,
  isSonicSimilarityAvailable,
} from '../subsonicService';

const mockAuthStore = authStore as jest.Mocked<typeof authStore>;
const mockOfflineStore = offlineModeStore as jest.Mocked<typeof offlineModeStore>;

beforeEach(() => {
  clearApiCache();
  serverInfoStore.getState().clearServerInfo();
  mockGetOpenSubsonicExtensions.mockReset();
  mockGetSonicSimilarTracks.mockReset();
  mockFindSonicPath.mockReset();
  mockPing.mockReset();
  mockGetUser.mockReset();

  mockOfflineStore.getState.mockReturnValue({ offlineMode: false } as any);
  mockAuthStore.getState.mockReturnValue({
    isLoggedIn: true,
    serverUrl: 'https://navidrome.example.com',
    username: 'user',
    password: 'pass',
    legacyAuth: false,
  } as any);
});

describe('subsonicService — OpenSubsonic sonicSimilarity', () => {
  it('detects sonicSimilarity v1 via getOpenSubsonicExtensions and caches once per session', async () => {
    mockGetOpenSubsonicExtensions.mockResolvedValue({
      status: 'ok',
      openSubsonicExtensions: [
        { name: 'transcodeOffset', versions: [1] },
        { name: 'sonicSimilarity', versions: [1] },
      ],
    });

    const first = await getOpenSubsonicExtensions();
    expect(first).toHaveLength(2);
    expect(serverInfoStore.getState().supportsSonicSimilarity).toBe(true);
    expect(serverInfoStore.getState().sonicSimilarityVersion).toBe(1);
    expect(isSonicSimilarityAvailable()).toBe(true);

    // Subsequent call in same session returns cached list without network hit
    const second = await getOpenSubsonicExtensions();
    expect(second).toHaveLength(2);
    expect(mockGetOpenSubsonicExtensions).toHaveBeenCalledTimes(1);
  });

  it('never calls getSonicSimilarTracks or findSonicPath when supportsSonicSimilarity is false (anti-404 guard)', async () => {
    mockGetOpenSubsonicExtensions.mockResolvedValue({
      status: 'ok',
      openSubsonicExtensions: [{ name: 'formPost', versions: [1] }],
    });
    await getOpenSubsonicExtensions();

    expect(serverInfoStore.getState().supportsSonicSimilarity).toBe(false);
    expect(isSonicSimilarityAvailable()).toBe(false);

    const similar = await getSonicSimilarTracks('song-1', 30);
    const path = await findSonicPath('song-1', 'song-2', 15);

    expect(similar).toEqual([]);
    expect(path).toEqual([]);
    expect(mockGetSonicSimilarTracks).not.toHaveBeenCalled();
    expect(mockFindSonicPath).not.toHaveBeenCalled();
  });

  it('parses sonicMatch defensively (missing score and -1) and preserves findSonicPath order', async () => {
    serverInfoStore.getState().setOpenSubsonicExtensions([
      { name: 'sonicSimilarity', versions: [1] },
    ]);

    mockGetSonicSimilarTracks.mockResolvedValue({
      status: 'ok',
      sonicMatch: [
        { entry: { id: 's1', title: 'One', isDir: false }, similarity: 0.91 },
        { entry: { id: 's2', title: 'Two', isDir: false }, similarity: -1 },
        { entry: { id: 's3', title: 'Three', isDir: false } },
      ],
    });

    const similar = await getSonicSimilarTracks('seed-1', 30);
    expect(mockGetSonicSimilarTracks).toHaveBeenCalledWith({ id: 'seed-1', count: 30 });
    expect(similar).toHaveLength(3);
    expect(similar[0].similarity).toBeCloseTo(0.91);
    expect(similar[1].similarity).toBe(-1);
    expect(similar[2].similarity).toBe(-1);

    mockFindSonicPath.mockResolvedValue({
      status: 'ok',
      sonicMatch: [
        { entry: { id: 'start', title: 'Start', isDir: false }, similarity: 1 },
        { entry: { id: 'mid', title: 'Mid', isDir: false }, similarity: 0.72 },
        { entry: { id: 'mid', title: 'Mid dup', isDir: false }, similarity: 0.72 },
        { entry: { id: 'end', title: 'End', isDir: false }, similarity: 0.45 },
      ],
    });

    const path = await findSonicPath('start', 'end', 15);
    expect(mockFindSonicPath).toHaveBeenCalledWith({
      startSongId: 'start',
      endSongId: 'end',
      count: 15,
    });
    expect(path.map((p) => p.song.id)).toEqual(['start', 'mid', 'end']);
  });

  it('invalidates sonicSimilarity for the current session on runtime 404 and skips further calls', async () => {
    serverInfoStore.getState().setOpenSubsonicExtensions([
      { name: 'sonicSimilarity', versions: [1] },
    ]);

    const err404 = Object.assign(new Error('Subsonic request failed: 404 Not Found (getSonicSimilarTracks)'), {
      status: 404,
    });
    mockGetSonicSimilarTracks.mockRejectedValueOnce(err404);

    const first = await getSonicSimilarTracks('s1', 20);
    expect(first).toEqual([]);
    expect(serverInfoStore.getState().sonicSimilaritySessionDisabled).toBe(true);
    expect(isSonicSimilarityAvailable()).toBe(false);

    // Subsequent calls must not hit network at all
    await getSonicSimilarTracks('s1', 20);
    await findSonicPath('s1', 's2', 12);
    expect(mockGetSonicSimilarTracks).toHaveBeenCalledTimes(1);
    expect(mockFindSonicPath).not.toHaveBeenCalled();
  });
});
