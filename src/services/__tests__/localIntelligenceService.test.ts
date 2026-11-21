const mockIsSonicSimilarityAvailable = jest.fn().mockReturnValue(false);
const mockGetSonicSimilarTracks = jest.fn().mockResolvedValue([]);
const mockFindSonicPath = jest.fn().mockResolvedValue([]);
jest.mock('../subsonicService', () => ({
  isSonicSimilarityAvailable: () => mockIsSonicSimilarityAvailable(),
  getSonicSimilarTracks: (...args: any[]) => mockGetSonicSimilarTracks(...args),
  findSonicPath: (...args: any[]) => mockFindSonicPath(...args),
}));

import type { AlbumID3, ArtistID3, Child, Playlist } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertArtists } from '../../db/repository/artists';
import { setPlaylistSongs, upsertPlaylists } from '../../db/repository/playlists';
import { upsertSongs } from '../../db/repository/songs';
import { completedScrobbleStore } from '../../store/completedScrobbleStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { __setDbForTests, getDb } from '../../store/persistence/db';
import {
  albumMetaFromAlbumID3,
  upsertCachedItem,
  upsertCachedSong,
  type CachedSongRow,
} from '../../store/persistence/musicCacheTables';
import { insertScrobble } from '../../store/persistence/scrobbleTable';
import { recentPlaysStore } from '../../store/recentPlaysStore';
import {
  getDynamicMixSummaries,
  getForgottenGems,
  getHourlyDaylist,
  getJumpBackIn,
  getOnRepeat,
  getQuickMoodChips,
  getSongsForMoodChip,
  resolveDynamicMix,
} from '../localIntelligenceService';

const db = () => getDb()!;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const TABLES_TO_CLEAR = [
  'cached_item_songs',
  'cached_albums',
  'cached_playlists',
  'cached_items',
  'cached_song_genres',
  'cached_song_artists',
  'cached_song_album_artists',
  'cached_song_contributors',
  'cached_song_moods',
  'cached_songs',
  'scrobble_genres',
  'scrobble_artists',
  'scrobble_album_artists',
  'scrobble_contributors',
  'scrobble_moods',
  'scrobble_events',
  'playlist_songs',
  'playlists',
  'song_genres',
  'song_moods',
  'song_artists',
  'song_album_artists',
  'song_contributors',
  'songs',
  'albums',
  'artists',
  'dynamic_mix_cache',
];

const makeSong = (id: string, extra: Partial<Child> = {}): Child =>
  ({
    id,
    title: extra.title ?? `Title ${id}`,
    artist: extra.artist ?? `Artist ${id}`,
    album: extra.album ?? `Album ${id}`,
    duration: extra.duration ?? 200,
    isDir: false,
    ...extra,
  }) as Child;

const makeAlbum = (id: string, name: string, extra: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name,
  songCount: 1,
  duration: 200,
  ...extra,
});

const makeArtist = (id: string, name: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name,
  albumCount: 1,
  ...extra,
});

const makePlaylist = (id: string, name: string, extra: Partial<Playlist> = {}): Playlist => ({
  id,
  name,
  songCount: 1,
  duration: 200,
  ...extra,
});

const makeCachedSong = (song: Child): CachedSongRow => ({
  id: song.id,
  title: song.title,
  artist: song.artist,
  album: song.album,
  albumId: song.albumId ?? '_unknown',
  srcAlbumId: song.albumId,
  coverArt: song.coverArt,
  bytes: 1024,
  duration: song.duration ?? 200,
  suffix: song.suffix ?? 'mp3',
  srcSuffix: song.suffix,
  formatCapturedAt: 1000,
  downloadedAt: 1000,
  artistId: song.artistId,
  genre: song.genre,
  bpm: song.bpm,
  playCount: song.playCount,
  played: song.played,
  userRating: song.userRating,
  starred: song.starred instanceof Date ? song.starred.getTime() : undefined,
  genres: song.genres as string[] | undefined,
});

const seedCachedSongWithMoods = async (song: Child): Promise<void> => {
  await upsertCachedSong(makeCachedSong(song), song);
};

const pinTime = (time: number | Date): void => {
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.setSystemTime(time);
};

beforeAll(() => {
  ensureNormalizedSchema(db());
});

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  mockIsSonicSimilarityAvailable.mockReturnValue(false);
  mockGetSonicSimilarTracks.mockResolvedValue([]);
  mockFindSonicPath.mockResolvedValue([]);
  offlineModeStore.setState({ offlineMode: false });
  recentPlaysStore.setState({ recentItems: [] });
  completedScrobbleStore.setState({ recentScrobbles: [] });
  for (const t of TABLES_TO_CLEAR) {
    db().runSync(`DELETE FROM ${t}`);
  }
});

describe('null DB and empty DB safety', () => {
  it('returns safe empty results when getDb() is null', async () => {
    const real = getDb();
    __setDbForTests(null);
    try {
      expect(await getJumpBackIn()).toEqual([]);
      const daylist = await getHourlyDaylist();
      expect(daylist.songs).toEqual([]);
      expect(daylist.topGenres).toEqual([]);
      expect(daylist.title.length).toBeGreaterThan(0);
      expect(daylist.subtitle.length).toBeGreaterThan(0);
      expect(await getOnRepeat()).toEqual([]);
      expect(await getForgottenGems()).toEqual([]);
      expect(await getQuickMoodChips()).toEqual([]);
      expect(
        await getSongsForMoodChip({ id: 'genre:rock', label: 'Rock', kind: 'genre', genre: 'Rock', songCount: 1 }),
      ).toEqual([]);
    } finally {
      __setDbForTests(real);
    }
  });

  it('returns empty results when all SQLite tables are empty', async () => {
    expect(await getJumpBackIn()).toEqual([]);
    expect((await getHourlyDaylist()).songs).toEqual([]);
    expect(await getOnRepeat()).toEqual([]);
    expect(await getForgottenGems()).toEqual([]);
    expect(await getQuickMoodChips()).toEqual([]);
  });
});

describe('getJumpBackIn', () => {
  it('returns a balanced, deduplicated mix of playlists, artists, and albums sorted by lastPlayedAt DESC', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    await upsertArtists(db(), [
      makeArtist('ar1', 'Artist One', { coverArt: 'ca-ar1' }),
      makeArtist('ar2', 'Artist Two', { coverArt: 'ca-ar2' }),
    ]);
    await upsertAlbums(db(), [
      makeAlbum('al1', 'Album One', { artist: 'Artist One', artistId: 'ar1', coverArt: 'ca-al1' }),
      makeAlbum('al2', 'Album Two', { artist: 'Artist Two', artistId: 'ar2', coverArt: 'ca-al2' }),
      makeAlbum('al3', 'Album Three', { artist: 'Artist Two', artistId: 'ar2', coverArt: 'ca-al3' }),
    ]);
    await upsertPlaylists(db(), [
      makePlaylist('pl1', 'Morning Flow', { comment: 'Vibes', coverArt: 'ca-pl1' }),
      makePlaylist('pl2', 'Coding Mix', { comment: 'Focus', coverArt: 'ca-pl2' }),
    ]);
    await setPlaylistSongs(db(), 'pl1', ['s1', 's1']); // duplicate song position should not double-count

    const s1 = makeSong('s1', { albumId: 'al1', artistId: 'ar1', artist: 'Artist One', album: 'Album One' });
    const s2 = makeSong('s2', { albumId: 'al2', artistId: 'ar2', artist: 'Artist Two', album: 'Album Two' });
    const s3 = makeSong('s3', { albumId: 'al3', artistId: 'ar2', artist: 'Artist Two', album: 'Album Three' });

    await insertScrobble({ id: 'e1', song: s1, time: now - 5 * HOUR_MS });
    await insertScrobble({ id: 'e2', song: s2, time: now - 2 * HOUR_MS });
    await insertScrobble({ id: 'e3', song: s3, time: now - 1 * HOUR_MS });

    // pl1 is in both scrobble_events (via s1) and recentPlaysStore; pl2 is only in recentPlaysStore
    recentPlaysStore.setState({
      recentItems: [
        { id: 'pl2', type: 'playlist', title: 'Coding Mix', subtitle: 'Focus', coverUri: 'ca-pl2' },
        { id: 'pl1', type: 'playlist', title: 'Morning Flow', subtitle: 'Vibes', coverUri: 'ca-pl1' },
      ],
    });

    const items = await getJumpBackIn(6);
    expect(items).toHaveLength(6);

    // Deduplicated by type:id
    const keys = items.map((i) => `${i.type}:${i.id}`);
    expect(new Set(keys).size).toBe(6);

    // Balanced across all three entity types
    const types = new Set(items.map((i) => i.type));
    expect(types).toEqual(new Set(['playlist', 'artist', 'album']));

    // Sorted by lastPlayedAt DESC
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].lastPlayedAt).toBeGreaterThanOrEqual(items[i].lastPlayedAt);
    }

    // pl1 shouldn't double-count duplicate positions in playlist_songs
    const pl1 = items.find((i) => i.type === 'playlist' && i.id === 'pl1');
    expect(pl1?.playCount).toBe(1);
  });

  it('prioritizes cached items when offlineMode is true', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    await upsertArtists(db(), [
      makeArtist('ar-uncached', 'Uncached Artist'),
      makeArtist('ar-cached', 'Cached Artist'),
    ]);
    await upsertAlbums(db(), [
      makeAlbum('al-uncached', 'Uncached Album', { artistId: 'ar-uncached' }),
      makeAlbum('al-cached', 'Cached Album', { artistId: 'ar-cached' }),
    ]);

    const sUncached = makeSong('su', { albumId: 'al-uncached', artistId: 'ar-uncached' });
    const sCached = makeSong('sc', { albumId: 'al-cached', artistId: 'ar-cached' });

    // Uncached was played more recently, cached was played earlier
    await insertScrobble({ id: 'eu', song: sUncached, time: now - 1000 });
    await insertScrobble({ id: 'ec', song: sCached, time: now - 50000 });

    await seedCachedSongWithMoods(sCached);
    await upsertCachedItem({
      itemId: 'al-cached',
      type: 'album',
      name: 'Cached Album',
      expectedSongCount: 1,
      lastSyncAt: now,
      downloadedAt: now,
      albumMeta: albumMetaFromAlbumID3(
        makeAlbum('al-cached', 'Cached Album', { artistId: 'ar-cached' }),
      ),
    });

    offlineModeStore.setState({ offlineMode: true });
    const items = await getJumpBackIn(2);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(['al-cached', 'ar-cached']);
  });
});

describe('getHourlyDaylist', () => {
  it('uses current hour ±1h window (including midnight wraparound), tops up by genre and popular songs, and uses i18n keys', async () => {
    // 00:30 local time -> window is hours [23, 0, 1] -> daylistLateNight
    const midnightLocal = new Date(2025, 4, 10, 0, 30, 0);
    pinTime(midnightLocal);

    const sHour23 = makeSong('s23', { genres: ['Synthwave'] as any, genre: 'Synthwave', playCount: 1 });
    const sHour14 = makeSong('s14', { genres: ['Country'] as any, genre: 'Country', playCount: 99 });
    const sGenreTopUp = makeSong('sGen', { genres: ['Synthwave'] as any, genre: 'Synthwave', playCount: 10 });
    const sPopular = makeSong('sPop', { genres: ['Ambient'] as any, genre: 'Ambient', playCount: 50 });

    await upsertSongs(db(), [sHour23, sHour14, sGenreTopUp, sPopular]);

    const t23 = new Date(2025, 4, 9, 23, 15, 0).getTime();
    const t14 = new Date(2025, 4, 9, 14, 15, 0).getTime();
    await insertScrobble({ id: 'sc23', song: sHour23, time: t23 });
    await insertScrobble({ id: 'sc14', song: sHour14, time: t14 });

    const daylist = await getHourlyDaylist(4);
    expect(daylist.hour).toBe(0);
    expect(daylist.timeSlotKey).toBe('daylistLateNight');
    expect(daylist.title).toBe('Late Night Mix');
    expect(daylist.topGenres).toEqual(['Synthwave']);
    // 1) s23 from slot, 2) sGen from genre top-up, 3) sPop & s14 from popular top-up
    expect(daylist.songs[0].id).toBe('s23');
    expect(daylist.songs[1].id).toBe('sGen');
    expect(daylist.songs.map((s) => s.id)).toEqual(['s23', 'sGen', 's14', 'sPop']);
    expect(daylist.songs[0].genres).toEqual(['Synthwave']);
  });

  it('restricts to downloaded songs in offlineMode with cached_songs fallback', async () => {
    pinTime(new Date(2025, 4, 10, 9, 0, 0));

    const libOnly = makeSong('lib-only', { genre: 'Rock', playCount: 50 });
    const cachedNotInSongs = makeSong('dl-only', { genre: 'Jazz', playCount: 5 });

    await upsertSongs(db(), [libOnly]);
    await seedCachedSongWithMoods(cachedNotInSongs);

    offlineModeStore.setState({ offlineMode: true });
    const daylist = await getHourlyDaylist(10);
    expect(daylist.timeSlotKey).toBe('daylistMorning');
    expect(daylist.songs.map((s) => s.id)).toEqual(['dl-only']);
  });
});

describe('getOnRepeat', () => {
  it('ranks most-played songs in the last 14 days and falls back to scrobble snapshot if reaped', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    const s1 = makeSong('s1', { title: 'Track 1', genres: ['Indie'] as any });
    const s2 = makeSong('s2', { title: 'Reaped Track', genres: ['Electronic'] as any, moods: ['Energetic'] });
    const sOld = makeSong('s-old', { title: 'Old Track' });

    await upsertSongs(db(), [s1]); // s2 intentionally absent from `songs` (reaped)

    // s1 played twice (more recent tie-break or 2 plays)
    await insertScrobble({ id: 'r1', song: s1, time: now - 3 * DAY_MS });
    await insertScrobble({ id: 'r2', song: s1, time: now - 1 * DAY_MS });
    // s2 played 3 times within 14 days
    await insertScrobble({ id: 'r3', song: s2, time: now - 5 * DAY_MS });
    await insertScrobble({ id: 'r4', song: s2, time: now - 4 * DAY_MS });
    await insertScrobble({ id: 'r5', song: s2, time: now - 2 * DAY_MS });
    // sOld played 5 times, but > 14 days ago
    for (let i = 0; i < 5; i++) {
      await insertScrobble({ id: `old${i}`, song: sOld, time: now - (20 + i) * DAY_MS });
    }

    const onRepeat = await getOnRepeat(10);
    expect(onRepeat.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(onRepeat[0].title).toBe('Reaped Track');
    expect(onRepeat[0].genres).toEqual(['Electronic']);
    expect(onRepeat[0].moods).toEqual(['Energetic']);
    expect(onRepeat[1].genres).toEqual(['Indie']);
  });

  it('restricts On Repeat to cached_songs when offlineMode is true', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    const s1 = makeSong('s1');
    const s2 = makeSong('s2');
    await upsertSongs(db(), [s1, s2]);
    await seedCachedSongWithMoods(s2);

    await insertScrobble({ id: 'a1', song: s1, time: now - HOUR_MS });
    await insertScrobble({ id: 'a2', song: s1, time: now - 2 * HOUR_MS });
    await insertScrobble({ id: 'b1', song: s2, time: now - 3 * HOUR_MS });

    offlineModeStore.setState({ offlineMode: true });
    const onRepeat = await getOnRepeat(10);
    expect(onRepeat.map((s) => s.id)).toEqual(['s2']);
  });
});

describe('getForgottenGems', () => {
  it('returns songs with >= 2 historical plays and latest play older than 60 days, ordered by play count DESC', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    const oldIso90 = new Date(now - 90 * DAY_MS).toISOString();
    const recentIso10 = new Date(now - 10 * DAY_MS).toISOString();

    const gemServer = makeSong('gem-server', { playCount: 8, played: oldIso90 });
    const gemScrobble = makeSong('gem-scrobble', { playCount: 1 }); // +2 scrobbles = 3
    const gemCombined = makeSong('gem-combined', { playCount: 3, played: oldIso90 }); // +2 scrobbles = 5
    const recentPlayedProp = makeSong('recent-prop', { playCount: 20, played: recentIso10 });
    const recentScrobble = makeSong('recent-scrobble', { playCount: 15, played: oldIso90 });
    const lowPlays = makeSong('low-plays', { playCount: 1, played: oldIso90 });
    const noTimestamp = makeSong('no-ts', { playCount: 10 });

    await upsertSongs(db(), [
      gemServer,
      gemScrobble,
      gemCombined,
      recentPlayedProp,
      recentScrobble,
      lowPlays,
      noTimestamp,
    ]);

    await insertScrobble({ id: 'gs1', song: gemScrobble, time: now - 80 * DAY_MS });
    await insertScrobble({ id: 'gs2', song: gemScrobble, time: now - 70 * DAY_MS });
    await insertScrobble({ id: 'gc1', song: gemCombined, time: now - 75 * DAY_MS });
    await insertScrobble({ id: 'gc2', song: gemCombined, time: now - 65 * DAY_MS });
    // Excluded: has an old `played` field on `songs`, but a recent local scrobble
    await insertScrobble({ id: 'rs1', song: recentScrobble, time: now - 5 * DAY_MS });

    const gems = await getForgottenGems(10);
    expect(gems.map((g) => g.id)).toEqual(['gem-server', 'gem-combined', 'gem-scrobble']);
  });

  it('restricts Forgotten Gems to cached_songs when offlineMode is true (including cached_songs fallback)', async () => {
    const now = 1_750_000_000_000;
    pinTime(now);

    const oldIso90 = new Date(now - 90 * DAY_MS).toISOString();
    const uncached = makeSong('uncached', { playCount: 20, played: oldIso90 });
    const cachedOnly = makeSong('cached-only', { playCount: 4, played: oldIso90 });

    await upsertSongs(db(), [uncached]);
    await seedCachedSongWithMoods(cachedOnly);

    offlineModeStore.setState({ offlineMode: true });
    const gems = await getForgottenGems(10);
    expect(gems.map((g) => g.id)).toEqual(['cached-only']);
  });
});

describe('getQuickMoodChips & getSongsForMoodChip', () => {
  it('derives genre, mood, and BPM energy chips from SQLite and resolves songs per chip', async () => {
    await upsertSongs(db(), [
      makeSong('s1', {
        genre: 'Rock',
        genres: ['Rock', 'Alternative'] as any, // 'Rock' in both shouldn't double-count s1
        moods: ['Upbeat'],
        bpm: 94, // Chill (<95)
        playCount: 5,
      }),
      makeSong('s2', {
        genre: 'Rock',
        moods: ['Focus'],
        bpm: 95, // Groove (95-124)
        playCount: 3,
      }),
      makeSong('s3', {
        genres: ['Electronic'] as any,
        moods: ['Upbeat'],
        bpm: 124, // Groove (95-124)
      }),
      makeSong('s4', {
        genre: 'Electronic',
        bpm: 125, // High Energy (>=125)
      }),
      makeSong('s5', {
        genre: 'Jazz',
        bpm: 0, // ignored for BPM
      }),
    ]);

    const chips = await getQuickMoodChips(12);
    const byId = new Map(chips.map((c) => [c.id, c]));

    expect(byId.get('genre:rock')?.songCount).toBe(2);
    expect(byId.get('genre:electronic')?.songCount).toBe(2);
    expect(byId.get('genre:alternative')?.songCount).toBe(1);
    expect(byId.get('genre:jazz')?.songCount).toBe(1);
    expect(byId.get('mood:upbeat')?.songCount).toBe(2);
    expect(byId.get('mood:focus')?.songCount).toBe(1);
    expect(byId.get('bpm:chill')?.songCount).toBe(1);
    expect(byId.get('bpm:groove')?.songCount).toBe(2);
    expect(byId.get('bpm:high-energy')?.songCount).toBe(1);

    const rockSongs = await getSongsForMoodChip(byId.get('genre:rock')!);
    expect(rockSongs.map((s) => s.id)).toEqual(['s1', 's2']);

    const upbeatSongs = await getSongsForMoodChip(byId.get('mood:upbeat')!);
    expect(upbeatSongs.map((s) => s.id)).toEqual(['s1', 's3']);

    const grooveSongs = await getSongsForMoodChip(byId.get('bpm:groove')!);
    expect(grooveSongs.map((s) => s.id)).toEqual(['s2', 's3']);

    const chillSongs = await getSongsForMoodChip(byId.get('bpm:chill')!);
    expect(chillSongs.map((s) => s.id)).toEqual(['s1']);

    const highEnergySongs = await getSongsForMoodChip(byId.get('bpm:high-energy')!);
    expect(highEnergySongs.map((s) => s.id)).toEqual(['s4']);
  });

  it('restricts chips and resolved songs to downloaded tracks in offlineMode', async () => {
    const onlineOnly = makeSong('online-only', { genre: 'Metal', moods: ['Aggressive'], bpm: 160 });
    const downloadedInLib = makeSong('dl-lib', { genre: 'Ambient', moods: ['Calm'], bpm: 75 });
    const downloadedOnly = makeSong('dl-only', { genre: 'Ambient', moods: ['Dreamy'], bpm: 105 });

    await upsertSongs(db(), [onlineOnly, downloadedInLib]);
    await seedCachedSongWithMoods(downloadedInLib);
    await seedCachedSongWithMoods(downloadedOnly);

    offlineModeStore.setState({ offlineMode: true });

    const chips = await getQuickMoodChips(10);
    const ids = chips.map((c) => c.id);
    expect(ids).not.toContain('genre:metal');
    expect(ids).not.toContain('mood:aggressive');
    expect(ids).not.toContain('bpm:high-energy');

    const ambientChip = chips.find((c) => c.id === 'genre:ambient');
    expect(ambientChip?.songCount).toBe(2);

    const ambientSongs = await getSongsForMoodChip(ambientChip!);
    expect(ambientSongs.map((s) => s.id).sort()).toEqual(['dl-lib', 'dl-only']);

    const dreamyChip = chips.find((c) => c.id === 'mood:dreamy');
    expect(dreamyChip?.songCount).toBe(1);
    expect((await getSongsForMoodChip(dreamyChip!)).map((s) => s.id)).toEqual(['dl-only']);
  });
});

describe('Dynamic Mixes & dynamic_mix_cache', () => {
  it('getDynamicMixSummaries returns mix summaries at 0ms from SQLite with zero network calls', async () => {
    const now = Date.now();
    const s1 = makeSong('r1', { artist: 'Artist A', genre: 'Electronic' });
    const s2 = makeSong('r2', { artist: 'Artist A', genre: 'Electronic' });
    const s3 = makeSong('r3', { artist: 'Artist B', genre: 'Jazz' });
    const s4 = makeSong('r4', { artist: 'Artist B', genre: 'Jazz' });
    const gem = makeSong('gem1', {
      artist: 'Gem Artist',
      genre: 'Ambient',
      playCount: 5,
      played: new Date(now - 90 * DAY_MS).toISOString(),
    });
    await upsertSongs(db(), [s1, s2, s3, s4, gem]);
    await upsertPlaylists(db(), [makePlaylist('pl1', 'Club Mix')]);
    await setPlaylistSongs(db(), 'pl1', ['r1', 'r2']);

    await insertScrobble({ id: 'sc1', song: s1, time: now - 1 * DAY_MS });
    await insertScrobble({ id: 'sc2', song: s2, time: now - 2 * DAY_MS });
    await insertScrobble({ id: 'sc3', song: s3, time: now - 3 * DAY_MS });
    await insertScrobble({ id: 'sc4', song: s4, time: now - 4 * DAY_MS });

    mockIsSonicSimilarityAvailable.mockReturnValue(true);
    const summaries = await getDynamicMixSummaries();

    expect(mockGetSonicSimilarTracks).not.toHaveBeenCalled();
    expect(mockFindSonicPath).not.toHaveBeenCalled();
    expect(summaries.some((m) => m.mixKey === 'daily-mix-1')).toBe(true);
    expect(summaries.some((m) => m.mixKey === 'daily-mix-2')).toBe(true);
    expect(summaries.some((m) => m.mixKey === 'daylist')).toBe(true);
    expect(summaries.some((m) => m.mixKey === 'rediscovery-bridge')).toBe(true);
  });

  it('resolveDynamicMix resolves Daily Mix via sonicSimilarity, caches it, and returns cache hit on subsequent call', async () => {
    const now = Date.now();
    const seed1 = makeSong('r1', { artist: 'Artist A', genre: 'Electronic' });
    const seed2 = makeSong('r2', { artist: 'Artist A', genre: 'Electronic' });
    const sonicShared = makeSong('son-shared', { artist: 'Artist C', genre: 'Electronic' });
    const sonicOther = makeSong('son-other', { artist: 'Artist D', genre: 'Electronic' });
    await upsertSongs(db(), [seed1, seed2, sonicShared, sonicOther]);

    await insertScrobble({ id: 'sc1', song: seed1, time: now - 1 * DAY_MS });
    await insertScrobble({ id: 'sc2', song: seed1, time: now - 2 * DAY_MS });
    await insertScrobble({ id: 'sc3', song: seed2, time: now - 3 * DAY_MS });

    mockIsSonicSimilarityAvailable.mockReturnValue(true);
    mockGetSonicSimilarTracks.mockImplementation(async (id: string) => {
      if (id === 'r1') {
        return [
          { song: sonicShared, similarity: 0.85 },
          { song: sonicOther, similarity: 0.9 },
        ];
      }
      return [{ song: sonicShared, similarity: 0.88 }];
    });

    const first = await resolveDynamicMix('daily-mix-1', { targetCount: 10 });
    expect(first).not.toBeNull();
    expect(first!.source).toBe('sonic');
    expect(first!.fromCache).toBe(false);
    expect(first!.songs.map((s) => s.id)).toContain('son-shared');
    // Recurring song across both seeds ranks ahead of single-seed song
    const ids = first!.songs.map((s) => s.id);
    expect(ids.indexOf('son-shared')).toBeLessThan(ids.indexOf('son-other'));

    // Second call hits dynamic_mix_cache without hitting network again
    mockGetSonicSimilarTracks.mockClear();
    const second = await resolveDynamicMix('daily-mix-1', { targetCount: 10 });
    expect(second).not.toBeNull();
    expect(second!.fromCache).toBe(true);
    expect(second!.source).toBe('sonic');
    expect(mockGetSonicSimilarTracks).not.toHaveBeenCalled();
  });

  it('resolveDynamicMix resolves rediscovery-bridge via findSonicPath and falls back locally on timeout/offline', async () => {
    const now = Date.now();
    const onRep = makeSong('rep-1', { artist: 'Repeat Artist', genre: 'Ambient' });
    const mid = makeSong('mid-1', { artist: 'Mid Artist', genre: 'Ambient', playCount: 3 });
    const gem = makeSong('gem-1', {
      artist: 'Gem Artist',
      genre: 'Ambient',
      playCount: 4,
      played: new Date(now - 90 * DAY_MS).toISOString(),
    });
    await upsertSongs(db(), [onRep, mid, gem]);
    await insertScrobble({ id: 'sc1', song: onRep, time: now - 1 * DAY_MS });

    mockIsSonicSimilarityAvailable.mockReturnValue(true);
    mockFindSonicPath.mockResolvedValue([
      { song: onRep, similarity: 1.0 },
      { song: mid, similarity: 0.8 },
      { song: gem, similarity: 0.6 },
    ]);

    const sonicBridge = await resolveDynamicMix('rediscovery-bridge');
    expect(sonicBridge).not.toBeNull();
    expect(sonicBridge!.source).toBe('sonic');
    expect(sonicBridge!.songs.map((s) => s.id)).toEqual(['rep-1', 'mid-1', 'gem-1']);

    // Timeout (>2.5s) forces instantaneous local fallback
    mockFindSonicPath.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    const localBridge = await resolveDynamicMix('rediscovery-bridge', {
      forceRefresh: true,
      timeoutMs: 120,
    });
    expect(localBridge).not.toBeNull();
    expect(localBridge!.source).toBe('local');
    expect(localBridge!.songs.map((s) => s.id)).toContain('rep-1');
    expect(localBridge!.songs.map((s) => s.id)).toContain('gem-1');
  });
});
