jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

const mockCachedSongs: Record<string, any> = {};
const mockCompleteSongFromCache = jest.fn((orig: any) => orig);
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: () => ({ cachedSongs: mockCachedSongs }) },
  completeSongFromCache: (orig: any) => mockCompleteSongFromCache(orig),
}));

const mockOffline = { offlineMode: false };
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => mockOffline },
}));

const mockDiagnostics = { enabled: false };
jest.mock('../../store/imageCacheDiagnosticsStore', () => ({
  imageCacheDiagnosticsStore: { getState: () => mockDiagnostics },
}));

jest.mock('../../store/playbackSettingsStore', () => ({
  playbackSettingsStore: { getState: () => ({ streamFormat: 'raw' }) },
  getStreamingMaxBitRate: () => null,
}));

const mockResolveCachedImageUri = jest.fn().mockResolvedValue(null);
jest.mock('../imageCacheService', () => ({
  resolveCachedImageUri: (...args: unknown[]) => mockResolveCachedImageUri(...args),
}));

const mockLogImageCache = jest.fn();
jest.mock('../imageCacheLogger', () => ({
  logImageCache: (...args: unknown[]) => mockLogImageCache(...args),
}));

const mockGetLocalTrackUri = jest.fn().mockReturnValue(null);
jest.mock('../musicCacheService', () => ({
  getLocalTrackUri: (...args: unknown[]) => mockGetLocalTrackUri(...args),
}));

jest.mock('../subsonicService', () => ({
  getCoverArtUrl: jest.fn((id: string) => `https://example.com/art/${id}`),
  getStreamUrl: jest.fn((id: string) => `https://example.com/stream/${id}`),
}));

import { type Child } from '../subsonicService';
import { ensureQueueKey } from '../../utils/queueKeys';
import {
  buildPlayableQueue,
  childToTrack,
  mapRepeatMode,
  mapState,
  stampQueueFormat,
} from '../playerHelpers';

describe('playerHelpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOffline.offlineMode = false;
    mockDiagnostics.enabled = false;
    for (const k of Object.keys(mockCachedSongs)) delete mockCachedSongs[k];
    mockCompleteSongFromCache.mockImplementation((orig) => orig);
    mockGetLocalTrackUri.mockReturnValue(null);
    mockResolveCachedImageUri.mockResolvedValue(null);
  });

  it('maps repeat modes and player states including loading', () => {
    expect(mapRepeatMode('all')).toBe('queue');
    expect(mapRepeatMode('one')).toBe('track');
    expect(mapRepeatMode('off')).toBe('off');

    expect(mapState('playing')).toBe('playing');
    expect(mapState('paused')).toBe('paused');
    expect(mapState('buffering')).toBe('buffering');
    expect(mapState('loading')).toBe('loading');
    expect(mapState('ended')).toBe('stopped');
    expect(mapState('error')).toBe('stopped');
    expect(mapState('none')).toBe('idle');
  });

  it('stamps queue format from cached downloaded song when available', () => {
    mockCachedSongs.s1 = {
      suffix: 'FLAC',
      bitRate: 1411,
      bitDepth: 16,
      samplingRate: 44100,
      formatCapturedAt: 12345,
    };

    const child = { id: 's1', title: 'Song 1', isDir: false, parent: 'p' } as Child;
    expect(stampQueueFormat(child)).toEqual({
      suffix: 'flac',
      bitRate: 1411,
      bitDepth: 16,
      samplingRate: 44100,
      capturedAt: 12345,
    });
  });

  it('logs diagnostic warning when cached song falls back to stream url and filters unplayable offline tracks', () => {
    mockDiagnostics.enabled = true;
    mockCachedSongs.s1 = { suffix: 'mp3' };

    const child = {
      id: 's1',
      title: 'Song 1',
      coverArt: 'cov-1',
      isDir: false,
      parent: 'p',
    } as Child;

    const item = childToTrack(child);
    expect(item?.url).toBe('https://example.com/stream/s1');
    expect(mockLogImageCache).toHaveBeenCalledWith('player stream-url-for-cached-song id=s1');

    mockOffline.offlineMode = true;
    expect(childToTrack(child)).toBeNull();
  });

  it('preserves _queueKey on buildPlayableQueue when completeSongFromCache creates a new object', async () => {
    const orig1 = {
      id: 's1',
      title: 'Song 1',
      coverArt: 'al-1',
      albumId: 'al-1',
      isDir: false,
      parent: 'al-1',
    } as Child;
    const orig2 = {
      id: 's2',
      title: 'Song 2',
      coverArt: 'al-1',
      albumId: 'al-1',
      isDir: false,
      parent: 'al-1',
    } as Child;
    const key1 = ensureQueueKey(orig1);

    mockCompleteSongFromCache.mockImplementation((orig: Child) =>
      orig.id === 's1' ? { ...orig, suffix: 'flac' } : orig,
    );
    mockResolveCachedImageUri.mockResolvedValue('file:///cache/al-1.jpg');

    const { rnTracks, filteredQueue } = await buildPlayableQueue([orig1, orig2]);
    expect(filteredQueue).toHaveLength(2);
    expect(filteredQueue[0]).not.toBe(orig1);
    expect(ensureQueueKey(filteredQueue[0])).toBe(key1);
    expect(rnTracks[0].artworkUrl).toBe('file:///cache/al-1.jpg');
    expect(mockResolveCachedImageUri).toHaveBeenCalledTimes(1);
  });
});
