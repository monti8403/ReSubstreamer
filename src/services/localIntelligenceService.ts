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
