jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

const mockAddToPlaylist = jest.fn();
const mockFetchAlbumDetail = jest.fn();
const mockFetchPlaylistDetail = jest.fn();
const mockSyncCachedItemTracks = jest.fn();
const mockBumpDetailChanged = jest.fn();
const mockBumpLibraryUpdated = jest.fn();

let mockDb: ReturnType<typeof createMockDb> | null = null;
let mockCachedItems: Record<string, unknown> = {};

function createMockDb() {
  return {
    getAllAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    runAtomicBatchAsync: jest.fn().mockResolvedValue(undefined),
  };
}

jest.mock('../subsonicService', () => ({
  addToPlaylist: (...args: unknown[]) => mockAddToPlaylist(...args),
}));

jest.mock('../detailFetchService', () => ({
  fetchAlbumDetail: (...args: unknown[]) => mockFetchAlbumDetail(...args),
  fetchPlaylistDetail: (...args: unknown[]) => mockFetchPlaylistDetail(...args),
}));

jest.mock('../musicCacheService', () => ({
  syncCachedItemTracks: (...args: unknown[]) => mockSyncCachedItemTracks(...args),
}));

jest.mock('../../db/detailNotifier', () => ({
  bumpDetailChanged: (...args: unknown[]) => mockBumpDetailChanged(...args),
}));

jest.mock('../../store/persistence/db', () => ({
  getDb: () => mockDb,
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: {
    getState: () => ({ cachedItems: mockCachedItems }),
  },
}));

jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: {
    getState: () => ({ bumpLibraryUpdated: mockBumpLibraryUpdated }),
  },
}));

import {
  addSongsToPlaylist,
  resolveLocalTargetSongIds,
  resolveTargetSongIds,
} from '../playlistService';

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = createMockDb();
  mockCachedItems = {};
  mockAddToPlaylist.mockResolvedValue(true);
});

describe('playlistService', () => {
  describe('resolveLocalTargetSongIds', () => {
    it('resolves song and deduplicated queue targets without hitting DB or HTTP', async () => {
      const songIds = await resolveLocalTargetSongIds(
        { type: 'song', item: { id: 's1', title: 'Song 1', isDir: false } },
        mockDb as any,
      );
      expect(songIds).toEqual(['s1']);

      const queueIds = await resolveLocalTargetSongIds(
        {
          type: 'queue',
          songs: [
            { id: 's1', title: 'A', isDir: false },
            { id: 's2', title: 'B', isDir: false },
            { id: 's1', title: 'A', isDir: false },
          ],
        },
        mockDb as any,
      );
      expect(queueIds).toEqual(['s1', 's2']);
      expect(mockDb!.getAllAsync).not.toHaveBeenCalled();
      expect(mockFetchAlbumDetail).not.toHaveBeenCalled();
    });

    it('resolves cached album tracks from SQLite without HTTP', async () => {
      mockDb!.getAllAsync.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const ids = await resolveLocalTargetSongIds(
        { type: 'album', item: { id: 'a1', name: 'Album', songCount: 2, duration: 100, created: new Date() } },
        mockDb as any,
      );
      expect(ids).toEqual(['s1', 's2']);
      expect(mockFetchAlbumDetail).not.toHaveBeenCalled();
    });
  });

  describe('resolveTargetSongIds', () => {
    it('falls back to fetchAlbumDetail once when album tracks are not in SQLite', async () => {
      mockDb!.getAllAsync.mockResolvedValue([]);
      mockFetchAlbumDetail.mockResolvedValue({
        id: 'a1',
        song: [
          { id: 's10', title: 'X', isDir: false },
          { id: 's11', title: 'Y', isDir: false },
        ],
      });
      const ids = await resolveTargetSongIds({
        type: 'album',
        item: { id: 'a1', name: 'Album', songCount: 2, duration: 100, created: new Date() },
      });
      expect(ids).toEqual(['s10', 's11']);
      expect(mockFetchAlbumDetail).toHaveBeenCalledTimes(1);
    });
  });

  describe('addSongsToPlaylist', () => {
    it('filters out songs already in the playlist before calling Subsonic API', async () => {
      mockDb!.getAllAsync.mockResolvedValue([{ song_id: 's1' }, { song_id: 's3' }]);
      mockDb!.getFirstAsync.mockResolvedValue({ max_pos: 1 });

      const result = await addSongsToPlaylist('p1', ['s1', 's2', 's3', 's4', 's2']);

      expect(result).toEqual({ success: true, addedIds: ['s2', 's4'] });
      expect(mockAddToPlaylist).toHaveBeenCalledTimes(1);
      expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['s2', 's4']);
      expect(mockDb!.runAtomicBatchAsync).toHaveBeenCalledTimes(1);
      expect(mockBumpDetailChanged).toHaveBeenCalledWith('playlist', 'p1');
      expect(mockBumpLibraryUpdated).toHaveBeenCalledTimes(1);
    });

    it('short-circuits without calling Subsonic API when all songs already exist', async () => {
      mockDb!.getAllAsync.mockResolvedValue([{ song_id: 's1' }, { song_id: 's2' }]);

      const result = await addSongsToPlaylist('p1', ['s1', 's2']);

      expect(result).toEqual({ success: true, addedIds: [] });
      expect(mockAddToPlaylist).not.toHaveBeenCalled();
      expect(mockDb!.runAtomicBatchAsync).not.toHaveBeenCalled();
    });

    it('does not update SQLite if the Subsonic API call fails', async () => {
      mockDb!.getAllAsync.mockResolvedValue([{ song_id: 's1' }]);
      mockAddToPlaylist.mockResolvedValue(false);

      const result = await addSongsToPlaylist('p1', ['s1', 's2']);

      expect(result).toEqual({ success: false, addedIds: [] });
      expect(mockDb!.runAtomicBatchAsync).not.toHaveBeenCalled();
      expect(mockBumpDetailChanged).not.toHaveBeenCalled();
    });

    it('fetches detail once when playlist has server tracks not yet cached locally', async () => {
      mockDb!.getAllAsync.mockResolvedValue([]);
      mockDb!.getFirstAsync
        .mockResolvedValueOnce({ id: 'p1', song_count: 2, detail_changed: null })
        .mockResolvedValueOnce({ max_pos: 1 });
      mockFetchPlaylistDetail.mockResolvedValue({
        id: 'p1',
        entry: [{ id: 's1' }, { id: 's2' }],
      });

      const result = await addSongsToPlaylist('p1', ['s1', 's3']);

      expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1', { prefetchCovers: false });
      expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['s3']);
      expect(result).toEqual({ success: true, addedIds: ['s3'] });
    });

    it('re-syncs cached item tracks when playlist is downloaded', async () => {
      mockCachedItems = { p1: { type: 'playlist', songIds: ['s1'] } };
      mockDb!.getAllAsync.mockResolvedValue([{ song_id: 's1' }]);
      mockFetchPlaylistDetail.mockResolvedValue({
        id: 'p1',
        entry: [{ id: 's1' }, { id: 's2' }],
      });

      const result = await addSongsToPlaylist('p1', ['s1', 's2']);

      expect(result).toEqual({ success: true, addedIds: ['s2'] });
      expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1', { force: true });
      expect(mockSyncCachedItemTracks).toHaveBeenCalledWith('p1', [{ id: 's1' }, { id: 's2' }]);
    });
  });
});
