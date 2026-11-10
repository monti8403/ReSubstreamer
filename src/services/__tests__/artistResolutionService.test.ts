import { parseTrackArtists, resolveArtistId } from '../artistResolutionService';
import type { Child } from 'subsonic-api';

jest.mock('@/store/persistence/db', () => ({
  getDb: jest.fn(),
}));

jest.mock('@/services/searchMatch', () => ({
  normalize: jest.fn((s: string) => s.toLowerCase().trim()),
}));

jest.mock('@/services/subsonicService', () => ({
  search3: jest.fn(),
}));

jest.mock('@/store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: jest.fn(() => ({ offlineMode: false })),
  },
}));

describe('artistResolutionService', () => {
  describe('parseTrackArtists', () => {
    it('returns empty array when track is null or undefined', () => {
      expect(parseTrackArtists(null)).toEqual([]);
      expect(parseTrackArtists(undefined)).toEqual([]);
    });

    it('returns single artist when no delimiters are present', () => {
      const track: Child = {
        id: 't1',
        title: 'Solo Song',
        artist: 'Marracash',
        artistId: 'art-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([{ id: 'art-1', name: 'Marracash' }]);
    });

    it('splits on slash delimiter', () => {
      const track: Child = {
        id: 't2',
        title: 'SACRIFICIO',
        artist: 'Artie 5ive/Kid Yugi',
        artistId: 'artie-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'artie-1', name: 'Artie 5ive' },
        { id: undefined, name: 'Kid Yugi' },
      ]);
    });

    it('splits on comma and multiple slashes', () => {
      const track: Child = {
        id: 't3',
        title: 'IO PUO',
        artist: 'MACHETE/Jack The Smoker/Bob, Salmo',
        artistId: 'machete-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'machete-1', name: 'MACHETE' },
        { id: undefined, name: 'Jack The Smoker' },
        { id: undefined, name: 'Bob' },
        { id: undefined, name: 'Salmo' },
      ]);
    });

    it('splits on feat. in artist string', () => {
      const track: Child = {
        id: 't4',
        title: 'Track',
        artist: 'Drake feat. 21 Savage',
        artistId: 'drake-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'drake-1', name: 'Drake' },
        { id: undefined, name: '21 Savage' },
      ]);
    });

    it('extracts featured artists from title with (feat. ...)', () => {
      const track: Child = {
        id: 't5',
        title: 'SACRIFICIO (feat. Kid Yugi)',
        artist: 'Artie 5ive',
        artistId: 'artie-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'artie-1', name: 'Artie 5ive' },
        { id: undefined, name: 'Kid Yugi' },
      ]);
    });

    it('deduplicates when artist is in both artist string and title', () => {
      const track: Child = {
        id: 't6',
        title: 'SACRIFICIO (feat. Kid Yugi)',
        artist: 'Artie 5ive/Kid Yugi',
        artistId: 'artie-1',
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'artie-1', name: 'Artie 5ive' },
        { id: undefined, name: 'Kid Yugi' },
      ]);
    });

    it('uses OpenSubsonic structured artists array when multiple entries exist', () => {
      const track: Child = {
        id: 't7',
        title: 'Collab',
        artist: 'Ignored Fallback',
        artists: [
          { id: 'os-1', name: 'Artist Alpha', albumCount: 1 },
          { id: 'os-2', name: 'Artist Beta', albumCount: 2 },
        ],
        isDir: false,
      };
      const result = parseTrackArtists(track);
      expect(result).toEqual([
        { id: 'os-1', name: 'Artist Alpha' },
        { id: 'os-2', name: 'Artist Beta' },
      ]);
    });
  });

  describe('resolveArtistId', () => {
    const { getDb } = require('@/store/persistence/db');
    const { search3 } = require('@/services/subsonicService');
    const { offlineModeStore } = require('@/store/offlineModeStore');

    beforeEach(() => {
      jest.clearAllMocks();
      offlineModeStore.getState.mockReturnValue({ offlineMode: false });
    });

    it('returns null for empty artist name', async () => {
      expect(await resolveArtistId('')).toBeNull();
      expect(await resolveArtistId('   ')).toBeNull();
    });

    it('resolves via exact match in local SQLite artists table', async () => {
      const mockGetFirstAsync = jest.fn().mockResolvedValueOnce({ id: 'exact-1' });
      getDb.mockReturnValue({ getFirstAsync: mockGetFirstAsync });

      const id = await resolveArtistId('Kid Yugi');
      expect(id).toBe('exact-1');
      expect(mockGetFirstAsync).toHaveBeenCalledWith(
        'SELECT id FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1',
        ['Kid Yugi'],
      );
    });

    it('resolves via norm_name match in local SQLite artists table', async () => {
      const mockGetFirstAsync = jest
        .fn()
        .mockResolvedValueOnce(null) // exact fails
        .mockResolvedValueOnce({ id: 'norm-1' }); // norm succeeds
      getDb.mockReturnValue({ getFirstAsync: mockGetFirstAsync });

      const id = await resolveArtistId('Kid Yugi');
      expect(id).toBe('norm-1');
    });

    it('resolves via song_artists in local SQLite table', async () => {
      const mockGetFirstAsync = jest
        .fn()
        .mockResolvedValueOnce(null) // exact fails
        .mockResolvedValueOnce(null) // norm fails
        .mockResolvedValueOnce({ artist_id: 'song-art-1' }); // song_artists succeeds
      getDb.mockReturnValue({ getFirstAsync: mockGetFirstAsync });

      const id = await resolveArtistId('Kid Yugi');
      expect(id).toBe('song-art-1');
    });

    it('falls back to online search3 when not found in local db', async () => {
      const mockGetFirstAsync = jest.fn().mockResolvedValue(null);
      getDb.mockReturnValue({ getFirstAsync: mockGetFirstAsync });
      search3.mockResolvedValueOnce({
        artists: [{ id: 'online-1', name: 'Kid Yugi' }],
      });

      const id = await resolveArtistId('Kid Yugi');
      expect(id).toBe('online-1');
      expect(search3).toHaveBeenCalledWith('Kid Yugi');
    });

    it('does not search online when offline mode is true', async () => {
      offlineModeStore.getState.mockReturnValue({ offlineMode: true });
      const mockGetFirstAsync = jest.fn().mockResolvedValue(null);
      getDb.mockReturnValue({ getFirstAsync: mockGetFirstAsync });

      const id = await resolveArtistId('Unknown Artist');
      expect(id).toBeNull();
      expect(search3).not.toHaveBeenCalled();
    });
  });
});
