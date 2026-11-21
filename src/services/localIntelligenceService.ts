/**
 * 100% SQLite / offline recommendation intelligence engine.
 *
 * Zero network calls. Every function safely degrades to empty results when the
 * SQLite handle is unavailable (`getDb() === null`) or tables are unpopulated.
 * When `offlineModeStore.getState().offlineMode` is true, song queries restrict
 * to downloaded tracks (`cached_songs`) so recommendations are immediately
 * playable without connectivity.
 */
import type { Child } from 'subsonic-api';

import {
  CHILD_SNAPSHOT_COLUMNS,
  childFromSnapshotRow,
  childSnapshotArrayKey,
  childSnapshotRowFromRaw,
  readChildSnapshotArraysAsync,
  type ChildSnapshotArrays,
} from '../db/childSnapshot';
import type { InternalDb } from '../db/client';
import {
  hydrateSongRows,
  SONG_LIST_COLS,
  SONG_LIST_COLS_S,
  songListRowToChild,
  type SongListRow,
} from '../db/repository/songs';
import i18n from '../i18n/i18n';
import { offlineModeStore } from '../store/offlineModeStore';
import { getDb } from '../store/persistence/db';
import {
  rowToScrobble,
  SCROBBLE_SELECT,
  scrobblesWithArrays,
  type ScrobbleSnapshotRow,
} from '../store/persistence/scrobbleSnapshot';
import { recentPlaysStore } from '../store/recentPlaysStore';
import { defaultCollator } from '../utils/intl';
import { withTimeout } from '../utils/withTimeout';
import {
  findSonicPath,
  getSonicSimilarTracks,
  isSonicSimilarityAvailable,
  type SonicTrackMatch,
} from './subsonicService';

/* ------------------------------------------------------------------ */
/*  Public Types                                                       */
/* ------------------------------------------------------------------ */

export interface JumpBackInItem {
  id: string;
  type: 'playlist' | 'artist' | 'album';
  title: string;
  subtitle?: string;
  coverArt?: string;
  lastPlayedAt: number;
  playCount: number;
}

export interface HourlyDaylist {
  hour: number;
  timeSlotKey: string;
  title: string;
  subtitle: string;
  topGenres: string[];
  songs: Child[];
}

export interface QuickMoodChip {
  id: string;
  label: string;
  kind: 'genre' | 'mood' | 'bpm';
  genre?: string;
  mood?: string;
  minBpm?: number;
  maxBpm?: number;
  songCount: number;
}

export type DynamicMixType = 'daily_mix' | 'daylist' | 'rediscovery_bridge';
export type DynamicMixSource = 'sonic' | 'local';

export interface DynamicMixSummary {
  mixKey: string;
  mixType: DynamicMixType;
  title: string;
  subtitle: string;
  seedIds: string[];
  source: DynamicMixSource;
  songCount: number;
  updatedAt: number | null;
  expiresAt: number | null;
  isCached: boolean;
}

export interface ResolveDynamicMixOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
  targetCount?: number;
  timeoutMs?: number;
}

export interface ResolvedDynamicMix {
  mixKey: string;
  mixType: DynamicMixType;
  title: string;
  subtitle: string;
  seedIds: string[];
  songs: Child[];
  source: DynamicMixSource;
  updatedAt: number;
  expiresAt: number;
  fromCache: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants & Helpers                                                */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const ON_REPEAT_DAYS = 14;
const FORGOTTEN_GEMS_DAYS = 60;
const FORGOTTEN_MIN_PLAYS = 2;
const NO_ARRAYS: ChildSnapshotArrays = {};

interface DaylistTimeSlot {
  key: string;
  fallbackTitle: string;
  range: readonly [number, number];
}

const DAYLIST_TIME_SLOTS: readonly DaylistTimeSlot[] = [
  { key: 'daylistEarlyMorning', fallbackTitle: 'Early Morning Mix', range: [5, 8] },
  { key: 'daylistMorning', fallbackTitle: 'Morning Mix', range: [8, 11] },
  { key: 'daylistMidday', fallbackTitle: 'Midday Mix', range: [11, 14] },
  { key: 'daylistAfternoon', fallbackTitle: 'Afternoon Mix', range: [14, 17] },
  { key: 'daylistEvening', fallbackTitle: 'Evening Mix', range: [17, 20] },
  { key: 'daylistNight', fallbackTitle: 'Night Mix', range: [20, 23] },
  { key: 'daylistLateNight', fallbackTitle: 'Late Night Mix', range: [23, 5] },
];

function isOfflineMode(): boolean {
  return offlineModeStore.getState().offlineMode;
}

function offlineSongFilter(offline: boolean, alias?: string): string {
  if (!offline) return '';
  const col = alias ? `${alias}.id` : 'id';
  return ` AND EXISTS (SELECT 1 FROM cached_songs cs_f WHERE cs_f.song_id = ${col})`;
}

function translateWithFallback(
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
): string {
  try {
    const result = i18n.t(key, { defaultValue, ...options });
    if (typeof result === 'string' && result.length > 0 && result !== key) {
      return result;
    }
  } catch {
    // Fall back safely when i18n is unavailable.
  }
  return defaultValue;
}

function resolveDaylistSlot(hour: number): DaylistTimeSlot {
  for (const slot of DAYLIST_TIME_SLOTS) {
    const [start, end] = slot.range;
    if (start < end ? hour >= start && hour < end : hour >= start || hour < end) {
      return slot;
    }
  }
  return DAYLIST_TIME_SLOTS[DAYLIST_TIME_SLOTS.length - 1];
}

function buildDaylistCopy(
  hour: number,
  topGenres: readonly string[],
): { timeSlotKey: string; title: string; subtitle: string } {
  const slot = resolveDaylistSlot(hour);
  const title = translateWithFallback(slot.key, slot.fallbackTitle);
  const genrePreview = topGenres.slice(0, 3).join(', ');
  const fallbackSubtitle =
    genrePreview.length > 0
      ? `Picked for your ${title.toLowerCase()} · ${genrePreview}`
      : `Picked for your ${title.toLowerCase()}`;
  const subtitle = translateWithFallback('daylistSubtitle', fallbackSubtitle, {
    genres: genrePreview,
    timeSlot: title,
  });
  return { timeSlotKey: slot.key, title, subtitle };
}

function buildCachedSongSelect(alias?: string): string {
  const q = (col: string): string => (alias ? `${alias}.${col}` : col);
  const overrides: Record<string, string> = {
    id: q('song_id'),
    albumId: `COALESCE(${q('src_album_id')}, NULLIF(${q('album_id')}, '_unknown'))`,
    suffix: `COALESCE(${q('src_suffix')}, ${q('suffix')})`,
    bitRate: `COALESCE(${q('src_bit_rate')}, ${q('bit_rate')})`,
    bitDepth: `COALESCE(${q('src_bit_depth')}, ${q('bit_depth')})`,
    samplingRate: `COALESCE(${q('src_sampling_rate')}, ${q('sampling_rate')})`,
  };
  return (Object.entries(CHILD_SNAPSHOT_COLUMNS) as Array<[string, string]>)
    .map(([key, col]) => {
      const expr = overrides[key] ?? q(col);
      return expr === key ? key : `${expr} AS ${key}`;
    })
    .join(', ');
}

const CACHED_SONG_SELECT = buildCachedSongSelect();
const CACHED_SONG_SELECT_CS = buildCachedSongSelect('cs');

async function hydrateAndMapSongRows(db: InternalDb, rows: SongListRow[]): Promise<Child[]> {
  if (rows.length === 0) return [];
  await hydrateSongRows(db, rows);
  return rows.map((r) => songListRowToChild(r));
}

async function hydrateCachedSongRowsToChildren(
  db: InternalDb,
  rows: Record<string, unknown>[],
): Promise<Child[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id ?? '')).filter((id) => id.length > 0);
  if (ids.length === 0) return [];
  const arrays = await readChildSnapshotArraysAsync(db, {
    tablePrefix: 'cached_song',
    keyColumns: ['song_id'],
    where: 'song_id IN (SELECT value FROM json_each(?))',
    params: [JSON.stringify(ids)],
  });
  return rows.map((raw) => {
    const snapRow = childSnapshotRowFromRaw(raw);
    return childFromSnapshotRow(
      snapRow,
      arrays.get(childSnapshotArrayKey([snapRow.id])) ?? NO_ARRAYS,
    );
  });
}

async function loadCachedSongsByIds(db: InternalDb, ids: readonly string[]): Promise<Map<string, Child>> {
  const out = new Map<string, Child>();
  if (ids.length === 0) return out;
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT ${CACHED_SONG_SELECT} FROM cached_songs WHERE song_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify([...ids])],
  );
  const children = await hydrateCachedSongRowsToChildren(db, rows);
  for (const child of children) {
    out.set(child.id, child);
  }
  return out;
}

/** Round-robin interleave across buckets, deduplicating by key, up to `limit` items. */
function roundRobinPick<T>(
  buckets: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  limit: number,
  seen: Set<string>,
): T[] {
  const picked: T[] = [];
  const indices = buckets.map(() => 0);
  let madeProgress = true;
  while (picked.length < limit && madeProgress) {
    madeProgress = false;
    for (let b = 0; b < buckets.length && picked.length < limit; b++) {
      const bucket = buckets[b];
      while (indices[b] < bucket.length) {
        const candidate = bucket[indices[b]++];
        const key = keyOf(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(candidate);
        madeProgress = true;
        break;
      }
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/*  1. Jump Back In                                                    */
/* ------------------------------------------------------------------ */

interface RawJumpRow {
  id: string;
  title: string | null;
  subtitle: string | null;
  coverArt: string | null;
  lastPlayedAt: number;
  playCount: number;
  isCached: number;
}

type JumpCandidate = JumpBackInItem & { isCached: boolean };

function toJumpCandidate(type: JumpBackInItem['type'], row: RawJumpRow): JumpCandidate {
  return {
    id: row.id,
    type,
    title: row.title && row.title.length > 0 ? row.title : row.id,
    subtitle: row.subtitle && row.subtitle.length > 0 ? row.subtitle : undefined,
    coverArt: row.coverArt && row.coverArt.length > 0 ? row.coverArt : undefined,
    lastPlayedAt: row.lastPlayedAt,
    playCount: row.playCount,
    isCached: row.isCached === 1,
  };
}

function toPublicJumpItem(c: JumpCandidate): JumpBackInItem {
  const { isCached: _ignored, ...item } = c;
  return item;
}

async function queryRecentAlbums(
  db: InternalDb,
  perBucketLimit: number,
  offline: boolean,
): Promise<JumpCandidate[]> {
  const orderPrefix = offline ? 'isCached DESC, ' : '';
  const rows = await db.getAllAsync<RawJumpRow>(
    `SELECT a.id AS id,
            COALESCE(a.name, MAX(se.album)) AS title,
            COALESCE(a.display_artist, a.artist, MAX(se.artist)) AS subtitle,
            COALESCE(a.cover_art, MAX(se.cover_art)) AS coverArt,
            MAX(se.time) AS lastPlayedAt,
            COUNT(*) AS playCount,
            CASE WHEN EXISTS (
              SELECT 1 FROM cached_items ci WHERE ci.item_id = a.id AND ci.type = 'album'
            ) OR EXISTS (
              SELECT 1 FROM cached_songs cs WHERE COALESCE(cs.src_album_id, cs.album_id) = a.id
            ) THEN 1 ELSE 0 END AS isCached
       FROM scrobble_events se
       JOIN albums a ON a.id = se.album_id
      GROUP BY a.id
      ORDER BY ${orderPrefix}lastPlayedAt DESC, a.id ASC
      LIMIT ?`,
    [perBucketLimit],
  );
  const candidates = rows.map((r) => toJumpCandidate('album', r));
  if (!offline) return candidates;

  // Offline fallback for downloaded albums not currently in the synced `albums` table.
  const cachedRows = await db.getAllAsync<RawJumpRow>(
    `SELECT ca.item_id AS id,
            COALESCE(ca.name, MAX(se.album)) AS title,
            COALESCE(ca.display_artist, ca.artist, MAX(se.artist)) AS subtitle,
            COALESCE(ca.cover_art, MAX(se.cover_art)) AS coverArt,
            MAX(se.time) AS lastPlayedAt,
            COUNT(*) AS playCount,
            1 AS isCached
       FROM scrobble_events se
       JOIN cached_albums ca ON ca.item_id = se.album_id
      WHERE NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = ca.item_id)
      GROUP BY ca.item_id
      ORDER BY lastPlayedAt DESC, ca.item_id ASC
      LIMIT ?`,
    [perBucketLimit],
  );
  return [...candidates, ...cachedRows.map((r) => toJumpCandidate('album', r))];
}

async function queryRecentArtists(
  db: InternalDb,
  perBucketLimit: number,
  offline: boolean,
): Promise<JumpCandidate[]> {
  const orderPrefix = offline ? 'isCached DESC, ' : '';
  const rows = await db.getAllAsync<RawJumpRow>(
    `SELECT ar.id AS id,
            COALESCE(ar.name, MAX(se.artist)) AS title,
            NULL AS subtitle,
            COALESCE(ar.cover_art, MAX(se.cover_art)) AS coverArt,
            MAX(se.time) AS lastPlayedAt,
            COUNT(*) AS playCount,
            CASE WHEN EXISTS (
              SELECT 1 FROM cached_songs cs WHERE cs.artist_id = ar.id
            ) OR EXISTS (
              SELECT 1 FROM songs s
              JOIN cached_songs cs ON cs.song_id = s.id
              WHERE s.artist_id = ar.id
            ) THEN 1 ELSE 0 END AS isCached
       FROM scrobble_events se
       JOIN artists ar ON ar.id = se.artist_id
      GROUP BY ar.id
      ORDER BY ${orderPrefix}lastPlayedAt DESC, ar.id ASC
      LIMIT ?`,
    [perBucketLimit],
  );
  return rows.map((r) => toJumpCandidate('artist', r));
}

async function queryRecentPlaylists(
  db: InternalDb,
  perBucketLimit: number,
  offline: boolean,
): Promise<JumpCandidate[]> {
  const orderPrefix = offline ? 'isCached DESC, ' : '';
  const rows = await db.getAllAsync<RawJumpRow>(
    `SELECT p.id AS id,
            p.name AS title,
            p.comment AS subtitle,
            p.cover_art AS coverArt,
            MAX(se.time) AS lastPlayedAt,
            COUNT(DISTINCT se.id) AS playCount,
            CASE WHEN EXISTS (
              SELECT 1 FROM cached_items ci WHERE ci.item_id = p.id AND ci.type = 'playlist'
            ) OR EXISTS (
              SELECT 1 FROM playlist_songs ps2
              JOIN cached_songs cs ON cs.song_id = ps2.song_id
              WHERE ps2.playlist_id = p.id
            ) THEN 1 ELSE 0 END AS isCached
       FROM scrobble_events se
       JOIN (SELECT DISTINCT playlist_id, song_id FROM playlist_songs) ps ON ps.song_id = se.song_id
       JOIN playlists p ON p.id = ps.playlist_id
      GROUP BY p.id
      ORDER BY ${orderPrefix}lastPlayedAt DESC, p.id ASC
      LIMIT ?`,
    [perBucketLimit],
  );

  const byId = new Map<string, JumpCandidate>();
  for (const r of rows) {
    byId.set(r.id, toJumpCandidate('playlist', r));
  }

  // Merge recent playlists from `recentPlaysStore` (covers just-started playlists
  // or playlists without scrobble overlap yet).
  const recentPlaylists = recentPlaysStore
    .getState()
    .recentItems.filter((item) => item.type === 'playlist');

  if (recentPlaylists.length > 0) {
    const missingIds = recentPlaylists.filter((p) => !byId.has(p.id)).map((p) => p.id);
    const metaById = new Map<string, { name: string | null; comment: string | null; cover_art: string | null; isCached: number }>();
    if (missingIds.length > 0) {
      const dbMetaRows = await db.getAllAsync<{
        id: string;
        name: string | null;
        comment: string | null;
        cover_art: string | null;
        isCached: number;
      }>(
        `SELECT p.id, p.name, p.comment, p.cover_art,
                CASE WHEN EXISTS (
                  SELECT 1 FROM cached_items ci WHERE ci.item_id = p.id AND ci.type = 'playlist'
                ) OR EXISTS (
                  SELECT 1 FROM playlist_songs ps
                  JOIN cached_songs cs ON cs.song_id = ps.song_id
                  WHERE ps.playlist_id = p.id
                ) THEN 1 ELSE 0 END AS isCached
           FROM playlists p
          WHERE p.id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(missingIds)],
      );
      for (const m of dbMetaRows) metaById.set(m.id, m);

      const stillMissing = missingIds.filter((id) => !metaById.has(id));
      if (stillMissing.length > 0) {
        const cachedMetaRows = await db.getAllAsync<{
          id: string;
          name: string | null;
          comment: string | null;
          cover_art: string | null;
        }>(
          `SELECT cp.item_id AS id, cp.name, cp.comment, cp.cover_art
             FROM cached_playlists cp
            WHERE cp.item_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(stillMissing)],
        );
        for (const m of cachedMetaRows) metaById.set(m.id, { ...m, isCached: 1 });
      }
    }

    const baseTime = Date.now();
    for (let idx = 0; idx < recentPlaylists.length; idx++) {
      const recent = recentPlaylists[idx];
      const existing = byId.get(recent.id);
      if (existing) {
        if ((!existing.title || existing.title === existing.id) && recent.title) {
          existing.title = recent.title;
        }
        if (!existing.subtitle && recent.subtitle) existing.subtitle = recent.subtitle;
        if (!existing.coverArt && recent.coverUri) existing.coverArt = recent.coverUri;
        continue;
      }
      const meta = metaById.get(recent.id);
      const cachedFlag =
        meta?.isCached ??
        ((await db.getFirstAsync<{ one: number }>(
          `SELECT 1 AS one
             WHERE EXISTS (SELECT 1 FROM cached_items WHERE item_id = ? AND type = 'playlist')
                OR EXISTS (
                  SELECT 1 FROM playlist_songs ps
                  JOIN cached_songs cs ON cs.song_id = ps.song_id
                  WHERE ps.playlist_id = ?
                )`,
          [recent.id, recent.id],
        ))
          ? 1
          : 0);
      byId.set(recent.id, {
        id: recent.id,
        type: 'playlist',
        title: (meta?.name || recent.title || recent.id),
        subtitle: (meta?.comment || recent.subtitle) || undefined,
        coverArt: (meta?.cover_art || recent.coverUri) || undefined,
        lastPlayedAt: baseTime - idx,
        playCount: 1,
        isCached: cachedFlag === 1,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (offline && a.isCached !== b.isCached) return a.isCached ? -1 : 1;
    return b.lastPlayedAt - a.lastPlayedAt;
  });
}

/**
 * Balanced mix of recently listened Playlists, Artists, and Albums from
 * `scrobble_events` and `recentPlaysStore`, deduplicated and sorted by
 * `lastPlayedAt DESC` (prioritizing cached content when offline).
 */
export async function getJumpBackIn(limit = 6): Promise<JumpBackInItem[]> {
  if (limit <= 0) return [];
  const db = getDb();
  if (!db) return [];

  const offline = isOfflineMode();
  const perBucketLimit = Math.max(limit * 2, 12);

  try {
    const [playlists, artists, albums] = await Promise.all([
      queryRecentPlaylists(db, perBucketLimit, offline),
      queryRecentArtists(db, perBucketLimit, offline),
      queryRecentAlbums(db, perBucketLimit, offline),
    ]);

    const seen = new Set<string>();
    const keyOf = (item: JumpCandidate): string => `${item.type}:${item.id}`;
    let selected: JumpCandidate[];

    if (offline) {
      const cachedPicked = roundRobinPick(
        [
          playlists.filter((x) => x.isCached),
          artists.filter((x) => x.isCached),
          albums.filter((x) => x.isCached),
        ],
        keyOf,
        limit,
        seen,
      );
      if (cachedPicked.length < limit) {
        const rest = roundRobinPick(
          [playlists, artists, albums],
          keyOf,
          limit - cachedPicked.length,
          seen,
        );
        selected = [...cachedPicked, ...rest];
      } else {
        selected = cachedPicked;
      }
      selected.sort((a, b) => {
        if (a.isCached !== b.isCached) return a.isCached ? -1 : 1;
        return b.lastPlayedAt - a.lastPlayedAt;
      });
    } else {
      selected = roundRobinPick([playlists, artists, albums], keyOf, limit, seen);
      selected.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
    }

    return selected.slice(0, limit).map(toPublicJumpItem);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  2. Hourly Daylist                                                  */
/* ------------------------------------------------------------------ */

/**
 * Derive a time-of-day playlist for the current local hour (±1h window over
 * `scrobble_events.hour`), topping up with genre-matched or popular local songs.
 */
export async function getHourlyDaylist(limit = 25): Promise<HourlyDaylist> {
  const hour = new Date().getHours();
  if (limit <= 0) {
    const copy = buildDaylistCopy(hour, []);
    return { hour, ...copy, topGenres: [], songs: [] };
  }
  const db = getDb();
  if (!db) {
    const copy = buildDaylistCopy(hour, []);
    return { hour, ...copy, topGenres: [], songs: [] };
  }

  const offline = isOfflineMode();
  const windowHours = [(hour + 23) % 24, hour, (hour + 1) % 24];

  try {
    const [genreRows, slotSongRows] = await Promise.all([
      db.getAllAsync<{ genre: string; c: number }>(
        `SELECT MIN(genre_name) AS genre, COUNT(*) AS c
           FROM (
             SELECT TRIM(sg.name) AS genre_name
               FROM scrobble_events se
               JOIN scrobble_genres sg ON sg.scrobble_id = se.id
              WHERE se.hour IN (?, ?, ?) AND TRIM(sg.name) <> ''
             UNION ALL
             SELECT TRIM(se.genre) AS genre_name
               FROM scrobble_events se
              WHERE se.hour IN (?, ?, ?)
                AND se.genre IS NOT NULL AND TRIM(se.genre) <> ''
                AND NOT EXISTS (SELECT 1 FROM scrobble_genres sg WHERE sg.scrobble_id = se.id)
           )
          GROUP BY LOWER(genre_name)
          ORDER BY c DESC, genre ASC
          LIMIT 5`,
        [...windowHours, ...windowHours],
      ),
      db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S}
           FROM scrobble_events se
           JOIN songs s ON s.id = se.song_id
          WHERE se.hour IN (?, ?, ?)
            ${offlineSongFilter(offline, 's')}
          GROUP BY s.id
          ORDER BY COUNT(*) DESC, MAX(se.time) DESC, s.id ASC
          LIMIT ?`,
        [...windowHours, limit],
      ),
    ]);

    const collectedRows: SongListRow[] = [...slotSongRows];
    const seenIds = new Set<string>(collectedRows.map((r) => r.id));

    let topGenres = genreRows.map((g) => g.genre).filter((g) => g.length > 0);

    // If scrobble snapshots lacked genre labels, inspect genres of the matched slot songs.
    if (topGenres.length === 0 && collectedRows.length > 0) {
      await hydrateSongRows(db, collectedRows);
      const counts = new Map<string, { label: string; count: number }>();
      for (const row of collectedRows) {
        const names = row.genres && row.genres.length > 0 ? row.genres : row.genre ? [row.genre] : [];
        for (const rawName of names) {
          const name = rawName.trim();
          if (!name) continue;
          const k = name.toLowerCase();
          const prev = counts.get(k);
          if (prev) prev.count += 1;
          else counts.set(k, { label: name, count: 1 });
        }
      }
      topGenres = Array.from(counts.values())
        .sort((a, b) => b.count - a.count || defaultCollator.compare(a.label, b.label))
        .slice(0, 5)
        .map((g) => g.label);
    }

    // Top up from `songs` matching the time-slot genres.
    if (collectedRows.length < limit && topGenres.length > 0) {
      const lowerGenres = topGenres.map((g) => g.toLowerCase());
      const remaining = limit - collectedRows.length;
      const genreMatches = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S}
           FROM songs s
          WHERE (
            LOWER(TRIM(COALESCE(s.genre, ''))) IN (SELECT value FROM json_each(?))
            OR EXISTS (
              SELECT 1 FROM song_genres sg
               WHERE sg.song_id = s.id
                 AND LOWER(TRIM(sg.name)) IN (SELECT value FROM json_each(?))
            )
          )
            AND s.id NOT IN (SELECT value FROM json_each(?))
            ${offlineSongFilter(offline, 's')}
          ORDER BY COALESCE(s.play_count, 0) DESC,
                   (s.starred IS NOT NULL) DESC,
                   COALESCE(s.user_rating, 0) DESC,
                   s.sort_title ASC,
                   s.id ASC
          LIMIT ?`,
        [
          JSON.stringify(lowerGenres),
          JSON.stringify(lowerGenres),
          JSON.stringify(Array.from(seenIds)),
          remaining,
        ],
      );
      for (const r of genreMatches) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          collectedRows.push(r);
        }
      }
    }

    // Top up with popular local songs if still below `limit`.
    if (collectedRows.length < limit) {
      const remaining = limit - collectedRows.length;
      const popular = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S}
           FROM songs s
          WHERE s.id NOT IN (SELECT value FROM json_each(?))
            ${offlineSongFilter(offline, 's')}
          ORDER BY COALESCE(s.play_count, 0) DESC,
                   (s.starred IS NOT NULL) DESC,
                   COALESCE(s.user_rating, 0) DESC,
                   s.sort_title ASC,
                   s.id ASC
          LIMIT ?`,
        [JSON.stringify(Array.from(seenIds)), remaining],
      );
      for (const r of popular) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          collectedRows.push(r);
        }
      }
    }

    const songs = await hydrateAndMapSongRows(db, collectedRows);

    // Offline fallback if `songs` didn't have enough rows for downloaded `cached_songs`.
    if (offline && songs.length < limit) {
      const remaining = limit - songs.length;
      const lowerGenres = topGenres.map((g) => g.toLowerCase());
      const cachedRows = await db.getAllAsync<Record<string, unknown>>(
        `SELECT ${CACHED_SONG_SELECT_CS}
           FROM cached_songs cs
          WHERE cs.song_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY ${
            lowerGenres.length > 0
              ? `CASE WHEN LOWER(TRIM(COALESCE(cs.genre, ''))) IN (SELECT value FROM json_each(?))
                        OR EXISTS (
                          SELECT 1 FROM cached_song_genres csg
                           WHERE csg.song_id = cs.song_id
                             AND LOWER(TRIM(csg.name)) IN (SELECT value FROM json_each(?))
                        ) THEN 0 ELSE 1 END ASC, `
              : ''
          }COALESCE(cs.play_count, 0) DESC,
                   (cs.starred IS NOT NULL) DESC,
                   COALESCE(cs.user_rating, 0) DESC,
                   cs.downloaded_at DESC,
                   cs.song_id ASC
          LIMIT ?`,
        lowerGenres.length > 0
          ? [
              JSON.stringify(Array.from(seenIds)),
              JSON.stringify(lowerGenres),
              JSON.stringify(lowerGenres),
              remaining,
            ]
          : [JSON.stringify(Array.from(seenIds)), remaining],
      );
      const cachedChildren = await hydrateCachedSongRowsToChildren(db, cachedRows);
      songs.push(...cachedChildren);
    }

    const copy = buildDaylistCopy(hour, topGenres);
    return { hour, ...copy, topGenres, songs: songs.slice(0, limit) };
  } catch {
    const copy = buildDaylistCopy(hour, []);
    return { hour, ...copy, topGenres: [], songs: [] };
  }
}

/* ------------------------------------------------------------------ */
/*  3. On Repeat (Last 14 Days)                                        */
/* ------------------------------------------------------------------ */

/**
 * Most-played songs in the last 14 days, hydrated from `songs` (or
 * `cached_songs` / `scrobble_events` snapshot fallback if reaped from `songs`).
 */
export async function getOnRepeat(limit = 25): Promise<Child[]> {
  if (limit <= 0) return [];
  const db = getDb();
  if (!db) return [];

  const offline = isOfflineMode();
  const cutoffMs = Date.now() - ON_REPEAT_DAYS * DAY_MS;

  try {
    const ranked = await db.getAllAsync<{
      scrobbleId: string;
      songId: string;
      playCount: number;
      lastPlayedAt: number;
    }>(
      `SELECT scrobbleId, songId, playCount, lastPlayedAt
         FROM (
           SELECT id AS scrobbleId,
                  song_id AS songId,
                  time AS lastPlayedAt,
                  COUNT(*) OVER (PARTITION BY song_id) AS playCount,
                  ROW_NUMBER() OVER (
                    PARTITION BY song_id ORDER BY time DESC, id DESC
                  ) AS rn
             FROM scrobble_events
            WHERE time >= ?
              AND song_id IS NOT NULL AND song_id <> ''
              AND (title IS NULL OR title <> '')
              ${offline ? 'AND EXISTS (SELECT 1 FROM cached_songs cs WHERE cs.song_id = scrobble_events.song_id)' : ''}
         )
        WHERE rn = 1
        ORDER BY playCount DESC, lastPlayedAt DESC, songId ASC
        LIMIT ?`,
      [cutoffMs, limit],
    );

    if (ranked.length === 0) return [];

    const songIds = ranked.map((r) => r.songId);
    const libRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS} FROM songs WHERE id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(songIds)],
    );
    const libSongs = await hydrateAndMapSongRows(db, libRows);
    const bySongId = new Map<string, Child>(libSongs.map((s) => [s.id, s]));

    // Fallback for songs missing from `songs` (e.g. reaped or not synced).
    const missing = ranked.filter((r) => !bySongId.has(r.songId));
    if (missing.length > 0 && offline) {
      const cachedMap = await loadCachedSongsByIds(
        db,
        missing.map((m) => m.songId),
      );
      for (const [id, child] of cachedMap) {
        bySongId.set(id, child);
      }
    }

    const stillMissing = ranked.filter((r) => !bySongId.has(r.songId));
    if (stillMissing.length > 0) {
      const snapRows = await db.getAllAsync<ScrobbleSnapshotRow>(
        `SELECT ${SCROBBLE_SELECT}
           FROM scrobble_events
          WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(stillMissing.map((m) => m.scrobbleId))],
      );
      const reconstructed = await scrobblesWithArrays(db, 'scrobble', snapRows);
      for (const s of reconstructed) {
        if (s.song.id && !bySongId.has(s.song.id)) {
          bySongId.set(s.song.id, s.song);
        }
      }
      // Handle rare scrobble rows where `title` is NULL (not '' backfill sentinel).
      for (const row of snapRows) {
        if (row.id && row.title == null && !bySongId.has(row.id)) {
          bySongId.set(row.id, rowToScrobble(row).song);
        }
      }
    }

    const result: Child[] = [];
    for (const r of ranked) {
      const child = bySongId.get(r.songId);
      if (child) result.push(child);
    }
    return result;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  4. Forgotten Gems (> 60 Days Since Last Play)                      */
/* ------------------------------------------------------------------ */

interface ForgottenCandidateRow extends SongListRow {
  historical_plays: number;
  last_scrobble: number | null;
}

function isOlderThanCutoff(
  playedText: string | null,
  lastScrobble: number | null,
  cutoffMs: number,
): boolean {
  const playedMs = playedText ? Date.parse(playedText) : NaN;
  const hasPlayed = Number.isFinite(playedMs);
  const hasScrobble = lastScrobble != null;
  if (!hasPlayed && !hasScrobble) return false;
  if (hasPlayed && playedMs >= cutoffMs) return false;
  if (hasScrobble && lastScrobble >= cutoffMs) return false;
  return true;
}

/**
 * Songs with historical play count >= 2 whose latest play (`MAX(se.time)` /
 * `s.played`) is older than 60 days, ordered by historical play count DESC.
 */
export async function getForgottenGems(limit = 25): Promise<Child[]> {
  if (limit <= 0) return [];
  const db = getDb();
  if (!db) return [];

  const offline = isOfflineMode();
  const cutoffMs = Date.now() - FORGOTTEN_GEMS_DAYS * DAY_MS;
  // +1000ms margin absorbs `strftime('%s', ...)` sub-second truncation before JS verifies exact ms.
  const sqlPreFilterMs = cutoffMs + 1000;
  const candidateLimit = Math.max(limit * 3, 50);

  try {
    const candidates = await db.getAllAsync<ForgottenCandidateRow>(
      `SELECT ${SONG_LIST_COLS_S},
              (COALESCE(s.play_count, 0) + COALESCE(sc.total_scrobbles, 0)) AS historical_plays,
              sc.last_scrobble AS last_scrobble
         FROM songs s
         LEFT JOIN (
           SELECT song_id, COUNT(*) AS total_scrobbles, MAX(time) AS last_scrobble
             FROM scrobble_events
            WHERE song_id IS NOT NULL AND song_id <> ''
            GROUP BY song_id
         ) sc ON sc.song_id = s.id
        WHERE (COALESCE(s.play_count, 0) + COALESCE(sc.total_scrobbles, 0)) >= ?
          AND (sc.last_scrobble IS NULL OR sc.last_scrobble < ?)
          AND (sc.last_scrobble IS NOT NULL OR (s.played IS NOT NULL AND s.played <> ''))
          AND (
            s.played IS NULL
            OR s.played = ''
            OR strftime('%s', s.played) IS NULL
            OR CAST(strftime('%s', s.played) AS INTEGER) * 1000 < ?
          )
          ${offlineSongFilter(offline, 's')}
        ORDER BY historical_plays DESC, COALESCE(sc.last_scrobble, 0) ASC, s.id ASC
        LIMIT ?`,
      [FORGOTTEN_MIN_PLAYS, cutoffMs, sqlPreFilterMs, candidateLimit],
    );

    const verified = candidates.filter((r) =>
      isOlderThanCutoff(r.played, r.last_scrobble, cutoffMs),
    );
    const chosenLib = verified.slice(0, limit);
    const libChildren = await hydrateAndMapSongRows(db, chosenLib);

    if (!offline || libChildren.length >= limit) {
      return libChildren;
    }

    // Offline fallback for downloaded songs absent from `songs`.
    const remaining = limit - libChildren.length;
    const cachedCandidates = await db.getAllAsync<
      Record<string, unknown> & { historical_plays: number; last_scrobble: number | null; played: string | null }
    >(
      `SELECT ${CACHED_SONG_SELECT_CS},
              (COALESCE(cs.play_count, 0) + COALESCE(sc.total_scrobbles, 0)) AS historical_plays,
              sc.last_scrobble AS last_scrobble,
              cs.played AS played
         FROM cached_songs cs
         LEFT JOIN (
           SELECT song_id, COUNT(*) AS total_scrobbles, MAX(time) AS last_scrobble
             FROM scrobble_events
            WHERE song_id IS NOT NULL AND song_id <> ''
            GROUP BY song_id
         ) sc ON sc.song_id = cs.song_id
        WHERE NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
          AND (COALESCE(cs.play_count, 0) + COALESCE(sc.total_scrobbles, 0)) >= ?
          AND (sc.last_scrobble IS NULL OR sc.last_scrobble < ?)
          AND (sc.last_scrobble IS NOT NULL OR (cs.played IS NOT NULL AND cs.played <> ''))
          AND (
            cs.played IS NULL
            OR cs.played = ''
            OR strftime('%s', cs.played) IS NULL
            OR CAST(strftime('%s', cs.played) AS INTEGER) * 1000 < ?
          )
        ORDER BY historical_plays DESC, COALESCE(sc.last_scrobble, 0) ASC, cs.song_id ASC
        LIMIT ?`,
      [FORGOTTEN_MIN_PLAYS, cutoffMs, sqlPreFilterMs, Math.max(remaining * 3, 50)],
    );

    const verifiedCached = cachedCandidates
      .filter((r) => isOlderThanCutoff(r.played, r.last_scrobble, cutoffMs))
      .slice(0, remaining);
    const cachedChildren = await hydrateCachedSongRowsToChildren(db, verifiedCached);

    // Merge while preserving historical_plays DESC ordering across both sources.
    const scoreById = new Map<string, number>();
    for (const r of chosenLib) scoreById.set(r.id, r.historical_plays);
    for (const r of verifiedCached) scoreById.set(String(r.id), r.historical_plays);

    return [...libChildren, ...cachedChildren]
      .sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  5. Quick Mood / Genre / BPM Chips & Song Resolution                */
/* ------------------------------------------------------------------ */

interface GenreCountRow {
  genre: string;
  songCount: number;
}

interface MoodCountRow {
  mood: string;
  songCount: number;
}

interface BpmCountsRow {
  chillCount: number;
  grooveCount: number;
  highEnergyCount: number;
}

/**
 * Derive mood, genre, and BPM energy chips actually present in the user's
 * SQLite library (`songCount > 0`).
 */
export async function getQuickMoodChips(limit = 10): Promise<QuickMoodChip[]> {
  if (limit <= 0) return [];
  const db = getDb();
  if (!db) return [];

  const offline = isOfflineMode();

  try {
    const genreSql = offline
      ? `SELECT MIN(genre) AS genre, COUNT(DISTINCT song_id) AS songCount
           FROM (
             SELECT sg.song_id AS song_id, TRIM(sg.name) AS genre
               FROM song_genres sg
               JOIN songs s ON s.id = sg.song_id
              WHERE TRIM(sg.name) <> ''
                AND EXISTS (SELECT 1 FROM cached_songs cs WHERE cs.song_id = s.id)
             UNION
             SELECT s.id AS song_id, TRIM(s.genre) AS genre
               FROM songs s
              WHERE s.genre IS NOT NULL AND TRIM(s.genre) <> ''
                AND EXISTS (SELECT 1 FROM cached_songs cs WHERE cs.song_id = s.id)
             UNION
             SELECT csg.song_id AS song_id, TRIM(csg.name) AS genre
               FROM cached_song_genres csg
               JOIN cached_songs cs ON cs.song_id = csg.song_id
              WHERE TRIM(csg.name) <> ''
                AND NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
             UNION
             SELECT cs.song_id AS song_id, TRIM(cs.genre) AS genre
               FROM cached_songs cs
              WHERE cs.genre IS NOT NULL AND TRIM(cs.genre) <> ''
                AND NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
           )
          GROUP BY LOWER(genre)
          HAVING songCount > 0
          ORDER BY songCount DESC, genre ASC
          LIMIT ?`
      : `SELECT MIN(genre) AS genre, COUNT(DISTINCT song_id) AS songCount
           FROM (
             SELECT sg.song_id AS song_id, TRIM(sg.name) AS genre
               FROM song_genres sg
              WHERE TRIM(sg.name) <> ''
             UNION
             SELECT s.id AS song_id, TRIM(s.genre) AS genre
               FROM songs s
              WHERE s.genre IS NOT NULL AND TRIM(s.genre) <> ''
           )
          GROUP BY LOWER(genre)
          HAVING songCount > 0
          ORDER BY songCount DESC, genre ASC
          LIMIT ?`;

    const moodSql = offline
      ? `SELECT MIN(mood) AS mood, COUNT(DISTINCT song_id) AS songCount
           FROM (
             SELECT sm.song_id AS song_id, TRIM(sm.mood) AS mood
               FROM song_moods sm
               JOIN songs s ON s.id = sm.song_id
              WHERE TRIM(sm.mood) <> ''
                AND EXISTS (SELECT 1 FROM cached_songs cs WHERE cs.song_id = s.id)
             UNION
             SELECT csm.song_id AS song_id, TRIM(csm.mood) AS mood
               FROM cached_song_moods csm
               JOIN cached_songs cs ON cs.song_id = csm.song_id
              WHERE TRIM(csm.mood) <> ''
                AND NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
           )
          GROUP BY LOWER(mood)
          HAVING songCount > 0
          ORDER BY songCount DESC, mood ASC
          LIMIT ?`
      : `SELECT MIN(TRIM(sm.mood)) AS mood, COUNT(DISTINCT sm.song_id) AS songCount
           FROM song_moods sm
          WHERE TRIM(sm.mood) <> ''
          GROUP BY LOWER(TRIM(sm.mood))
          HAVING songCount > 0
          ORDER BY songCount DESC, mood ASC
          LIMIT ?`;

    const bpmSql = offline
      ? `SELECT
           COALESCE(SUM(CASE WHEN bpm > 0 AND bpm < 95 THEN 1 ELSE 0 END), 0) AS chillCount,
           COALESCE(SUM(CASE WHEN bpm >= 95 AND bpm <= 124 THEN 1 ELSE 0 END), 0) AS grooveCount,
           COALESCE(SUM(CASE WHEN bpm >= 125 THEN 1 ELSE 0 END), 0) AS highEnergyCount
         FROM (
           SELECT s.id AS song_id, s.bpm AS bpm
             FROM songs s
            WHERE s.bpm IS NOT NULL AND s.bpm > 0
              AND EXISTS (SELECT 1 FROM cached_songs cs WHERE cs.song_id = s.id)
           UNION ALL
           SELECT cs.song_id AS song_id, cs.bpm AS bpm
             FROM cached_songs cs
            WHERE cs.bpm IS NOT NULL AND cs.bpm > 0
              AND NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
         )`
      : `SELECT
           COALESCE(SUM(CASE WHEN bpm > 0 AND bpm < 95 THEN 1 ELSE 0 END), 0) AS chillCount,
           COALESCE(SUM(CASE WHEN bpm >= 95 AND bpm <= 124 THEN 1 ELSE 0 END), 0) AS grooveCount,
           COALESCE(SUM(CASE WHEN bpm >= 125 THEN 1 ELSE 0 END), 0) AS highEnergyCount
         FROM songs
         WHERE bpm IS NOT NULL AND bpm > 0`;

    const [genreRows, moodRows, bpmRow] = await Promise.all([
      db.getAllAsync<GenreCountRow>(genreSql, [limit]),
      db.getAllAsync<MoodCountRow>(moodSql, [limit]),
      db.getFirstAsync<BpmCountsRow>(bpmSql),
    ]);

    const genreChips: QuickMoodChip[] = genreRows
      .filter((r) => r.songCount > 0)
      .map((r) => ({
        id: `genre:${r.genre.toLowerCase()}`,
        label: r.genre,
        kind: 'genre',
        genre: r.genre,
        songCount: r.songCount,
      }));

    const moodChips: QuickMoodChip[] = moodRows
      .filter((r) => r.songCount > 0)
      .map((r) => ({
        id: `mood:${r.mood.toLowerCase()}`,
        label: r.mood,
        kind: 'mood',
        mood: r.mood,
        songCount: r.songCount,
      }));

    const bpmChips: QuickMoodChip[] = [];
    if ((bpmRow?.chillCount ?? 0) > 0) {
      bpmChips.push({
        id: 'bpm:chill',
        label: translateWithFallback('moodChill', 'Chill'),
        kind: 'bpm',
        maxBpm: 94,
        songCount: bpmRow!.chillCount,
      });
    }
    if ((bpmRow?.grooveCount ?? 0) > 0) {
      bpmChips.push({
        id: 'bpm:groove',
        label: translateWithFallback('moodGroove', 'Groove'),
        kind: 'bpm',
        minBpm: 95,
        maxBpm: 124,
        songCount: bpmRow!.grooveCount,
      });
    }
    if ((bpmRow?.highEnergyCount ?? 0) > 0) {
      bpmChips.push({
        id: 'bpm:high-energy',
        label: translateWithFallback('moodHighEnergy', 'High Energy'),
        kind: 'bpm',
        minBpm: 125,
        songCount: bpmRow!.highEnergyCount,
      });
    }
    bpmChips.sort((a, b) => b.songCount - a.songCount);

    const seen = new Set<string>();
    return roundRobinPick(
      [genreChips, moodChips, bpmChips],
      (c) => c.id,
      limit,
      seen,
    );
  } catch {
    return [];
  }
}

/**
 * Resolve songs matching a `QuickMoodChip` purely from SQLite.
 */
export async function getSongsForMoodChip(
  chip: QuickMoodChip,
  limit = 25,
): Promise<Child[]> {
  if (limit <= 0) return [];
  const db = getDb();
  if (!db) return [];

  const offline = isOfflineMode();
  const orderClause =
    'ORDER BY COALESCE(s.play_count, 0) DESC, (s.starred IS NOT NULL) DESC, COALESCE(s.user_rating, 0) DESC, s.sort_title ASC, s.id ASC';
  const cachedOrderClause =
    'ORDER BY COALESCE(cs.play_count, 0) DESC, (cs.starred IS NOT NULL) DESC, COALESCE(cs.user_rating, 0) DESC, cs.downloaded_at DESC, cs.song_id ASC';

  try {
    let whereSql = '';
    let cachedWhereSql = '';
    let params: Array<string | number> = [];

    if (chip.kind === 'genre') {
      const genre = (chip.genre ?? chip.label).trim().toLowerCase();
      if (!genre) return [];
      whereSql =
        `(LOWER(TRIM(COALESCE(s.genre, ''))) = ? OR EXISTS (` +
        `SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(TRIM(sg.name)) = ?))`;
      cachedWhereSql =
        `(LOWER(TRIM(COALESCE(cs.genre, ''))) = ? OR EXISTS (` +
        `SELECT 1 FROM cached_song_genres csg WHERE csg.song_id = cs.song_id AND LOWER(TRIM(csg.name)) = ?))`;
      params = [genre, genre];
    } else if (chip.kind === 'mood') {
      const mood = (chip.mood ?? chip.label).trim().toLowerCase();
      if (!mood) return [];
      whereSql =
        `EXISTS (SELECT 1 FROM song_moods sm WHERE sm.song_id = s.id AND LOWER(TRIM(sm.mood)) = ?)`;
      cachedWhereSql =
        `EXISTS (SELECT 1 FROM cached_song_moods csm WHERE csm.song_id = cs.song_id AND LOWER(TRIM(csm.mood)) = ?)`;
      params = [mood];
    } else if (chip.kind === 'bpm') {
      const buildBpmCond = (col: string): string => {
        const parts = [`${col} IS NOT NULL`, `${col} > 0`];
        if (chip.minBpm != null) parts.push(`${col} >= ?`);
        if (chip.maxBpm != null) parts.push(`${col} <= ?`);
        return parts.join(' AND ');
      };
      whereSql = buildBpmCond('s.bpm');
      cachedWhereSql = buildBpmCond('cs.bpm');
      if (chip.minBpm != null) params.push(chip.minBpm);
      if (chip.maxBpm != null) params.push(chip.maxBpm);
    } else {
      return [];
    }

    const libRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S}
         FROM songs s
        WHERE ${whereSql}
          ${offlineSongFilter(offline, 's')}
        ${orderClause}
        LIMIT ?`,
      [...params, limit],
    );
    const children = await hydrateAndMapSongRows(db, libRows);

    if (!offline || children.length >= limit) {
      return children;
    }

    const remaining = limit - children.length;
    const cachedRows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT ${CACHED_SONG_SELECT_CS}
         FROM cached_songs cs
        WHERE ${cachedWhereSql}
          AND NOT EXISTS (SELECT 1 FROM songs s WHERE s.id = cs.song_id)
        ${cachedOrderClause}
        LIMIT ?`,
      [...params, remaining],
    );
    const cachedChildren = await hydrateCachedSongRowsToChildren(db, cachedRows);
    return [...children, ...cachedChildren];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  6. Dynamic Mix Cache & Lazy Sonic Expansion (0ms Home + Lazy)      */
/* ------------------------------------------------------------------ */

const DEFAULT_DYNAMIC_MIX_TTL_MS = 8 * 3_600_000; // 8 hours (within 6-12h window)
const DEFAULT_DYNAMIC_MIX_TIMEOUT_MS = 2500;
const DEFAULT_DYNAMIC_MIX_TARGET_COUNT = 25;
const DAILY_MIX_MAX_CLUSTERS = 4;

interface DynamicMixCacheRow {
  mix_key: string;
  mix_type: string | null;
  title: string | null;
  subtitle: string | null;
  seed_ids_json: string | null;
  song_ids_json: string | null;
  source: string | null;
  updated_at: number | null;
  expires_at: number | null;
}

interface DynamicMixDescriptor {
  mixKey: string;
  mixType: DynamicMixType;
  title: string;
  subtitle: string;
  seedSongs: Child[];
  clusterSongs: Child[];
  bridgeEndSong?: Child;
}

function getMixSkipPenalty(songId: string): number {
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

function isSonicSettingEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../store/radioAiSettingsStore') as {
      radioAiSettingsStore?: { getState: () => { sources?: { sonicSimilarity?: boolean } } };
    };
    return mod?.radioAiSettingsStore?.getState()?.sources?.sonicSimilarity !== false;
  } catch {
    return true;
  }
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function extractSongGenresLower(song: Child): string[] {
  const out: string[] = [];
  if (song.genre?.trim()) out.push(song.genre.trim().toLowerCase());
  for (const g of (song.genres ?? []) as unknown[]) {
    if (typeof g === 'string' && g.trim()) {
      out.push(g.trim().toLowerCase());
    } else if (g && typeof g === 'object' && 'name' in g) {
      const name = (g as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) out.push(name.trim().toLowerCase());
    }
  }
  return Array.from(new Set(out));
}

async function hydrateMixSongsByIds(
  db: InternalDb,
  ids: readonly string[],
  offline: boolean,
): Promise<Child[]> {
  if (ids.length === 0) return [];
  const byId = new Map<string, Child>();

  const libRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS_S}
       FROM songs s
      WHERE s.id IN (SELECT value FROM json_each(?))
      ${offlineSongFilter(offline, 's')}`,
    [JSON.stringify([...ids])],
  );
  const libSongs = await hydrateAndMapSongRows(db, libRows);
  for (const s of libSongs) {
    byId.set(s.id, s);
  }

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const cachedMap = await loadCachedSongsByIds(db, missing);
    for (const [id, child] of cachedMap) {
      byId.set(id, child);
    }
  }

  const ordered: Child[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const song = byId.get(id);
    if (!song) continue;
    seen.add(id);
    ordered.push(song);
  }
  return ordered;
}

/**
 * Group `getOnRepeat(14d)` tracks into 2–4 clusters using local SQLite
 * `playlist_songs` co-occurrence and `song_genres` overlap. Zero network calls.
 */
async function buildDailyMixDescriptors(
  db: InternalDb,
  onRepeatSongs: readonly Child[],
): Promise<DynamicMixDescriptor[]> {
  if (onRepeatSongs.length === 0) return [];

  const songs = onRepeatSongs.slice(0, 40);
  const n = songs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Connect songs sharing playlists in `playlist_songs`
  const songIds = songs.map((s) => s.id);
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) indexById.set(songIds[i], i);

  try {
    const plRows = await db.getAllAsync<{ playlist_id: string; song_id: string }>(
      `SELECT playlist_id, song_id
         FROM playlist_songs
        WHERE song_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(songIds)],
    );
    const byPlaylist = new Map<string, number[]>();
    for (const r of plRows ?? []) {
      const idx = indexById.get(r.song_id);
      if (idx === undefined) continue;
      const list = byPlaylist.get(r.playlist_id) ?? [];
      list.push(idx);
      byPlaylist.set(r.playlist_id, list);
    }
    for (const members of byPlaylist.values()) {
      for (let i = 1; i < members.length; i++) {
        union(members[0], members[i]);
      }
    }
  } catch {
    // Missing playlist_songs or partial DB — continue with genre clustering
  }

  // Connect songs sharing primary genre
  const firstByGenre = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const genres = extractSongGenresLower(songs[i]);
    if (genres.length === 0) continue;
    const primary = genres[0];
    const prev = firstByGenre.get(primary);
    if (prev !== undefined) {
      union(prev, i);
    } else {
      firstByGenre.set(primary, i);
    }
  }

  const groupMap = new Map<number, Child[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groupMap.get(root) ?? [];
    list.push(songs[i]);
    groupMap.set(root, list);
  }

  let clusters = Array.from(groupMap.values()).sort((a, b) => b.length - a.length);

  // If everything merged into 1 big cluster and we have >= 4 songs, split by genre/artist
  // so the user gets 2-4 distinct Daily Mixes.
  if (clusters.length === 1 && songs.length >= 4) {
    const bySubKey = new Map<string, Child[]>();
    for (const s of songs) {
      const key = (s.genre?.trim() || s.artist?.trim() || s.id).toLowerCase();
      const bucket = bySubKey.get(key) ?? [];
      bucket.push(s);
      bySubKey.set(key, bucket);
    }
    const subClusters = Array.from(bySubKey.values()).sort((a, b) => b.length - a.length);
    if (subClusters.length >= 2) {
      clusters = subClusters;
    } else {
      const mid = Math.ceil(songs.length / 2);
      clusters = [songs.slice(0, mid), songs.slice(mid)];
    }
  }

  // Cap at 4 clusters (folding tiny remainder groups into the last cluster if needed)
  if (clusters.length > DAILY_MIX_MAX_CLUSTERS) {
    const top = clusters.slice(0, DAILY_MIX_MAX_CLUSTERS);
    const rest = clusters.slice(DAILY_MIX_MAX_CLUSTERS).flat();
    // Spread small remainders round-robin only if top clusters are small, or keep top 4 focused
    for (let i = 0; i < rest.length; i++) {
      if (top[i % DAILY_MIX_MAX_CLUSTERS].length < 4) {
        top[i % DAILY_MIX_MAX_CLUSTERS].push(rest[i]);
      }
    }
    clusters = top;
  }

  return clusters.map((clusterSongs, idx) => {
    const num = idx + 1;
    const artists = Array.from(
      new Set(
        clusterSongs
          .map((s) => s.artist?.trim())
          .filter((a): a is string => Boolean(a)),
      ),
    ).slice(0, 3);
    const genres = Array.from(
      new Set(
        clusterSongs
          .map((s) => s.genre?.trim())
          .filter((g): g is string => Boolean(g)),
      ),
    ).slice(0, 2);

    const subtitle =
      artists.length > 0
        ? artists.join(', ')
        : genres.length > 0
          ? genres.join(' · ')
          : translateWithFallback('onRepeat', 'On Repeat');

    return {
      mixKey: `daily-mix-${num}`,
      mixType: 'daily_mix',
      title: translateWithFallback('dailyMixTitle', `Daily Mix ${num}`, { index: num }),
      subtitle,
      seedSongs: clusterSongs.slice(0, 3),
      clusterSongs,
    };
  });
}

async function buildAllDynamicMixDescriptors(
  db: InternalDb,
): Promise<DynamicMixDescriptor[]> {
  const [onRepeat, daylist, forgottenGems] = await Promise.all([
    getOnRepeat(40),
    getHourlyDaylist(25),
    getForgottenGems(15),
  ]);

  const descriptors: DynamicMixDescriptor[] = [];

  const dailyMixes = await buildDailyMixDescriptors(db, onRepeat);
  descriptors.push(...dailyMixes);

  if (daylist && daylist.songs.length > 0) {
    descriptors.push({
      mixKey: 'daylist',
      mixType: 'daylist',
      title: daylist.title,
      subtitle: daylist.subtitle,
      seedSongs: daylist.songs.slice(0, 3),
      clusterSongs: daylist.songs,
    });
  }

  if (onRepeat.length > 0 && forgottenGems.length > 0) {
    const startSeed = onRepeat[0];
    const endSeed = forgottenGems.find((g) => g.id !== startSeed.id);
    if (startSeed && endSeed) {
      descriptors.push({
        mixKey: 'rediscovery-bridge',
        mixType: 'rediscovery_bridge',
        title: translateWithFallback('rediscoveryBridgeTitle', 'Rediscovery Bridge'),
        subtitle: translateWithFallback(
          'rediscoveryBridgeSubtitle',
          `${startSeed.artist ?? startSeed.title} → ${endSeed.artist ?? endSeed.title}`,
          {
            from: startSeed.artist ?? startSeed.title,
            to: endSeed.artist ?? endSeed.title,
          },
        ),
        seedSongs: [startSeed, endSeed],
        clusterSongs: [startSeed],
        bridgeEndSong: endSeed,
      });
    }
  }

  return descriptors;
}

/**
 * 0 ms Home summary reader: returns cached and/or locally derived dynamic mix
 * card definitions purely from SQLite, with zero network calls.
 */
export async function getDynamicMixSummaries(): Promise<DynamicMixSummary[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const [cachedRows, descriptors] = await Promise.all([
      db.getAllAsync<DynamicMixCacheRow>(
        `SELECT mix_key, mix_type, title, subtitle, seed_ids_json, song_ids_json, source, updated_at, expires_at
           FROM dynamic_mix_cache`,
      ),
      buildAllDynamicMixDescriptors(db),
    ]);

    const cachedByKey = new Map<string, DynamicMixCacheRow>();
    for (const row of cachedRows ?? []) {
      if (row?.mix_key) cachedByKey.set(row.mix_key, row);
    }

    const summaries: DynamicMixSummary[] = [];
    const seenKeys = new Set<string>();

    for (const desc of descriptors) {
      seenKeys.add(desc.mixKey);
      const cached = cachedByKey.get(desc.mixKey);
      const cachedSongIds = safeParseStringArray(cached?.song_ids_json);
      const cachedSeedIds = safeParseStringArray(cached?.seed_ids_json);
      const source: DynamicMixSource =
        cached?.source === 'sonic' ? 'sonic' : 'local';

      summaries.push({
        mixKey: desc.mixKey,
        mixType: desc.mixType,
        title:
          desc.mixType === 'daylist'
            ? desc.title
            : cached?.title || desc.title,
        subtitle:
          desc.mixType === 'daylist'
            ? desc.subtitle
            : cached?.subtitle || desc.subtitle,
        seedIds:
          cachedSeedIds.length > 0
            ? cachedSeedIds
            : desc.seedSongs.map((s) => s.id),
        source,
        songCount:
          cachedSongIds.length > 0
            ? cachedSongIds.length
            : desc.clusterSongs.length,
        updatedAt: cached?.updated_at ?? null,
        expiresAt: cached?.expires_at ?? null,
        isCached: Boolean(cached && cachedSongIds.length > 0),
      });
    }

    // Include any cached mixes whose seeds might not currently appear in derived descriptors
    for (const row of cachedRows ?? []) {
      if (!row?.mix_key || seenKeys.has(row.mix_key)) continue;
      const songIds = safeParseStringArray(row.song_ids_json);
      if (songIds.length === 0) continue;
      const mixType: DynamicMixType =
        row.mix_type === 'daylist' || row.mix_type === 'rediscovery_bridge'
          ? row.mix_type
          : 'daily_mix';
      summaries.push({
        mixKey: row.mix_key,
        mixType,
        title: row.title || row.mix_key,
        subtitle: row.subtitle || '',
        seedIds: safeParseStringArray(row.seed_ids_json),
        source: row.source === 'sonic' ? 'sonic' : 'local',
        songCount: songIds.length,
        updatedAt: row.updated_at ?? null,
        expiresAt: row.expires_at ?? null,
        isCached: true,
      });
    }

    return summaries;
  } catch {
    return [];
  }
}

async function resolveMixViaSonic(
  desc: DynamicMixDescriptor,
  targetCount: number,
): Promise<Child[]> {
  if (desc.mixType === 'rediscovery_bridge') {
    const start = desc.seedSongs[0];
    const end = desc.bridgeEndSong ?? desc.seedSongs[1];
    if (!start?.id || !end?.id || start.id === end.id) return [];
    const path = await findSonicPath(start.id, end.id, 15);
    if (!path || path.length === 0) return [];
    const seen = new Set<string>();
    const out: Child[] = [];
    for (const match of path) {
      const s = match?.song;
      if (!s?.id || seen.has(s.id)) continue;
      if (s.id !== start.id && s.id !== end.id && getMixSkipPenalty(s.id) >= 45) {
        continue;
      }
      seen.add(s.id);
      out.push(s);
    }
    return out.slice(0, targetCount);
  }

  // Daily Mix & Enhanced Hourly Daylist: parallel getSonicSimilarTracks on 2-3 seeds
  const seeds = desc.seedSongs.slice(0, 3).filter((s) => Boolean(s?.id));
  if (seeds.length === 0) return [];

  const batches = await Promise.all(
    seeds.map((s) => getSonicSimilarTracks(s.id, 25)),
  );

  const seedIdSet = new Set(desc.clusterSongs.map((s) => s.id));
  const aggregated = new Map<
    string,
    { song: Child; score: number; hitCount: number }
  >();

  for (const batch of batches) {
    for (let i = 0; i < batch.length; i++) {
      const match: SonicTrackMatch | undefined = batch[i];
      const song = match?.song;
      if (!song?.id || seedIdSet.has(song.id)) continue;
      const baseSim =
        match.similarity >= 0
          ? Math.max(0, Math.min(1, match.similarity))
          : Math.max(0.25, 0.85 - i * 0.025);
      const prev = aggregated.get(song.id);
      if (prev) {
        // Boost tracks recurring across multiple cluster seeds
        prev.hitCount += 1;
        prev.score += baseSim + 0.35;
      } else {
        aggregated.set(song.id, { song, score: baseSim, hitCount: 1 });
      }
    }
  }

  if (aggregated.size === 0) return [];

  const rankedDiscovery = Array.from(aggregated.values())
    .map((entry) => {
      const penalty = getMixSkipPenalty(entry.song.id);
      return {
        song: entry.song,
        finalScore: entry.score - penalty / 100,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((e) => e.song);

  // Compose ~30% known cluster tracks + ~70% sonically similar tracks
  const knownCap = Math.min(
    desc.clusterSongs.length,
    Math.max(1, Math.round(targetCount * 0.3)),
  );
  const knownFiltered = desc.clusterSongs
    .filter((s) => getMixSkipPenalty(s.id) < 45)
    .slice(0, knownCap);
  const knownToUse =
    knownFiltered.length > 0 ? knownFiltered : desc.clusterSongs.slice(0, knownCap);

  const seen = new Set<string>(knownToUse.map((s) => s.id));
  const discoveryNeeded = Math.max(0, targetCount - knownToUse.length);
  const discoveryPicked: Child[] = [];
  for (const s of rankedDiscovery) {
    if (discoveryPicked.length >= discoveryNeeded) break;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    discoveryPicked.push(s);
  }

  // Interleave ~30% known and ~70% sonic discoveries smoothly
  const composed: Child[] = [];
  let ki = 0;
  let di = 0;
  while (
    composed.length < targetCount &&
    (ki < knownToUse.length || di < discoveryPicked.length)
  ) {
    if (ki < knownToUse.length) composed.push(knownToUse[ki++]);
    for (let step = 0; step < 2 && di < discoveryPicked.length && composed.length < targetCount; step++) {
      composed.push(discoveryPicked[di++]);
    }
  }
  return composed;
}

async function resolveMixLocally(
  db: InternalDb,
  desc: DynamicMixDescriptor,
  targetCount: number,
  offline: boolean,
): Promise<Child[]> {
  if (desc.mixType === 'daylist') {
    const daylist = await getHourlyDaylist(targetCount);
    if (daylist && daylist.songs.length > 0) {
      return daylist.songs.slice(0, targetCount);
    }
    return desc.clusterSongs.slice(0, targetCount);
  }

  if (desc.mixType === 'rediscovery_bridge') {
    const start = desc.seedSongs[0];
    const end = desc.bridgeEndSong ?? desc.seedSongs[1];
    const [onRepeat, gems] = await Promise.all([
      getOnRepeat(10),
      getForgottenGems(10),
    ]);
    const genres = Array.from(
      new Set([
        ...extractSongGenresLower(start),
        ...(end ? extractSongGenresLower(end) : []),
      ]),
    );
    let midSongs: Child[] = [];
    if (genres.length > 0) {
      const marks = genres.map(() => '?').join(',');
      const rows = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S}
           FROM songs s
          WHERE (LOWER(TRIM(COALESCE(s.genre, ''))) IN (${marks})
             OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(TRIM(sg.name)) IN (${marks})))
            ${offlineSongFilter(offline, 's')}
          ORDER BY COALESCE(s.play_count, 0) DESC, s.id ASC
          LIMIT ?`,
        [...genres, ...genres, targetCount],
      );
      midSongs = await hydrateAndMapSongRows(db, rows);
    }
    const seen = new Set<string>();
    const out: Child[] = [];
    const push = (s: Child | undefined): void => {
      if (!s?.id || seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    };
    push(start);
    for (const m of midSongs.slice(0, Math.max(0, targetCount - 4))) push(m);
    for (const r of onRepeat.slice(1, 3)) push(r);
    for (const g of gems) push(g);
    if (end) push(end);
    return out.slice(0, targetCount);
  }

  // Daily Mix local fallback: cluster seeds + local SQLite genre / playlist co-occurrence
  const knownCap = Math.min(
    desc.clusterSongs.length,
    Math.max(1, Math.round(targetCount * 0.3)),
  );
  const known = desc.clusterSongs.slice(0, knownCap);
  const seen = new Set<string>(known.map((s) => s.id));
  const seedIds = desc.clusterSongs.map((s) => s.id);
  const genres = Array.from(
    new Set(desc.clusterSongs.flatMap((s) => extractSongGenresLower(s))),
  );
  const candidates: Child[] = [];

  if (seedIds.length > 0) {
    const sMarks = seedIds.map(() => '?').join(',');
    const plRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S}
         FROM playlist_songs ps1
         JOIN playlist_songs ps2
           ON ps1.playlist_id = ps2.playlist_id
          AND ps2.song_id NOT IN (${sMarks})
         JOIN songs s ON s.id = ps2.song_id
        WHERE ps1.song_id IN (${sMarks})
          ${offlineSongFilter(offline, 's')}
        GROUP BY s.id
        ORDER BY COUNT(DISTINCT ps1.playlist_id) DESC, COALESCE(s.play_count, 0) DESC
        LIMIT ?`,
      [...seedIds, ...seedIds, targetCount],
    );
    candidates.push(...(await hydrateAndMapSongRows(db, plRows)));
  }

  if (candidates.length < targetCount && genres.length > 0) {
    const gMarks = genres.map(() => '?').join(',');
    const genreRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S}
         FROM songs s
        WHERE (LOWER(TRIM(COALESCE(s.genre, ''))) IN (${gMarks})
           OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(TRIM(sg.name)) IN (${gMarks})))
          ${offlineSongFilter(offline, 's')}
        ORDER BY COALESCE(s.play_count, 0) DESC, s.id ASC
        LIMIT ?`,
      [...genres, ...genres, targetCount * 2],
    );
    candidates.push(...(await hydrateAndMapSongRows(db, genreRows)));
  }

  const extraFiltered = candidates
    .filter((s) => !seen.has(s.id) && getMixSkipPenalty(s.id) < 45)
    .slice(0, Math.max(0, targetCount - known.length));

  const out: Child[] = [...known];
  for (const s of extraFiltered) {
    if (out.length >= targetCount) break;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  for (const s of desc.clusterSongs.slice(knownCap)) {
    if (out.length >= targetCount) break;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out.slice(0, targetCount);
}

/**
 * Lazy-expand a dynamic mix by `mixKey`.
 *
 * Returns a valid non-expired cached entry from `dynamic_mix_cache` if present;
 * otherwise resolves via OpenSubsonic `sonicSimilarity` (with strict 2.5s timeout
 * and `radioSkipStore` penalties) or falls back instantaneously to local SQLite.
 */
export async function resolveDynamicMix(
  mixKey: string,
  options?: ResolveDynamicMixOptions,
): Promise<ResolvedDynamicMix | null> {
  const db = getDb();
  if (!db || !mixKey) return null;

  const now = Date.now();
  const offline = isOfflineMode();
  const ttlMs = options?.ttlMs ?? DEFAULT_DYNAMIC_MIX_TTL_MS;
  const targetCount = Math.max(1, options?.targetCount ?? DEFAULT_DYNAMIC_MIX_TARGET_COUNT);
  const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_DYNAMIC_MIX_TIMEOUT_MS);

  try {
    if (!options?.forceRefresh) {
      const cached = await db.getFirstAsync<DynamicMixCacheRow>(
        `SELECT mix_key, mix_type, title, subtitle, seed_ids_json, song_ids_json, source, updated_at, expires_at
           FROM dynamic_mix_cache
          WHERE mix_key = ?`,
        [mixKey],
      );
      if (
        cached &&
        cached.expires_at != null &&
        cached.expires_at > now
      ) {
        const songIds = safeParseStringArray(cached.song_ids_json);
        const seedIds = safeParseStringArray(cached.seed_ids_json);
        if (songIds.length > 0) {
          const hydrated = await hydrateMixSongsByIds(db, songIds, offline);
          if (hydrated.length > 0) {
            const mixType: DynamicMixType =
              cached.mix_type === 'daylist' || cached.mix_type === 'rediscovery_bridge'
                ? cached.mix_type
                : 'daily_mix';
            return {
              mixKey: cached.mix_key,
              mixType,
              title: cached.title || cached.mix_key,
              subtitle: cached.subtitle || '',
              seedIds,
              songs: hydrated.slice(0, targetCount),
              source: cached.source === 'sonic' ? 'sonic' : 'local',
              updatedAt: cached.updated_at ?? now,
              expiresAt: cached.expires_at,
              fromCache: true,
            };
          }
        }
      }
    }

    const descriptors = await buildAllDynamicMixDescriptors(db);
    const desc = descriptors.find((d) => d.mixKey === mixKey);
    if (!desc) return null;

    let songs: Child[] = [];
    let source: DynamicMixSource = 'local';

    const canUseSonic =
      !offline &&
      isSonicSettingEnabled() &&
      typeof isSonicSimilarityAvailable === 'function' &&
      isSonicSimilarityAvailable();

    if (canUseSonic) {
      try {
        const sonicResult = await withTimeout(
          () => resolveMixViaSonic(desc, targetCount),
          timeoutMs,
        );
        if (sonicResult !== 'timeout' && Array.isArray(sonicResult) && sonicResult.length > 0) {
          songs = sonicResult;
          source = 'sonic';
        }
      } catch {
        // Strict fallback to local SQLite on any network/server error
      }
    }

    if (songs.length === 0) {
      songs = await resolveMixLocally(db, desc, targetCount, offline);
      source = 'local';
    }

    const seedIds = desc.seedSongs.map((s) => s.id);
    const songIds = songs.map((s) => s.id);
    const updatedAt = Date.now();
    const expiresAt = updatedAt + ttlMs;

    await db.runAsync(
      `INSERT OR REPLACE INTO dynamic_mix_cache
         (mix_key, mix_type, title, subtitle, seed_ids_json, song_ids_json, source, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        desc.mixKey,
        desc.mixType,
        desc.title,
        desc.subtitle,
        JSON.stringify(seedIds),
        JSON.stringify(songIds),
        source,
        updatedAt,
        expiresAt,
      ],
    );

    return {
      mixKey: desc.mixKey,
      mixType: desc.mixType,
      title: desc.title,
      subtitle: desc.subtitle,
      seedIds,
      songs,
      source,
      updatedAt,
      expiresAt,
      fromCache: false,
    };
  } catch {
    return null;
  }
}
