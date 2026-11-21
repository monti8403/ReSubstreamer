jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../secureKeyVault', () => ({
  loadApiKeySecret: jest.fn().mockResolvedValue(''),
  saveApiKeySecret: jest.fn().mockResolvedValue(undefined),
  clearApiKeySecret: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../subsonicService', () => ({
  getSimilarSongs: jest.fn(),
  getSimilarSongs2: jest.fn(),
  getRandomSongsFiltered: jest.fn(),
  getTopSongs: jest.fn(),
  search3: jest.fn(),
}));

import type { Child, Playlist } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { setPlaylistSongs, upsertPlaylists } from '../../db/repository/playlists';
import { upsertSongs } from '../../db/repository/songs';
import { offlineModeStore } from '../../store/offlineModeStore';
import { __setDbForTests, getDb } from '../../store/persistence/db';
import { upsertCachedSong, type CachedSongRow } from '../../store/persistence/musicCacheTables';
import { deriveScrobbleColumns, scrobbleColumnValues, SCROBBLE_COLUMN_NAMES } from '../../store/persistence/scrobbleColumns';
import { radioAiSettingsStore, type RadioAiSettingsSnapshot } from '../../store/radioAiSettingsStore';
import {
  extractPrimaryArtistName,
  getSmartRadioTracks,
  hasFeaturingOrSeparator,
  registerSmartRadioAiBoostProvider,
} from '../smartRadioService';
import {
  getRandomSongsFiltered,
  getSimilarSongs,
  getSimilarSongs2,
  getTopSongs,
  search3,
} from '../subsonicService';

const mockGetSimilarSongs = getSimilarSongs as jest.Mock;
const mockGetSimilarSongs2 = getSimilarSongs2 as jest.Mock;
const mockGetRandomSongsFiltered = getRandomSongsFiltered as jest.Mock;
const mockGetTopSongs = getTopSongs as jest.Mock;
const mockSearch3 = search3 as jest.Mock;

const realDb = getDb()!;

const TABLES_TO_CLEAR = [
  'playlist_songs',
  'playlists',
  'scrobble_genres',
  'scrobble_artists',
  'scrobble_album_artists',
  'scrobble_contributors',
  'scrobble_moods',
  'scrobble_events',
  'cached_song_genres',
  'cached_song_artists',
  'cached_song_album_artists',
  'cached_song_contributors',
  'cached_song_moods',
  'cached_songs',
  'favorite_songs',
  'song_genres',
  'song_artists',
  'song_album_artists',
  'song_contributors',
  'song_moods',
  'songs',
  'artists',
];

function makeSong(id: string, overrides: Partial<Child> = {}): Child {
  return {
    id,
    title: `Track ${id}`,
    isDir: false,
    duration: 200,
    ...overrides,
  } as Child;
}

function makeSettings(overrides: Partial<RadioAiSettingsSnapshot> = {}): RadioAiSettingsSnapshot {
  return {
    infiniteAutoplay: true,
    radioMode: 'balanced',
    sources: {
      server: true,
      localHistory: true,
      metadata: true,
      aiBoost: false,
    },
    sessionAntiRepeat: true,
    provider: 'disabled',
    baseUrl: '',
    modelName: '',
    apiKey: '',
    ...overrides,
  };
}

function insertScrobbleRow(id: string, song: Child, timeMs: number): void {
  const cols = scrobbleColumnValues(deriveScrobbleColumns(song, timeMs));
  realDb.runSync(
    `INSERT INTO scrobble_events (id, time, ${SCROBBLE_COLUMN_NAMES.join(', ')})
     VALUES (${new Array(2 + SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`,
    [id, timeMs, ...cols],
  );
}

beforeAll(() => {
  ensureNormalizedSchema(realDb);
});

beforeEach(() => {
  __setDbForTests(realDb);
  for (const table of TABLES_TO_CLEAR) {
    realDb.runSync(`DELETE FROM ${table};`);
  }
  jest.clearAllMocks();
  mockGetSimilarSongs.mockResolvedValue([]);
  mockGetSimilarSongs2.mockResolvedValue([]);
  mockGetRandomSongsFiltered.mockResolvedValue([]);
  mockGetTopSongs.mockResolvedValue([]);
  mockSearch3.mockResolvedValue({});
  offlineModeStore.setState({ offlineMode: false });
  radioAiSettingsStore.getState().resetRadioAiSettings();
  registerSmartRadioAiBoostProvider(null);
});

afterEach(() => {
  __setDbForTests(realDb);
  registerSmartRadioAiBoostProvider(null);
});

describe('hasFeaturingOrSeparator & extractPrimaryArtistName', () => {
  it('detects featuring markers and separators in artist and title', () => {
    expect(hasFeaturingOrSeparator('Drake feat. 21 Savage', 'Knife Talk')).toBe(true);
    expect(hasFeaturingOrSeparator('Drake ft. 21 Savage', 'Knife Talk')).toBe(true);
    expect(hasFeaturingOrSeparator('Drake featuring 21 Savage', 'Knife Talk')).toBe(true);
    expect(hasFeaturingOrSeparator('Artie 5ive/Kid Yugi', 'SACRIFICIO')).toBe(true);
    expect(hasFeaturingOrSeparator('Artist A, Artist B', 'Collab')).toBe(true);
    expect(hasFeaturingOrSeparator('Artist A & Artist B', 'Collab')).toBe(true);
    expect(hasFeaturingOrSeparator('Artist A; Artist B', 'Collab')).toBe(true);
    expect(hasFeaturingOrSeparator('Artie 5ive', 'SACRIFICIO (feat. Kid Yugi)')).toBe(true);
    expect(hasFeaturingOrSeparator('Artie 5ive', 'SACRIFICIO [ft. Kid Yugi]')).toBe(true);

    expect(hasFeaturingOrSeparator('Feature Band', 'Defeat')).toBe(false);
    expect(hasFeaturingOrSeparator('Solo Artist', 'Solo Title')).toBe(false);
    expect(hasFeaturingOrSeparator(undefined, undefined)).toBe(false);
  });

  it('extracts the primary artist name cleanly', () => {
    expect(extractPrimaryArtistName('Drake feat. 21 Savage')).toBe('Drake');
    expect(extractPrimaryArtistName('Drake ft. 21 Savage')).toBe('Drake');
    expect(extractPrimaryArtistName('Drake featuring 21 Savage')).toBe('Drake');
    expect(extractPrimaryArtistName('Artie 5ive/Kid Yugi')).toBe('Artie 5ive');
    expect(extractPrimaryArtistName('Artist A, Artist B')).toBe('Artist A');
    expect(extractPrimaryArtistName('Artist A & Artist B')).toBe('Artist A');
    expect(extractPrimaryArtistName('Artist A; Artist B')).toBe('Artist A');
    expect(extractPrimaryArtistName('Artie 5ive', 'SACRIFICIO (feat. Kid Yugi)')).toBe('Artie 5ive');
    expect(extractPrimaryArtistName('')).toBe('');
  });
});

describe('Level 1 — Server Subsonic waterfall', () => {
  it('resolves primary artist on thin featuring track and retries getSimilarSongs2 + getTopSongs', async () => {
    realDb.runSync('INSERT INTO artists (id, name, norm_name) VALUES (?, ?, ?);', [
      'art-drake',
      'Drake',
      'drake',
    ]);
    mockGetSimilarSongs.mockResolvedValue([makeSong('t1')]);
    mockGetSimilarSongs2
      .mockResolvedValueOnce([]) // collab artistId 'collab-1'
      .mockResolvedValueOnce([makeSong('t2'), makeSong('t3'), makeSong('t4'), makeSong('t5'), makeSong('t6')]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [
        makeSong('seed', {
          artist: 'Drake feat. 21 Savage',
          artistId: 'collab-1',
        }),
      ],
      targetCount: 6,
      settings: makeSettings({
        sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    expect(mockGetSimilarSongs2).toHaveBeenNthCalledWith(1, 'collab-1', 6);
    expect(mockGetSimilarSongs2).toHaveBeenNthCalledWith(2, 'art-drake', 6);
    expect(mockGetTopSongs).not.toHaveBeenCalled();
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('falls back to getTopSongs in Level 1 if resolved artist similar2 is still < 5', async () => {
    mockGetSimilarSongs.mockResolvedValue([makeSong('t1')]);
    mockSearch3.mockResolvedValue({ artists: [{ id: 'art-primary', name: 'Artie 5ive' }] });
    mockGetSimilarSongs2.mockResolvedValue([makeSong('t2')]);
    mockGetTopSongs.mockResolvedValue([makeSong('top1'), makeSong('top2'), makeSong('top3'), makeSong('top4')]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed', { artist: 'Artie 5ive/Kid Yugi', title: 'SACRIFICIO' })],
      targetCount: 6,
      settings: makeSettings({
        sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    expect(mockGetSimilarSongs2).toHaveBeenCalledWith('art-primary', 6);
    expect(mockGetTopSongs).toHaveBeenCalledWith('Artie 5ive', 6);
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2', 'top1', 'top2', 'top3', 'top4']);
  });

  it('does not call getSimilarSongs2 when no artistId and no featuring/separator', async () => {
    mockGetSimilarSongs.mockResolvedValue([makeSong('t1'), makeSong('t2')]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed', { artist: 'Solo Artist' })],
      targetCount: 10,
      settings: makeSettings({
        sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    expect(mockGetSimilarSongs2).not.toHaveBeenCalled();
    expect(mockGetRandomSongsFiltered).not.toHaveBeenCalled();
    expect(mockGetTopSongs).toHaveBeenCalledWith('Solo Artist', 10); // Level 4c fallback since < 10
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('Level 2 — Personal Co-occurrence (SQLite, offline)', () => {
  it('scores tracks appearing in the same playlists and ±30m scrobble window, filtering offline to cached_songs', async () => {
    const seed = makeSong('s-seed', { artist: 'Seed Artist', artistId: 'ar-seed' });
    const plCo = makeSong('s-pl', { artist: 'Artist B' });
    const scCo = makeSong('s-sc', { artist: 'Artist C' });
    const scOutside = makeSong('s-far', { artist: 'Artist D' });
    const uncachedPl = makeSong('s-uncached', { artist: 'Artist E' });

    await upsertSongs(realDb, [seed, plCo, scCo, scOutside, uncachedPl]);
    await upsertPlaylists(realDb, [
      { id: 'pl1', name: 'Mix 1', songCount: 3, duration: 600, created: new Date() } as Playlist,
    ]);
    await setPlaylistSongs(realDb, 'pl1', ['s-seed', 's-pl', 's-uncached']);

    const baseTime = 1_700_000_000_000;
    insertScrobbleRow('e1', seed, baseTime);
    insertScrobbleRow('e2', scCo, baseTime + 15 * 60_000); // within 30m
    insertScrobbleRow('e3', scOutside, baseTime + 45 * 60_000); // outside 30m

    // Cache only s-pl and s-sc for offline mode
    for (const s of [plCo, scCo]) {
      await upsertCachedSong({
        id: s.id,
        title: s.title,
        artist: s.artist,
        albumId: 'dir',
        bytes: 1000,
        duration: 200,
        suffix: 'mp3',
        formatCapturedAt: 1,
        downloadedAt: 1,
      } as CachedSongRow);
    }

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 5,
      downloadedOnly: true,
      settings: makeSettings({
        sources: { server: false, localHistory: true, metadata: false, aiBoost: false },
      }),
    });

    const ids = tracks.map((t) => t.id);
    expect(ids).toContain('s-pl');
    expect(ids).toContain('s-sc');
    expect(ids).not.toContain('s-uncached');
    expect(ids).not.toContain('s-far');
    expect(mockGetSimilarSongs).not.toHaveBeenCalled();
  });

  it('uses scrobble snapshot fallback when songs table lacks the row', async () => {
    const seed = makeSong('s-seed', { artist: 'Seed Artist' });
    const snapOnly = makeSong('s-snap', { artist: 'Snap Artist', genre: 'Indie' });

    const now = 1_700_000_000_000;
    insertScrobbleRow('e1', seed, now);
    insertScrobbleRow('e2', snapOnly, now + 10 * 60_000);

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 5,
      settings: makeSettings({
        sources: { server: false, localHistory: true, metadata: false, aiBoost: false },
      }),
    });

    expect(tracks.map((t) => t.id)).toEqual(['s-snap']);
    expect(tracks[0].artist).toBe('Snap Artist');
  });
});

describe('Level 3 — Metadata Affinity & Modes', () => {
  it('ranks multi-attribute matches (genre + year + bpm) higher in faithful mode', async () => {
    const seed = makeSong('s-seed', {
      artist: 'Seed',
      artistId: 'ar-seed',
      genre: 'Shoegaze',
      year: 1991,
      bpm: 120,
    });
    const exactMatch = makeSong('s-exact', {
      artist: 'Other A',
      genre: 'Shoegaze',
      genres: [{ name: 'Shoegaze' }] as any,
      year: 1992,
      bpm: 122,
    });
    const genreOnly = makeSong('s-genre', {
      artist: 'Other B',
      genre: 'Shoegaze',
      year: 2020,
      bpm: 170,
    });
    const unrelated = makeSong('s-other', {
      artist: 'Other C',
      genre: 'Techno',
      year: 2022,
      bpm: 140,
    });

    await upsertSongs(realDb, [seed, genreOnly, exactMatch, unrelated]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 2,
      settings: makeSettings({
        radioMode: 'faithful',
        sources: { server: false, localHistory: false, metadata: true, aiBoost: false },
      }),
    });

    expect(tracks.map((t) => t.id)).toEqual(['s-exact', 's-genre']);
  });

  it('boosts low-playCount / stale tracks in discovery mode', async () => {
    const seed = makeSong('s-seed', { genre: 'Electronic', year: 2020, bpm: 124 });
    const overplayed = makeSong('s-hit', {
      artist: 'Hit Artist',
      genre: 'Electronic',
      year: 2020,
      bpm: 124,
      playCount: 50,
      played: new Date().toISOString(),
    });
    const gem = makeSong('s-gem', {
      artist: 'Gem Artist',
      genre: 'Electronic',
      year: 2020,
      bpm: 124,
      playCount: 0,
    });

    await upsertSongs(realDb, [seed, overplayed, gem]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 2,
      settings: makeSettings({
        radioMode: 'discovery',
        sources: { server: false, localHistory: false, metadata: true, aiBoost: false },
      }),
    });

    expect(tracks[0].id).toBe('s-gem');
  });

  it('prioritizes matching song_moods in mood mode over artist or year alone', async () => {
    const seed = makeSong('s-seed', {
      artist: 'Seed Artist',
      artistId: 'ar-seed',
      genre: 'Indie Pop',
      moods: ['melancholic', 'dreamy'],
      year: 2020,
      bpm: 98,
    });
    const sameMood = makeSong('s-mood', {
      artist: 'Mood Artist',
      genre: 'Dream Pop',
      moods: ['melancholic'],
      year: 2019,
      bpm: 96,
    });
    const sameArtistWrongMood = makeSong('s-same-artist', {
      artist: 'Seed Artist',
      artistId: 'ar-seed',
      genre: 'Indie Pop',
      moods: ['upbeat', 'party'],
      year: 2020,
      bpm: 130,
    });

    await upsertSongs(realDb, [seed, sameArtistWrongMood, sameMood]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 2,
      settings: makeSettings({
        radioMode: 'mood',
        sources: { server: false, localHistory: false, metadata: true, aiBoost: false },
      }),
    });

    expect(tracks[0].id).toBe('s-mood');
  });

  it('falls back to cached_songs in offline mode when songs table is empty', async () => {
    const seed = makeSong('s-seed', { genre: 'Jazz', year: 1965, bpm: 100 });
    await upsertCachedSong({
      id: 'c-1',
      title: 'Cached Jazz',
      artist: 'Miles',
      albumId: 'dir',
      bytes: 1000,
      duration: 240,
      suffix: 'mp3',
      genre: 'Jazz',
      year: 1964,
      bpm: 105,
      formatCapturedAt: 1,
      downloadedAt: 1,
    } as CachedSongRow);

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 5,
      downloadedOnly: true,
      settings: makeSettings({
        sources: { server: false, localHistory: false, metadata: true, aiBoost: false },
      }),
    });

    expect(tracks.map((t) => t.id)).toEqual(['c-1']);
  });
});

describe('AI Boost, Level 4 safety net, anti-repeat, and artist spacing', () => {
  it('applies registered AI boost provider when enabled online and ignores errors', async () => {
    mockGetSimilarSongs.mockResolvedValue([makeSong('t1'), makeSong('t2')]);
    registerSmartRadioAiBoostProvider(async () => [makeSong('ai-1')]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 3,
      settings: makeSettings({
        provider: 'openai',
        sources: { server: true, localHistory: false, metadata: false, aiBoost: true },
      }),
    });
    expect(tracks.map((t) => t.id)).toContain('ai-1');

    // Failing provider never throws
    registerSmartRadioAiBoostProvider(async () => {
      throw new Error('AI down');
    });
    const safeTracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 2,
      settings: makeSettings({
        provider: 'openai',
        sources: { server: true, localHistory: false, metadata: false, aiBoost: true },
      }),
    });
    expect(safeTracks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('uses strict priority waterfall: AI-only when AI fills target, and Server-only when AI is off and Server fills target', async () => {
    const seed = makeSong('seed', { genre: 'Indie', year: 2020 });
    const localExtra = makeSong('local-extra', { genre: 'Indie', year: 2020 });
    await upsertSongs(realDb, [seed, localExtra]);

    // 1. AI enabled & returns >= targetCount -> skips server & local SQLite
    registerSmartRadioAiBoostProvider(async () => [makeSong('ai-1'), makeSong('ai-2')]);
    mockGetSimilarSongs.mockResolvedValue([makeSong('srv-1'), makeSong('srv-2')]);

    const aiOnly = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 2,
      settings: makeSettings({
        provider: 'groq',
        sources: { server: true, localHistory: true, metadata: true, aiBoost: true },
      }),
    });
    expect(aiOnly.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
    expect(mockGetSimilarSongs).not.toHaveBeenCalled();

    // 2. AI disabled & Server returns >= targetCount -> skips localHistory & metadata
    const serverOnly = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 2,
      settings: makeSettings({
        provider: 'disabled',
        sources: { server: true, localHistory: true, metadata: true, aiBoost: false },
      }),
    });
    expect(mockGetSimilarSongs).toHaveBeenCalledTimes(1);
    expect(serverOnly.map((t) => t.id)).toEqual(['srv-1', 'srv-2']);
    expect(serverOnly.map((t) => t.id)).not.toContain('local-extra');
  });

  it('relaxes excludeIds when library pool is exhausted while still excluding playing seed', async () => {
    mockGetSimilarSongs.mockResolvedValue([
      makeSong('seed'),
      makeSong('prev-1'),
      makeSong('prev-2'),
      makeSong('fresh-1'),
    ]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 3,
      excludeIds: new Set(['prev-1', 'prev-2']),
      settings: makeSettings({
        sessionAntiRepeat: true,
        sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    expect(tracks.map((t) => t.id)).toEqual(['fresh-1', 'prev-1', 'prev-2']);
    expect(tracks.map((t) => t.id)).not.toContain('seed');
  });

  it('allows consecutive same-artist tracks naturally without rigid spacing and varies order when randomize=true', async () => {
    mockGetSimilarSongs.mockResolvedValue([
      makeSong('a1', { artist: 'Artist A' }),
      makeSong('a2', { artist: 'Artist A' }),
      makeSong('a3', { artist: 'Artist A' }),
      makeSong('b1', { artist: 'Artist B' }),
    ]);

    const ordered = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 4,
      settings: makeSettings({
        sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    expect(ordered.map((t) => t.id)).toEqual(['a1', 'a2', 'a3', 'b1']);

    // Verify randomize=true requests a wider pool (>= 35) and shifts order with jitter
    const pool = Array.from({ length: 10 }, (_, idx) => makeSong(`r${idx + 1}`, { artist: `Art ${idx}` }));
    mockGetSimilarSongs.mockResolvedValue(pool);

    const spy = jest.spyOn(Math, 'random').mockImplementation(() => {
      // Deterministic alternating highs/lows to prove jitter reorders equal candidates
      return spy.mock.calls.length % 2 === 1 ? 0.99 : 0.01;
    });
    try {
      const varied = await getSmartRadioTracks({
        seedSongs: [makeSong('seed')],
        targetCount: 10,
        randomize: true,
        settings: makeSettings({
          sources: { server: true, localHistory: false, metadata: false, aiBoost: false },
        }),
      });
      expect(mockGetSimilarSongs).toHaveBeenLastCalledWith('seed', 35);
      expect(varied.map((t) => t.id)).not.toEqual(pool.map((t) => t.id));
    } finally {
      spy.mockRestore();
    }
  });

  it('fills from Level 4 safety net (same hour scrobble, starred, and local library)', async () => {
    const seed = makeSong('seed');
    const starredSong = makeSong('star-1', { artist: 'Starred Artist', starred: new Date() });
    const libSong = makeSong('lib-1', { artist: 'Lib Artist' });
    await upsertSongs(realDb, [seed, starredSong, libSong]);

    const now = new Date();
    insertScrobbleRow('h1', makeSong('hour-1', { artist: 'Hour Artist' }), now.getTime());

    const tracks = await getSmartRadioTracks({
      seedSongs: [seed],
      targetCount: 3,
      settings: makeSettings({
        sources: { server: false, localHistory: false, metadata: false, aiBoost: false },
      }),
    });

    const ids = tracks.map((t) => t.id);
    expect(ids).toContain('hour-1');
    expect(ids).toContain('star-1');
    expect(ids).toContain('lib-1');
  });

  it('survives null or incomplete mock DB without crashing', async () => {
    __setDbForTests({} as any);
    mockGetSimilarSongs.mockResolvedValue([makeSong('t1')]);

    const tracks = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 5,
    });
    expect(tracks.map((t) => t.id)).toEqual(['t1']);

    __setDbForTests(null);
    const tracksNullDb = await getSmartRadioTracks({
      seedSongs: [makeSong('seed')],
      targetCount: 5,
    });
    expect(tracksNullDb.map((t) => t.id)).toEqual(['t1']);
  });
});
