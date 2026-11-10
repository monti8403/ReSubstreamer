import type { Child } from 'subsonic-api';

import { getDb } from '@/store/persistence/db';
import { normalize } from '@/services/searchMatch';
import { search3 } from '@/services/subsonicService';
import { offlineModeStore } from '@/store/offlineModeStore';

export interface TrackArtistItem {
  id?: string;
  name: string;
}

/**
 * Extracts all artists from a track.
 *
 * 1. Checks structured OpenSubsonic `track.artists` if present with multiple entries.
 * 2. Otherwise splits `track.artist` (or first entry of `track.artists`) on common
 *    featuring delimiters: `/`, `;`, `,`, and `feat.` / `ft.` / `featuring`.
 * 3. Inspects `track.title` for `(feat. ...)` or `[feat. ...]` to capture any featured
 *    artists not already listed in the artist string.
 * 4. Deduplicates artist names case-insensitively while preserving primary `artistId`.
 */
export function parseTrackArtists(track: Child | null | undefined): TrackArtistItem[] {
  if (!track) return [];

  const items: TrackArtistItem[] = [];
  const seen = new Set<string>();

  const addArtist = (name: string | undefined | null, id?: string) => {
    if (!name) return;
    const trimmed = name.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      if (id) {
        const existing = items.find((it) => it.name.toLowerCase() === lower);
        if (existing && !existing.id) {
          existing.id = id;
        }
      }
      return;
    }
    seen.add(lower);
    items.push({ id: id || undefined, name: trimmed });
  };

  // 1. OpenSubsonic structured artists array with > 1 entries
  if (Array.isArray(track.artists) && track.artists.length > 1) {
    for (const a of track.artists) {
      if (a?.name) {
        addArtist(a.name, a.id);
      }
    }
    if (items.length > 1) {
      return items;
    }
  }

  // 2. Split string on / ; , and feat./ft./featuring
  const artistStr = track.artist || (track.artists && track.artists[0]?.name) || '';
  const primaryId = track.artistId || (track.artists && track.artists[0]?.id);

  const splitParts = artistStr
    ? artistStr
        .split(/\s*[/;]\s*|\s*,\s*|\s+(?:feat\.|ft\.|featuring)\s+/i)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (splitParts.length > 0) {
    addArtist(splitParts[0], primaryId);
    for (let i = 1; i < splitParts.length; i++) {
      addArtist(splitParts[i]);
    }
  } else if (artistStr) {
    addArtist(artistStr, primaryId);
  }

  // 3. Inspect title for (feat. X) or [feat. X]
  if (track.title) {
    const featMatch = track.title.match(
      /(?:[\(\[]\s*(?:feat\.|ft\.|featuring)\s+([^()\[\]]+)[\)\]])/i,
    );
    if (featMatch && featMatch[1]) {
      const featParts = featMatch[1]
        .split(/\s*[,;&]\s*|\s+and\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const f of featParts) {
        addArtist(f);
      }
    }
  }

  return items;
}

/**
 * Resolves an artist name to their Subsonic artist ID.
 *
 * 1. Queries local SQLite `artists` table (case-insensitive exact match & norm_name).
 * 2. Checks local SQLite `song_artists` and `album_artists` tables.
 * 3. Falls back to online Subsonic `search3` if online.
 */
export async function resolveArtistId(artistName: string): Promise<string | null> {
  const trimmed = artistName.trim();
  if (!trimmed) return null;

  try {
    const db = getDb();
    if (db) {
      // 1. Exact case-insensitive match on artists table
      const exactRow = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1',
        [trimmed],
      );
      if (exactRow?.id) return exactRow.id;

      // 2. Normalized match on artists table
      const norm = normalize(trimmed);
      if (norm) {
        const normRow = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM artists WHERE norm_name = ? LIMIT 1',
          [norm],
        );
        if (normRow?.id) return normRow.id;
      }

      // 3. Match in song_artists or album_artists table
      const songArtistRow = await db.getFirstAsync<{ artist_id: string }>(
        'SELECT artist_id FROM song_artists WHERE LOWER(artist_name) = LOWER(?) AND artist_id IS NOT NULL LIMIT 1',
        [trimmed],
      );
      if (songArtistRow?.artist_id) return songArtistRow.artist_id;

      const albumArtistRow = await db.getFirstAsync<{ artist_id: string }>(
        'SELECT artist_id FROM album_artists WHERE LOWER(artist_name) = LOWER(?) AND artist_id IS NOT NULL LIMIT 1',
        [trimmed],
      );
      if (albumArtistRow?.artist_id) return albumArtistRow.artist_id;
    }
  } catch {
    // Database query failed or table unavailable, proceed to online fallback
  }

  // 4. Online fallback via search3
  const offline = offlineModeStore.getState().offlineMode;
  if (!offline) {
    try {
      const results = await search3(trimmed);
      if (results.artists && results.artists.length > 0) {
        const match =
          results.artists.find(
            (a) => a.name.toLowerCase() === trimmed.toLowerCase(),
          ) ?? results.artists[0];
        if (match?.id) return match.id;
      }
    } catch {
      // Best-effort online resolution failed
    }
  }

  return null;
}

