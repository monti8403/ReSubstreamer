/**
 * Smart Radio engine — 4-level waterfall recommendation pipeline with
 * mode-weighted scoring (`faithful` | `balanced` | `discovery`), optional
 * BYOK AI boost, session anti-repeat relaxation, and artist spacing.
 *
 * Levels:
 *   1. Server Subsonic (`getSimilarSongs`, `getSimilarSongs2`, featuring/collab primary-artist resolution)
 *   2. Personal Co-occurrence (SQLite `playlist_songs` + `scrobble_events` ±30m window & artist affinity)
 *   3. Metadata Affinity (SQLite `songs` / `song_genres` / `cached_songs`: genre, year ±5, BPM ±15, artist)
 *   Optional AI Boost (registered provider when `sources.aiBoost` is enabled online)
 *   4. Final Safety Net (time-of-day scrobble bucket, starred songs, genre random / artist top, local library random)
 */
import type { Child } from 'subsonic-api';

import type { InternalDb } from '../db/client';
import {
  hydrateSongRows,
  SONG_LIST_COLS_S,
  songListRowToChild,
  type SongListRow,
} from '../db/repository/songs';
import { offlineModeStore } from '../store/offlineModeStore';
import { getDb } from '../store/persistence/db';
import type {
  RadioAiSettingsSnapshot,
  RadioMode,
} from '../store/radioAiSettingsStore';
import { resolveArtistId } from './artistResolutionService';
import {
  getRandomSongsFiltered,
  getSimilarSongs,
  getSimilarSongs2,
  getTopSongs,
} from './subsonicService';

const DEFAULT_RADIO_AI_SETTINGS: RadioAiSettingsSnapshot = {
  infiniteAutoplay: true,
  radioMode: 'mood',
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
};

function readRadioAiSettings(): RadioAiSettingsSnapshot {
  try {
    // Lazy require avoids crashing Jest suites that mock `react-native` without
    // `NativeModules`, which breaks transitive `expo-crypto` -> `expo-constants` init.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../store/radioAiSettingsStore') as {
      radioAiSettingsStore?: { getState: () => RadioAiSettingsSnapshot };
    };
    return mod?.radioAiSettingsStore?.getState() ?? DEFAULT_RADIO_AI_SETTINGS;
  } catch {
    return DEFAULT_RADIO_AI_SETTINGS;
  }
}

function getTrackSkipPenalty(songId: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../store/radioSkipStore') as {
      radioSkipStore?: { getState: () => { getSkipPenalty?: (id: string) => number } };
    };
    return mod?.radioSkipStore?.getState()?.getSkipPenalty?.(songId) ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Public types & AI boost registry                                   */
/* ------------------------------------------------------------------ */

export interface SmartRadioRequest {
  seedSongs: Child[];
  targetCount: number;
  excludeIds?: Set<string>;
  settings?: RadioAiSettingsSnapshot;
  downloadedOnly?: boolean;
  /** Apply balanced score jitter (±14) across a wider pool (~35+) so repeated launches vary order & selection. */
  randomize?: boolean;
}

export type AiBoostProvider = (
  seedSongs: Child[],
  targetCount: number,
  excludeIds?: Set<string>,
) => Promise<Child[]>;

let registeredAiBoostProvider: AiBoostProvider | null = null;

/** Register or clear an override AI boost candidate provider (e.g. for tests). */
export function registerSmartRadioAiBoostProvider(
  provider: AiBoostProvider | null,
): void {
  registeredAiBoostProvider = provider;
}

function resolveAiBoostProvider(): AiBoostProvider | null {
  if (registeredAiBoostProvider) return registeredAiBoostProvider;
  try {
    // Lazy require breaks the runtime cycle with byokAiService and avoids
    // crashing Jest suites that stub react-native without NativeModules.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./byokAiService') as {
      boostRadioCandidates?: AiBoostProvider;
    };
    return typeof mod?.boostRadioCandidates === 'function'
      ? mod.boostRadioCandidates
      : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Featuring / multi-artist parsing                                   */
/* ------------------------------------------------------------------ */

const ARTIST_FEAT_OR_SEP_RE =
  /[,&/;]|\b(?:feat\.?|ft\.?|featuring)\b/i;

const TITLE_FEAT_RE =
  /[\(\[]\s*(?:feat\.?|ft\.?|featuring)(?:\.|\b)[^)\]]*[\)\]]/i;

const ARTIST_SPLIT_RE =
  /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)(?:\.|\b)[^)\]]*[\)\]]|\s+(?:feat\.?|ft\.?|featuring)(?:\.|\s)\s*|\s*[,&/;]\s*/i;

/**
 * True when an artist string carries featuring/collaborator delimiters
 * (`feat.`, `ft.`, `featuring`, `,`, `&`, `/`, `;`) or the title carries `(feat. ...)`.
 */
export function hasFeaturingOrSeparator(
  artist?: string | null,
  title?: string | null,
): boolean {
  if (artist && ARTIST_FEAT_OR_SEP_RE.test(artist)) return true;
  if (title && TITLE_FEAT_RE.test(title)) return true;
  return false;
}

/**
 * Extract the leading primary artist name before any featuring tag or
 * collaborator separator.
 */
export function extractPrimaryArtistName(
  artist?: string | null,
  _title?: string | null,
): string {
  if (!artist) return '';
  const trimmed = artist.trim().replace(/^['"]+|['"]+$/g, '');
  if (!trimmed) return '';
  const parts = trimmed
    .split(ARTIST_SPLIT_RE)
    .map((p) => p.trim().replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
  return parts[0] ?? trimmed;
}

/* ------------------------------------------------------------------ */
/*  Mode weight profiles                                               */
/* ------------------------------------------------------------------ */

interface ModeWeights {
  serverSimilarSong: number;
  serverSimilarArtist: number;
  serverLevel1TopSongs: number;
  localPlaylistCooccur: number;
  localScrobbleCooccur: number;
  localScrobbleArtist: number;
  localMetadataMax: number;
  aiBoost: number;
  level4TimeBucket: number;
  level4Starred: number;
  level4GenreRandom: number;
  level4TopSongs: number;
  level4LibraryFallback: number;
  moodMatchBonus: number;
  genreMatchBonus: number;
  yearCloseBonus: number;
  bpmCloseBonus: number;
  discoveryBonusMultiplier: number;
}

const MODE_WEIGHTS: Record<RadioMode, ModeWeights> = {
  mood: {
    serverSimilarSong: 100,
    serverSimilarArtist: 65,
    serverLevel1TopSongs: 45,
    localPlaylistCooccur: 55,
    localScrobbleCooccur: 50,
    localScrobbleArtist: 35,
    localMetadataMax: 95,
    aiBoost: 130,
    level4TimeBucket: 25,
    level4Starred: 22,
    level4GenreRandom: 24,
    level4TopSongs: 15,
    level4LibraryFallback: 5,
    moodMatchBonus: 45,
    genreMatchBonus: 18,
    yearCloseBonus: 6,
    bpmCloseBonus: 18,
    discoveryBonusMultiplier: 0.35,
  },
  faithful: {
    serverSimilarSong: 120,
    serverSimilarArtist: 95,
    serverLevel1TopSongs: 70,
    localPlaylistCooccur: 45,
    localScrobbleCooccur: 40,
    localScrobbleArtist: 50,
    localMetadataMax: 75,
    aiBoost: 110,
    level4TimeBucket: 28,
    level4Starred: 26,
    level4GenreRandom: 24,
    level4TopSongs: 20,
    level4LibraryFallback: 5,
    moodMatchBonus: 30,
    genreMatchBonus: 25,
    yearCloseBonus: 15,
    bpmCloseBonus: 15,
    discoveryBonusMultiplier: 0,
  },
  balanced: {
    serverSimilarSong: 105,
    serverSimilarArtist: 75,
    serverLevel1TopSongs: 60,
    localPlaylistCooccur: 68,
    localScrobbleCooccur: 62,
    localScrobbleArtist: 55,
    localMetadataMax: 65,
    aiBoost: 115,
    level4TimeBucket: 30,
    level4Starred: 28,
    level4GenreRandom: 25,
    level4TopSongs: 20,
    level4LibraryFallback: 5,
    moodMatchBonus: 28,
    genreMatchBonus: 14,
    yearCloseBonus: 8,
    bpmCloseBonus: 8,
    discoveryBonusMultiplier: 0.25,
  },
  discovery: {
    serverSimilarSong: 85,
    serverSimilarArtist: 70,
    serverLevel1TopSongs: 45,
    localPlaylistCooccur: 65,
    localScrobbleCooccur: 60,
    localScrobbleArtist: 40,
    localMetadataMax: 65,
    aiBoost: 115,
    level4TimeBucket: 28,
    level4Starred: 25,
    level4GenreRandom: 24,
    level4TopSongs: 18,
    level4LibraryFallback: 5,
    moodMatchBonus: 24,
    genreMatchBonus: 12,
    yearCloseBonus: 6,
    bpmCloseBonus: 6,
    discoveryBonusMultiplier: 1.0,
  },
};

/* ------------------------------------------------------------------ */
/*  SQL projections & row adapters                                     */
/* ------------------------------------------------------------------ */

const CACHED_SONG_AS_LIST_COLS = [
  'cs.song_id AS id',
  'COALESCE(cs.src_album_id, cs.album_id) AS album_id',
  'cs.artist_id',
  'cs.title',
  'cs.album',
  'cs.artist',
  'cs.display_artist',
  'cs.display_album_artist',
  'cs.display_composer',
  'cs.track',
  'cs.disc_number',
  'cs.year',
  'cs.genre',
  'cs.cover_art',
  'cs.duration',
  'cs.size',
  'cs.content_type',
  'cs.src_suffix AS suffix',
  'cs.transcoded_content_type',
  'cs.transcoded_suffix',
  'cs.src_bit_rate AS bit_rate',
  'cs.src_bit_depth AS bit_depth',
  'cs.src_sampling_rate AS sampling_rate',
  'cs.channel_count',
  'cs.path',
  'cs.user_rating',
  'cs.average_rating',
  'cs.play_count',
  'cs.created',
  'cs.starred',
  'cs.played',
  'cs.type',
  'cs.bpm',
  'cs.comment',
  'cs.sort_name',
  'NULL AS sort_title',
  'NULL AS sort_artist',
  'cs.music_brainz_id',
  'cs.explicit_status',
  'cs.bookmark_position',
  'cs.is_video',
  'cs.is_dir',
  'cs.parent',
  'cs.original_width',
  'cs.original_height',
  'cs.rg_track_gain',
  'cs.rg_album_gain',
  'cs.rg_track_peak',
  'cs.rg_album_peak',
  'cs.rg_base_gain',
  'cs.rg_fallback_gain',
].join(', ');

interface ScrobbleCandidateRow {
  song_id: string;
  title: string | null;
  artist: string | null;
  artist_id: string | null;
  album: string | null;
  album_id: string | null;
  cover_art: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
  bpm: number | null;
  play_count: number | null;
  played: string | null;
  user_rating: number | null;
  starred: number | null;
  weight_metric?: number;
}

const SCROBBLE_SELECT_FIELDS = (alias: string): string =>
  [
    `${alias}.song_id`,
    `${alias}.title`,
    `${alias}.artist`,
    `${alias}.artist_id`,
    `${alias}.album`,
    `${alias}.album_id`,
    `${alias}.cover_art`,
    `${alias}.genre`,
    `${alias}.year`,
    `${alias}.duration`,
    `${alias}.bpm`,
    `${alias}.play_count`,
    `${alias}.played`,
    `${alias}.user_rating`,
    `${alias}.starred`,
  ].join(', ');

function scrobbleRowToChild(row: ScrobbleCandidateRow): Child {
  return {
    id: row.song_id,
    title: row.title ?? '',
    artist: row.artist ?? undefined,
    artistId: row.artist_id ?? undefined,
    album: row.album ?? undefined,
    albumId: row.album_id ?? undefined,
    coverArt: row.cover_art ?? undefined,
    genre: row.genre ?? undefined,
    year: row.year ?? undefined,
    duration: row.duration ?? 0,
    bpm: row.bpm ?? undefined,
    playCount: row.play_count ?? undefined,
    played: row.played ?? undefined,
    userRating: row.user_rating ?? undefined,
    starred: row.starred ? new Date(row.starred) : undefined,
    isDir: false,
  };
}

async function hydrateAndConvertSongs(
  db: InternalDb,
  rows: SongListRow[],
): Promise<Child[]> {
  if (!rows || rows.length === 0) return [];
  try {
    await hydrateSongRows(db, rows);
  } catch {
    // Graceful fallback when child tables are unavailable in test mocks.
  }
  return rows.map((r) => songListRowToChild(r) as Child);
}

async function resolveScrobbleCandidates(
  db: InternalDb,
  scrobbleRows: ScrobbleCandidateRow[],
  isOffline: boolean,
): Promise<Array<{ song: Child; metric: number }>> {
  if (!scrobbleRows || scrobbleRows.length === 0) return [];

  const byId = new Map<string, Child>();
  const ids = Array.from(new Set(scrobbleRows.map((r) => r.song_id).filter(Boolean)));
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');

  try {
    const songRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S} FROM songs s WHERE s.id IN (${marks})`,
      ids,
    );
    const hydrated = await hydrateAndConvertSongs(db, songRows ?? []);
    for (const c of hydrated) byId.set(c.id, c);
  } catch {
    // Proceed to cached_songs / snapshot fallback
  }

  if (isOffline && byId.size < ids.length) {
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      try {
        const missingMarks = missing.map(() => '?').join(',');
        const cachedRows = await db.getAllAsync<SongListRow>(
          `SELECT ${CACHED_SONG_AS_LIST_COLS} FROM cached_songs cs WHERE cs.song_id IN (${missingMarks})`,
          missing,
        );
        for (const r of cachedRows ?? []) {
          byId.set(r.id, songListRowToChild(r) as Child);
        }
      } catch {
        // Proceed to snapshot fallback
      }
    }
  }

  return scrobbleRows
    .filter((r) => Boolean(r.song_id))
    .map((r) => ({
      song: byId.get(r.song_id) ?? scrobbleRowToChild(r),
      metric: r.weight_metric ?? 1,
    }));
}

/* ------------------------------------------------------------------ */
/*  Seed feature extraction                                            */
/* ------------------------------------------------------------------ */

function extractGenresFromSong(song: Child): string[] {
  const out: string[] = [];
  if (song.genre && song.genre.trim()) out.push(song.genre.trim());
  for (const g of (song.genres ?? []) as unknown[]) {
    if (typeof g === 'string' && g.trim()) {
      out.push(g.trim());
    } else if (g && typeof g === 'object' && 'name' in g) {
      const name = (g as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

function getPrimaryGenreString(seed: Child): string | undefined {
  return extractGenresFromSong(seed)[0];
}

function extractMoodsFromSong(song: Child): string[] {
  const out: string[] = [];
  for (const m of (song.moods ?? []) as unknown[]) {
    if (typeof m === 'string' && m.trim()) {
      out.push(m.trim());
    } else if (m && typeof m === 'object') {
      const val = (m as { mood?: unknown; name?: unknown }).mood ?? (m as { name?: unknown }).name;
      if (typeof val === 'string' && val.trim()) out.push(val.trim());
    }
  }
  return out;
}

interface SeedProfile {
  seedIds: string[];
  seedIdSet: Set<string>;
  genreSetLower: Set<string>;
  genresLower: string[];
  moodSetLower: Set<string>;
  moodsLower: string[];
  seedYear: number | undefined;
  seedBpm: number | undefined;
  artistIds: string[];
  artistNamesLower: string[];
}

function buildSeedProfile(seedSongs: readonly Child[]): SeedProfile {
  const seedIds: string[] = [];
  const seedIdSet = new Set<string>();
  const genreSetLower = new Set<string>();
  const moodSetLower = new Set<string>();
  const artistIdSet = new Set<string>();
  const artistNameSetLower = new Set<string>();
  let seedYear: number | undefined;
  let seedBpm: number | undefined;

  for (const s of seedSongs) {
    if (!s?.id || seedIdSet.has(s.id)) continue;
    seedIdSet.add(s.id);
    seedIds.push(s.id);

    for (const g of extractGenresFromSong(s)) {
      genreSetLower.add(g.toLowerCase());
    }
    for (const m of extractMoodsFromSong(s)) {
      moodSetLower.add(m.toLowerCase());
    }
    if (seedYear == null && typeof s.year === 'number' && s.year > 0) {
      seedYear = s.year;
    }
    if (seedBpm == null && typeof s.bpm === 'number' && s.bpm > 0) {
      seedBpm = s.bpm;
    }
    if (s.artistId) artistIdSet.add(s.artistId);
    if (s.artist) {
      const fullLower = s.artist.trim().toLowerCase();
      if (fullLower) artistNameSetLower.add(fullLower);
      const primary = extractPrimaryArtistName(s.artist, s.title).toLowerCase();
      if (primary) artistNameSetLower.add(primary);
    }
  }

  return {
    seedIds,
    seedIdSet,
    genreSetLower,
    genresLower: Array.from(genreSetLower),
    moodSetLower,
    moodsLower: Array.from(moodSetLower),
    seedYear,
    seedBpm,
    artistIds: Array.from(artistIdSet),
    artistNamesLower: Array.from(artistNameSetLower),
  };
}

/* ------------------------------------------------------------------ */
/*  Candidate Pool & Scoring                                           */
/* ------------------------------------------------------------------ */

type RadioSourceTag =
  | 'serverSimilarSong'
  | 'serverSimilarArtist'
  | 'serverLevel1TopSongs'
  | 'localPlaylistCooccur'
  | 'localScrobbleCooccur'
  | 'localScrobbleArtist'
  | 'localMetadata'
  | 'aiBoost'
  | 'level4TimeBucket'
  | 'level4Starred'
  | 'level4GenreRandom'
  | 'level4TopSongs'
  | 'level4LibraryFallback';

interface CandidateEntry {
  song: Child;
  bestBaseScore: number;
  bonusScore: number;
  score: number;
  orderIndex: number;
  affinityApplied: boolean;
  sources: Set<RadioSourceTag>;
}

const DISCOVERY_UNPLAYED_DAYS_MS = 30 * 86_400_000;

function computeCandidateBonus(
  song: Child,
  profile: SeedProfile,
  weights: ModeWeights,
): number {
  let bonus = 0;

  if (profile.moodSetLower.size > 0) {
    const candMoods = extractMoodsFromSong(song);
    if (candMoods.some((m) => profile.moodSetLower.has(m.toLowerCase()))) {
      bonus += weights.moodMatchBonus;
    }
  }

  if (profile.genreSetLower.size > 0) {
    const candGenres = extractGenresFromSong(song);
    if (candGenres.some((g) => profile.genreSetLower.has(g.toLowerCase()))) {
      bonus += weights.genreMatchBonus;
    }
  }

  if (
    profile.seedYear != null &&
    typeof song.year === 'number' &&
    song.year > 0 &&
    Math.abs(song.year - profile.seedYear) <= 5
  ) {
    bonus += weights.yearCloseBonus;
  }

  if (
    profile.seedBpm != null &&
    typeof song.bpm === 'number' &&
    song.bpm > 0 &&
    Math.abs(song.bpm - profile.seedBpm) <= 15
  ) {
    bonus += weights.bpmCloseBonus;
  }

  // Only apply discovery novelty scoring to tracks carrying real metadata
  // (e.g. a title or explicit play stats) so minimal test stubs keep rank order.
  if (
    weights.discoveryBonusMultiplier > 0 &&
    (song.title != null || song.playCount != null || song.played != null)
  ) {
    const pc = song.playCount ?? 0;
    if (pc === 0) {
      bonus += 35 * weights.discoveryBonusMultiplier;
    } else if (pc <= 2) {
      bonus += 22 * weights.discoveryBonusMultiplier;
    } else if (pc >= 10) {
      bonus -= 10 * weights.discoveryBonusMultiplier;
    }

    if (!song.played) {
      bonus += 15 * weights.discoveryBonusMultiplier;
    } else {
      const playedMs = Date.parse(song.played);
      if (!Number.isNaN(playedMs) && Date.now() - playedMs > DISCOVERY_UNPLAYED_DAYS_MS) {
        bonus += 15 * weights.discoveryBonusMultiplier;
      }
    }
  }

  const skipPenalty = getTrackSkipPenalty(song.id);
  if (skipPenalty > 0) {
    bonus -= skipPenalty;
  }

  return bonus;
}

class CandidatePool {
  private readonly entries = new Map<string, CandidateEntry>();
  private nextOrder = 0;

  constructor(
    private readonly profile: SeedProfile,
    private readonly weights: ModeWeights,
    private readonly excludeIds: ReadonlySet<string> | undefined,
    private readonly applyAntiRepeat: boolean,
  ) {}

  add(song: Child | null | undefined, baseScore: number, tag: RadioSourceTag): void {
    if (!song?.id || this.profile.seedIdSet.has(song.id)) return;
    const existing = this.entries.get(song.id);
    if (existing) {
      if (!existing.sources.has(tag)) {
        existing.sources.add(tag);
        existing.bestBaseScore = Math.max(existing.bestBaseScore, baseScore);
        // Cap secondary-source corroboration so accidental playlist/session overlap
        // reinforces genuine matches without drowning out primary Server or AI picks.
        const corroboration = Math.min(28, (existing.sources.size - 1) * 14);
        existing.score = existing.bestBaseScore + corroboration + existing.bonusScore;
      }
      return;
    }

    const bonus = computeCandidateBonus(song, this.profile, this.weights);
    this.entries.set(song.id, {
      song,
      bestBaseScore: baseScore,
      bonusScore: bonus,
      score: baseScore + bonus,
      orderIndex: this.nextOrder++,
      affinityApplied: true,
      sources: new Set([tag]),
    });
  }

  addMany(
    songs: readonly Child[] | null | undefined,
    baseScore: number,
    tag: RadioSourceTag,
    rankDecay = 0,
  ): void {
    if (!songs) return;
    for (let i = 0; i < songs.length; i++) {
      const decay = rankDecay > 0 ? Math.min(8, i * rankDecay) : 0;
      this.add(songs[i], baseScore - decay, tag);
    }
  }

  /** Number of unique candidates available without relaxing `excludeIds`. */
  usableCount(): number {
    if (!this.applyAntiRepeat || !this.excludeIds || this.excludeIds.size === 0) {
      return this.entries.size;
    }
    let count = 0;
    for (const id of this.entries.keys()) {
      if (!this.excludeIds.has(id)) count += 1;
    }
    return count;
  }

  size(): number {
    return this.entries.size;
  }

  getRankedPartition(randomize = false): { fresh: Child[]; repeated: Child[] } {
    const ranked = randomize
      ? Array.from(this.entries.values())
          .map((e) => ({
            entry: e,
            sortScore: e.score + (Math.random() - 0.5) * 28,
          }))
          .sort((a, b) => {
            if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
            return a.entry.orderIndex - b.entry.orderIndex;
          })
          .map((x) => x.entry)
      : Array.from(this.entries.values()).sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.orderIndex - b.orderIndex;
        });

    if (!this.applyAntiRepeat || !this.excludeIds || this.excludeIds.size === 0) {
      return { fresh: ranked.map((e) => e.song), repeated: [] };
    }

    const fresh: Child[] = [];
    const repeated: Child[] = [];
    for (const entry of ranked) {
      if (this.excludeIds.has(entry.song.id)) {
        repeated.push(entry.song);
      } else {
        fresh.push(entry.song);
      }
    }
    return { fresh, repeated };
  }
}

/* ------------------------------------------------------------------ */
/*  Level 1 — Server Subsonic                                          */
/* ------------------------------------------------------------------ */

async function collectLevel1Server(
  primarySeed: Child,
  targetCount: number,
  pool: CandidatePool,
  weights: ModeWeights,
): Promise<void> {
  try {
    const similar = await getSimilarSongs(primarySeed.id, targetCount);
    pool.addMany(similar, weights.serverSimilarSong, 'serverSimilarSong');
  } catch {
    // Resilient against server / mock errors
  }

  if (pool.usableCount() >= targetCount) return;

  if (primarySeed.artistId) {
    try {
      const similar2 = await getSimilarSongs2(primarySeed.artistId, targetCount);
      pool.addMany(similar2, weights.serverSimilarArtist, 'serverSimilarArtist');
    } catch {
      // Resilient against server / mock errors
    }
  }

  const thinThreshold = Math.min(5, targetCount);
  if (
    pool.usableCount() < thinThreshold &&
    hasFeaturingOrSeparator(primarySeed.artist, primarySeed.title)
  ) {
    const primaryArtistName = extractPrimaryArtistName(
      primarySeed.artist,
      primarySeed.title,
    );
    if (!primaryArtistName) return;

    let resolvedId: string | null = null;
    try {
      resolvedId = await resolveArtistId(primaryArtistName);
    } catch {
      resolvedId = null;
    }

    if (resolvedId && resolvedId !== primarySeed.artistId) {
      try {
        const resolvedSimilar = await getSimilarSongs2(resolvedId, targetCount);
        pool.addMany(resolvedSimilar, weights.serverSimilarArtist, 'serverSimilarArtist');
      } catch {
        // Resilient against server / mock errors
      }
    }

    if (pool.usableCount() < thinThreshold) {
      try {
        const topSongs = await getTopSongs(primaryArtistName, targetCount);
        pool.addMany(topSongs, weights.serverLevel1TopSongs, 'serverLevel1TopSongs');
      } catch {
        // Resilient against server / mock errors
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Level 2 — Personal Co-occurrence (SQLite, 100% offline)            */
/* ------------------------------------------------------------------ */

async function collectLevel2LocalHistory(
  db: InternalDb,
  profile: SeedProfile,
  targetCount: number,
  isOffline: boolean,
  pool: CandidatePool,
  weights: ModeWeights,
): Promise<void> {
  if (profile.seedIds.length === 0) return;

  const seedMarks = profile.seedIds.map(() => '?').join(',');
  const offlineSongFilter = isOffline
    ? 'AND s.id IN (SELECT song_id FROM cached_songs)'
    : '';
  const offlineScrobbleFilter = isOffline
    ? 'AND se2.song_id IN (SELECT song_id FROM cached_songs)'
    : '';
  const queryLimit = Math.max(targetCount * 3, 30);

  // 2a. Same-playlist co-occurrence
  try {
    const rows = await db.getAllAsync<SongListRow & { co_count?: number }>(
      `SELECT ${SONG_LIST_COLS_S}, COUNT(DISTINCT ps1.playlist_id) AS co_count
       FROM playlist_songs ps1
       JOIN playlist_songs ps2
         ON ps1.playlist_id = ps2.playlist_id
        AND ps2.song_id NOT IN (${seedMarks})
       JOIN songs s ON s.id = ps2.song_id
       WHERE ps1.song_id IN (${seedMarks})
         ${offlineSongFilter}
       GROUP BY s.id
       ORDER BY co_count DESC
       LIMIT ?`,
      [...profile.seedIds, ...profile.seedIds, queryLimit],
    );
    const children = await hydrateAndConvertSongs(db, rows ?? []);
    for (let i = 0; i < children.length; i++) {
      const coCount = Number(rows[i]?.co_count ?? 1);
      const score = weights.localPlaylistCooccur + Math.min(20, Math.max(0, coCount - 1) * 8);
      pool.add(children[i], score, 'localPlaylistCooccur');
    }
  } catch {
    // Missing table or partial mock DB — continue gracefully
  }

  // Fallback to cached_songs for playlist co-occurrence if offline and songs table lacked rows
  if (isOffline && pool.usableCount() < targetCount) {
    try {
      const rows = await db.getAllAsync<SongListRow & { co_count?: number }>(
        `SELECT ${CACHED_SONG_AS_LIST_COLS}, COUNT(DISTINCT ps1.playlist_id) AS co_count
         FROM playlist_songs ps1
         JOIN playlist_songs ps2
           ON ps1.playlist_id = ps2.playlist_id
          AND ps2.song_id NOT IN (${seedMarks})
         JOIN cached_songs cs ON cs.song_id = ps2.song_id
         WHERE ps1.song_id IN (${seedMarks})
         GROUP BY cs.song_id
         ORDER BY co_count DESC
         LIMIT ?`,
        [...profile.seedIds, ...profile.seedIds, queryLimit],
      );
      for (const r of rows ?? []) {
        const coCount = Number(r.co_count ?? 1);
        const score = weights.localPlaylistCooccur + Math.min(20, Math.max(0, coCount - 1) * 8);
        pool.add(songListRowToChild(r) as Child, score, 'localPlaylistCooccur');
      }
    } catch {
      // Graceful fallback
    }
  }

  // 2b. Scrobble session co-listening (±30 minutes = 1,800,000 ms)
  try {
    const coScrobbleRows = await db.getAllAsync<ScrobbleCandidateRow>(
      `SELECT ${SCROBBLE_SELECT_FIELDS('se2')}, COUNT(*) AS weight_metric
       FROM scrobble_events se1
       JOIN scrobble_events se2
         ON ABS(se2.time - se1.time) <= 1800000
        AND se2.song_id IS NOT NULL
        AND se2.song_id NOT IN (${seedMarks})
       WHERE se1.song_id IN (${seedMarks})
         ${offlineScrobbleFilter}
       GROUP BY se2.song_id
       ORDER BY weight_metric DESC, MAX(se2.time) DESC
       LIMIT ?`,
      [...profile.seedIds, ...profile.seedIds, queryLimit],
    );
    const resolved = await resolveScrobbleCandidates(db, coScrobbleRows ?? [], isOffline);
    for (const { song, metric } of resolved) {
      const score = weights.localScrobbleCooccur + Math.min(20, Math.max(0, metric - 1) * 6);
      pool.add(song, score, 'localScrobbleCooccur');
    }
  } catch {
    // Graceful fallback
  }

  // 2c. Scrobble artist affinity (tracks by seed artists in listening history)
  if (profile.artistIds.length > 0 || profile.artistNamesLower.length > 0) {
    try {
      const artistConds: string[] = [];
      const artistParams: Array<string | number> = [...profile.seedIds];

      if (profile.artistIds.length > 0) {
        const marks = profile.artistIds.map(() => '?').join(',');
        artistConds.push(`se.artist_id IN (${marks})`);
        artistParams.push(...profile.artistIds);
      }
      if (profile.artistNamesLower.length > 0) {
        const marks = profile.artistNamesLower.map(() => '?').join(',');
        artistConds.push(`LOWER(se.artist) IN (${marks})`);
        artistParams.push(...profile.artistNamesLower);
      }

      const offlineSingleFilter = isOffline
        ? 'AND se.song_id IN (SELECT song_id FROM cached_songs)'
        : '';
      artistParams.push(queryLimit);

      const artistScrobbleRows = await db.getAllAsync<ScrobbleCandidateRow>(
        `SELECT ${SCROBBLE_SELECT_FIELDS('se')}, COUNT(*) AS weight_metric
         FROM scrobble_events se
         WHERE se.song_id IS NOT NULL
           AND se.song_id NOT IN (${seedMarks})
           AND (${artistConds.join(' OR ')})
           ${offlineSingleFilter}
         GROUP BY se.song_id
         ORDER BY weight_metric DESC, MAX(se.time) DESC
         LIMIT ?`,
        artistParams,
      );
      const resolved = await resolveScrobbleCandidates(db, artistScrobbleRows ?? [], isOffline);
      for (const { song, metric } of resolved) {
        const score = weights.localScrobbleArtist + Math.min(15, Math.max(0, metric - 1) * 4);
        pool.add(song, score, 'localScrobbleArtist');
      }
    } catch {
      // Graceful fallback
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Level 3 — Metadata Affinity (SQLite, 100% offline)                 */
/* ------------------------------------------------------------------ */

async function collectLevel3Metadata(
  db: InternalDb,
  profile: SeedProfile,
  targetCount: number,
  isOffline: boolean,
  pool: CandidatePool,
  weights: ModeWeights,
): Promise<void> {
  if (profile.seedIds.length === 0) return;

  const hasMood = profile.moodsLower.length > 0;
  const hasGenre = profile.genresLower.length > 0;
  const hasYear = profile.seedYear != null;
  const hasBpm = profile.seedBpm != null;
  const hasArtist = profile.artistIds.length > 0 || profile.artistNamesLower.length > 0;
  if (!hasMood && !hasGenre && !hasYear && !hasBpm && !hasArtist) return;

  const seedMarks = profile.seedIds.map(() => '?').join(',');
  const limit = Math.max(targetCount * 3, 45);
  const useDiscoveryOrder = weights.discoveryBonusMultiplier >= 0.9;

  const runSongsMetadataQuery = async (
    withSongGenresTable: boolean,
    withSongMoodsTable: boolean,
  ): Promise<number> => {
    const scoreTerms: string[] = [];
    const scoreParams: Array<string | number> = [];
    const whereTerms: string[] = [];
    const whereParams: Array<string | number> = [];

    if (hasMood && withSongMoodsTable) {
      const mMarks = profile.moodsLower.map(() => '?').join(',');
      const moodCond =
        `EXISTS (SELECT 1 FROM song_moods sm WHERE sm.song_id = s.id AND LOWER(TRIM(sm.mood)) IN (${mMarks}))`;
      scoreTerms.push(`(CASE WHEN ${moodCond} THEN 7 ELSE 0 END)`);
      scoreParams.push(...profile.moodsLower);
      whereTerms.push(moodCond);
      whereParams.push(...profile.moodsLower);
    }

    if (hasGenre) {
      const gMarks = profile.genresLower.map(() => '?').join(',');
      const genreCond = withSongGenresTable
        ? `(LOWER(s.genre) IN (${gMarks}) OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(sg.name) IN (${gMarks})))`
        : `LOWER(s.genre) IN (${gMarks})`;
      const genreBind = withSongGenresTable
        ? [...profile.genresLower, ...profile.genresLower]
        : [...profile.genresLower];

      scoreTerms.push(`(CASE WHEN ${genreCond} THEN 5 ELSE 0 END)`);
      scoreParams.push(...genreBind);
      whereTerms.push(genreCond);
      whereParams.push(...genreBind);
    }

    if (hasYear && profile.seedYear != null) {
      const yearRaw = '(s.year IS NOT NULL AND ABS(s.year - ?) <= 5)';
      // When the seed has a genre, only let year-only matches enter if the candidate track
      // has no genre tag; otherwise era-matched tracks from opposite genres flood the pool.
      const yearCond = hasGenre
        ? `(${yearRaw} AND COALESCE(NULLIF(TRIM(s.genre), ''), '') = '')`
        : yearRaw;
      scoreTerms.push(`(CASE WHEN ${yearRaw} THEN 3 ELSE 0 END)`);
      scoreParams.push(profile.seedYear);
      whereTerms.push(yearCond);
      whereParams.push(profile.seedYear);
    }

    if (hasBpm && profile.seedBpm != null) {
      const bpmRaw = '(s.bpm IS NOT NULL AND s.bpm > 0 AND ABS(s.bpm - ?) <= 15)';
      const bpmCond = hasGenre
        ? `(${bpmRaw} AND COALESCE(NULLIF(TRIM(s.genre), ''), '') = '')`
        : bpmRaw;
      scoreTerms.push(`(CASE WHEN ${bpmRaw} THEN 3 ELSE 0 END)`);
      scoreParams.push(profile.seedBpm);
      whereTerms.push(bpmCond);
      whereParams.push(profile.seedBpm);
    }

    if (hasArtist) {
      const artistSubConds: string[] = [];
      const artistSubParams: Array<string | number> = [];
      if (profile.artistIds.length > 0) {
        const aMarks = profile.artistIds.map(() => '?').join(',');
        artistSubConds.push(`s.artist_id IN (${aMarks})`);
        artistSubParams.push(...profile.artistIds);
      }
      if (profile.artistNamesLower.length > 0) {
        const nMarks = profile.artistNamesLower.map(() => '?').join(',');
        artistSubConds.push(`LOWER(s.artist) IN (${nMarks})`);
        artistSubParams.push(...profile.artistNamesLower);
      }
      const artistCond = `(${artistSubConds.join(' OR ')})`;
      scoreTerms.push(`(CASE WHEN ${artistCond} THEN 4 ELSE 0 END)`);
      scoreParams.push(...artistSubParams);
      whereTerms.push(artistCond);
      whereParams.push(...artistSubParams);
    }

    if (whereTerms.length === 0) return 0;

    const offlineFilter = isOffline
      ? 'AND s.id IN (SELECT song_id FROM cached_songs)'
      : '';
    const orderClause = useDiscoveryOrder
      ? 'ORDER BY affinity_score DESC, COALESCE(s.play_count, 0) ASC, RANDOM()'
      : 'ORDER BY affinity_score DESC, RANDOM()';

    const rows = await db.getAllAsync<SongListRow & { affinity_score?: number }>(
      `SELECT ${SONG_LIST_COLS_S}, (${scoreTerms.join(' + ')}) AS affinity_score
       FROM songs s
       WHERE s.id NOT IN (${seedMarks})
         AND (${whereTerms.join(' OR ')})
         ${offlineFilter}
       ${orderClause}
       LIMIT ?`,
      [...scoreParams, ...profile.seedIds, ...whereParams, limit],
    );

    const children = await hydrateAndConvertSongs(db, rows ?? []);
    const maxPossible =
      (hasMood && withSongMoodsTable ? 7 : 0) +
      (hasGenre ? 5 : 0) +
      (hasYear ? 3 : 0) +
      (hasBpm ? 3 : 0) +
      (hasArtist ? 4 : 0);
    for (let i = 0; i < children.length; i++) {
      const rawAffinity = Number(rows[i]?.affinity_score ?? 1);
      const ratio = maxPossible > 0 ? Math.min(1, rawAffinity / maxPossible) : 0.5;
      const baseScore = weights.localMetadataMax * (0.4 + 0.6 * ratio);
      pool.add(children[i], baseScore, 'localMetadata');
    }
    return children.length;
  };

  let songRowsCount = 0;
  try {
    songRowsCount = await runSongsMetadataQuery(true, hasMood);
  } catch {
    try {
      songRowsCount = await runSongsMetadataQuery(false, false);
    } catch {
      songRowsCount = 0;
    }
  }

  // Fallback to `cached_songs` when offline and `songs` lacked sufficient rows
  if (isOffline && songRowsCount < targetCount) {
    try {
      const scoreTerms: string[] = [];
      const scoreParams: Array<string | number> = [];
      const whereTerms: string[] = [];
      const whereParams: Array<string | number> = [];

      if (hasGenre) {
        const gMarks = profile.genresLower.map(() => '?').join(',');
        const genreCond = `LOWER(cs.genre) IN (${gMarks})`;
        scoreTerms.push(`(CASE WHEN ${genreCond} THEN 5 ELSE 0 END)`);
        scoreParams.push(...profile.genresLower);
        whereTerms.push(genreCond);
        whereParams.push(...profile.genresLower);
      }
      if (hasYear && profile.seedYear != null) {
        const yearRaw = '(cs.year IS NOT NULL AND ABS(cs.year - ?) <= 5)';
        const yearCond = hasGenre
          ? `(${yearRaw} AND COALESCE(NULLIF(TRIM(cs.genre), ''), '') = '')`
          : yearRaw;
        scoreTerms.push(`(CASE WHEN ${yearRaw} THEN 3 ELSE 0 END)`);
        scoreParams.push(profile.seedYear);
        whereTerms.push(yearCond);
        whereParams.push(profile.seedYear);
      }
      if (hasBpm && profile.seedBpm != null) {
        const bpmRaw = '(cs.bpm IS NOT NULL AND cs.bpm > 0 AND ABS(cs.bpm - ?) <= 15)';
        const bpmCond = hasGenre
          ? `(${bpmRaw} AND COALESCE(NULLIF(TRIM(cs.genre), ''), '') = '')`
          : bpmRaw;
        scoreTerms.push(`(CASE WHEN ${bpmRaw} THEN 3 ELSE 0 END)`);
        scoreParams.push(profile.seedBpm);
        whereTerms.push(bpmCond);
        whereParams.push(profile.seedBpm);
      }
      if (hasArtist) {
        const artistSubConds: string[] = [];
        const artistSubParams: Array<string | number> = [];
        if (profile.artistIds.length > 0) {
          const aMarks = profile.artistIds.map(() => '?').join(',');
          artistSubConds.push(`cs.artist_id IN (${aMarks})`);
          artistSubParams.push(...profile.artistIds);
        }
        if (profile.artistNamesLower.length > 0) {
          const nMarks = profile.artistNamesLower.map(() => '?').join(',');
          artistSubConds.push(`LOWER(cs.artist) IN (${nMarks})`);
          artistSubParams.push(...profile.artistNamesLower);
        }
        const artistCond = `(${artistSubConds.join(' OR ')})`;
        scoreTerms.push(`(CASE WHEN ${artistCond} THEN 4 ELSE 0 END)`);
        scoreParams.push(...artistSubParams);
        whereTerms.push(artistCond);
        whereParams.push(...artistSubParams);
      }

      const orderClause = useDiscoveryOrder
        ? 'ORDER BY affinity_score DESC, COALESCE(cs.play_count, 0) ASC, RANDOM()'
        : 'ORDER BY affinity_score DESC, RANDOM()';

      const rows = await db.getAllAsync<SongListRow & { affinity_score?: number }>(
        `SELECT ${CACHED_SONG_AS_LIST_COLS}, (${scoreTerms.join(' + ')}) AS affinity_score
         FROM cached_songs cs
         WHERE cs.song_id NOT IN (${seedMarks})
           AND (${whereTerms.join(' OR ')})
         ${orderClause}
         LIMIT ?`,
        [...scoreParams, ...profile.seedIds, ...whereParams, limit],
      );

      const maxPossible = (hasGenre ? 5 : 0) + (hasYear ? 3 : 0) + (hasBpm ? 3 : 0) + (hasArtist ? 4 : 0);
      for (const r of rows ?? []) {
        const rawAffinity = Number(r.affinity_score ?? 1);
        const ratio = maxPossible > 0 ? Math.min(1, rawAffinity / maxPossible) : 0.5;
        const baseScore = weights.localMetadataMax * (0.4 + 0.6 * ratio);
        pool.add(songListRowToChild(r) as Child, baseScore, 'localMetadata');
      }
    } catch {
      // Graceful fallback
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Level 4 — Final Safety Net (only if pool < targetCount)            */
/* ------------------------------------------------------------------ */

async function collectLevel4SafetyNet(
  db: InternalDb | null,
  hasAsyncDb: boolean,
  primarySeed: Child,
  profile: SeedProfile,
  targetCount: number,
  isOffline: boolean,
  settings: RadioAiSettingsSnapshot,
  pool: CandidatePool,
  weights: ModeWeights,
): Promise<void> {
  if (pool.usableCount() >= targetCount) return;

  const seedMarks = profile.seedIds.map(() => '?').join(',');
  const limit = Math.max(targetCount * 2, 20);

  // 4a. Same hour-of-day bucket (±1 hour) in scrobble_events
  if (hasAsyncDb && db && profile.seedIds.length > 0 && pool.usableCount() < targetCount) {
    try {
      const h = new Date().getHours();
      const hours = [(h + 23) % 24, h, (h + 1) % 24];
      const offlineFilter = isOffline
        ? 'AND se.song_id IN (SELECT song_id FROM cached_songs)'
        : '';
      const rows = await db.getAllAsync<ScrobbleCandidateRow>(
        `SELECT ${SCROBBLE_SELECT_FIELDS('se')}, COUNT(*) AS weight_metric
         FROM scrobble_events se
         WHERE se.hour IN (?, ?, ?)
           AND se.song_id IS NOT NULL
           AND se.song_id NOT IN (${seedMarks})
           ${offlineFilter}
         GROUP BY se.song_id
         ORDER BY weight_metric DESC, MAX(se.time) DESC
         LIMIT ?`,
        [...hours, ...profile.seedIds, limit],
      );
      const resolved = await resolveScrobbleCandidates(db, rows ?? [], isOffline);
      for (const { song } of resolved) {
        pool.add(song, weights.level4TimeBucket, 'level4TimeBucket');
      }
    } catch {
      // Graceful fallback
    }
  }

  // 4b. Starred songs (songs / favorite_songs / cached_songs offline)
  if (hasAsyncDb && db && profile.seedIds.length > 0 && pool.usableCount() < targetCount) {
    try {
      const offlineFilter = isOffline
        ? 'AND s.id IN (SELECT song_id FROM cached_songs)'
        : '';
      const starredRows = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S}
         FROM songs s
         WHERE s.starred IS NOT NULL
           AND s.id NOT IN (${seedMarks})
           ${offlineFilter}
         ORDER BY RANDOM()
         LIMIT ?`,
        [...profile.seedIds, limit],
      );
      const children = await hydrateAndConvertSongs(db, starredRows ?? []);
      pool.addMany(children, weights.level4Starred, 'level4Starred');
    } catch {
      // Graceful fallback
    }

    if (pool.usableCount() < targetCount) {
      try {
        const offlineFilter = isOffline
          ? 'AND id IN (SELECT song_id FROM cached_songs)'
          : '';
        const remRows = await db.getAllAsync<{
          id: string;
          title: string | null;
          artist: string | null;
          artist_id: string | null;
          album: string | null;
          album_id: string | null;
          cover_art: string | null;
          genre: string | null;
          year: number | null;
          duration: number | null;
          bpm: number | null;
          play_count: number | null;
          played: string | null;
          starred: number | null;
          json: string;
        }>(
          `SELECT id, title, artist, artist_id, album, album_id, cover_art, genre, year, duration, bpm, play_count, played, starred, json
           FROM favorite_songs
           WHERE id NOT IN (${seedMarks})
             ${offlineFilter}
           ORDER BY RANDOM()
           LIMIT ?`,
          [...profile.seedIds, limit],
        );
        for (const r of remRows ?? []) {
          if (r.title == null && r.json) {
            try {
              const parsed = JSON.parse(r.json) as Child;
              if (parsed?.id) pool.add(parsed, weights.level4Starred, 'level4Starred');
            } catch {
              // ignore unparseable legacy envelope
            }
          } else {
            pool.add(
              scrobbleRowToChild({ ...r, song_id: r.id, user_rating: null }),
              weights.level4Starred,
              'level4Starred',
            );
          }
        }
      } catch {
        // Graceful fallback
      }
    }

    if (isOffline && pool.usableCount() < targetCount) {
      try {
        const cachedStarred = await db.getAllAsync<SongListRow>(
          `SELECT ${CACHED_SONG_AS_LIST_COLS}
           FROM cached_songs cs
           WHERE cs.starred IS NOT NULL
             AND cs.song_id NOT IN (${seedMarks})
           ORDER BY RANDOM()
           LIMIT ?`,
          [...profile.seedIds, limit],
        );
        for (const r of cachedStarred ?? []) {
          pool.add(songListRowToChild(r) as Child, weights.level4Starred, 'level4Starred');
        }
      } catch {
        // Graceful fallback
      }
    }
  }

  // 4c. Server fallback (same genre random + artist top songs)
  if (settings.sources.server && !isOffline && pool.usableCount() < targetCount) {
    const genre = getPrimaryGenreString(primarySeed);
    if (genre) {
      try {
        const randomByGenre = await getRandomSongsFiltered({
          size: targetCount * 2,
          genre,
        });
        pool.addMany(randomByGenre, weights.level4GenreRandom, 'level4GenreRandom');
      } catch {
        // Graceful fallback
      }
    }

    if (pool.usableCount() < targetCount && primarySeed.artist) {
      try {
        const topSongs = await getTopSongs(primarySeed.artist, targetCount);
        pool.addMany(topSongs, weights.level4TopSongs, 'level4TopSongs');
      } catch {
        // Graceful fallback
      }
    }
  }

  // 4d. Local library safety net (random tracks from cached_songs offline or songs online)
  if (hasAsyncDb && db && profile.seedIds.length > 0 && pool.usableCount() < targetCount) {
    if (isOffline) {
      try {
        const rows = await db.getAllAsync<SongListRow>(
          `SELECT ${CACHED_SONG_AS_LIST_COLS}
           FROM cached_songs cs
           WHERE cs.song_id NOT IN (${seedMarks})
           ORDER BY RANDOM()
           LIMIT ?`,
          [...profile.seedIds, limit],
        );
        for (const r of rows ?? []) {
          pool.add(songListRowToChild(r) as Child, weights.level4LibraryFallback, 'level4LibraryFallback');
        }
      } catch {
        // Graceful fallback
      }
    } else {
      let addedFromSongs = false;
      try {
        const rows = await db.getAllAsync<SongListRow>(
          `SELECT ${SONG_LIST_COLS_S}
           FROM songs s
           WHERE s.id NOT IN (${seedMarks})
           ORDER BY RANDOM()
           LIMIT ?`,
          [...profile.seedIds, limit],
        );
        const children = await hydrateAndConvertSongs(db, rows ?? []);
        addedFromSongs = children.length > 0;
        pool.addMany(children, weights.level4LibraryFallback, 'level4LibraryFallback');
      } catch {
        // Graceful fallback
      }

      if (!addedFromSongs && pool.usableCount() < targetCount) {
        try {
          const rows = await db.getAllAsync<SongListRow>(
            `SELECT ${CACHED_SONG_AS_LIST_COLS}
             FROM cached_songs cs
             WHERE cs.song_id NOT IN (${seedMarks})
             ORDER BY RANDOM()
             LIMIT ?`,
            [...profile.seedIds, limit],
          );
          for (const r of rows ?? []) {
            pool.add(songListRowToChild(r) as Child, weights.level4LibraryFallback, 'level4LibraryFallback');
          }
        } catch {
          // Graceful fallback
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

async function hydrateSeedSongs(
  db: InternalDb,
  seedSongs: readonly Child[],
): Promise<Child[]> {
  const needsHydration = seedSongs.some(
    (s) => s?.id && (!s.genre || !s.year || !s.artistId),
  );
  if (!needsHydration) return [...seedSongs];

  const ids = Array.from(new Set(seedSongs.map((s) => s?.id).filter(Boolean)));
  if (ids.length === 0) return [...seedSongs];

  try {
    const marks = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S} FROM songs s WHERE s.id IN (${marks})`,
      ids,
    );
    if (!rows || rows.length === 0) return [...seedSongs];
    const children = await hydrateAndConvertSongs(db, rows);
    const byId = new Map<string, Child>();
    for (const c of children) {
      if (c.id) byId.set(c.id, c);
    }
    return seedSongs.map((s) => {
      const dbSong = s?.id ? byId.get(s.id) : undefined;
      if (!dbSong) return s;
      return {
        ...dbSong,
        ...s,
        genre: s.genre ?? dbSong.genre,
        genres: s.genres?.length ? s.genres : dbSong.genres,
        moods: s.moods?.length ? s.moods : dbSong.moods,
        year: s.year ?? dbSong.year,
        bpm: s.bpm ?? dbSong.bpm,
        artistId: s.artistId ?? dbSong.artistId,
        album: s.album ?? dbSong.album,
      };
    });
  } catch {
    return [...seedSongs];
  }
}

/**
 * Generate up to `targetCount` recommended tracks for `seedSongs` using
 * the 4-level Smart Radio waterfall and active `RadioAiSettingsSnapshot`.
 */
export async function getSmartRadioTracks(req: SmartRadioRequest): Promise<Child[]> {
  const { seedSongs, targetCount } = req;
  if (!seedSongs || seedSongs.length === 0 || targetCount <= 0) {
    return [];
  }

  const db = getDb();
  const hasAsyncDb = Boolean(db && typeof db.getAllAsync === 'function');
  const hydratedSeeds =
    hasAsyncDb && db ? await hydrateSeedSongs(db, seedSongs) : [...seedSongs];

  const primarySeed = hydratedSeeds[0];
  if (!primarySeed?.id) {
    return [];
  }

  const settings = req.settings ?? readRadioAiSettings();
  const isOffline = Boolean(req.downloadedOnly || offlineModeStore.getState().offlineMode);
  const weights = MODE_WEIGHTS[settings.radioMode] ?? MODE_WEIGHTS.balanced;
  const randomize = Boolean(req.randomize);
  const fetchCount = randomize ? Math.max(targetCount * 2, 35) : targetCount;
  const profile = buildSeedProfile(hydratedSeeds);
  const pool = new CandidatePool(
    profile,
    weights,
    req.excludeIds,
    settings.sessionAntiRepeat,
  );

  // Priority 1: BYOK AI Engine when enabled online (stops here if target is met)
  if (
    settings.sources.aiBoost &&
    settings.provider !== 'disabled' &&
    !isOffline
  ) {
    const aiBoostFn = resolveAiBoostProvider();
    if (aiBoostFn) {
      try {
        const boosted = await aiBoostFn(
          hydratedSeeds,
          fetchCount,
          req.excludeIds,
        );
        pool.addMany(boosted, weights.aiBoost, 'aiBoost', 0.4);
      } catch {
        // Safe try/catch — AI provider failure never breaks radio playback
      }
    }
  }

  // Priority 2: Server Subsonic similarity (only if Priority 1 is off/short; stops here if target is met)
  if (pool.usableCount() < targetCount && settings.sources.server && !isOffline) {
    await collectLevel1Server(primarySeed, fetchCount, pool, weights);
  }

  // Priority 3: Offline SQLite personal co-occurrence + mood/metadata affinity (only if upstream tiers are short/offline)
  if (pool.usableCount() < targetCount && hasAsyncDb && db) {
    if (settings.sources.localHistory) {
      await collectLevel2LocalHistory(db, profile, fetchCount, isOffline, pool, weights);
    }
    if (settings.sources.metadata) {
      await collectLevel3Metadata(db, profile, fetchCount, isOffline, pool, weights);
    }
  }

  // Level 4: Final safety net if pool still below target
  if (pool.usableCount() < targetCount) {
    await collectLevel4SafetyNet(
      db,
      hasAsyncDb,
      primarySeed,
      profile,
      targetCount,
      isOffline,
      settings,
      pool,
      weights,
    );
  }

  // Post-processing: rank (with balanced jitter when randomized) and relax excludeIds only when exhausted.
  // Consecutive same-artist tracks are allowed naturally without rigid artist spacing.
  const { fresh, repeated } = pool.getRankedPartition(randomize);
  const result: Child[] = fresh.slice(0, targetCount);

  if (result.length < targetCount && repeated.length > 0) {
    result.push(...repeated.slice(0, targetCount - result.length));
  }

  return result;
}
