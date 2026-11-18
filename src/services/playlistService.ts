import type { InternalDb } from '../db/client';
import { bumpDetailChanged } from '../db/detailNotifier';
import {
  appendPlaylistSongs,
  getPlaylist,
  listPlaylistSongIds,
} from '../db/repository/playlists';
import { listAlbumSongIds } from '../db/repository/songs';
import type { AddToPlaylistTarget } from '../store/addToPlaylistStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { getDb } from '../store/persistence/db';
import { syncStatusStore } from '../store/syncStatusStore';
import { fetchAlbumDetail, fetchPlaylistDetail } from './detailFetchService';
import { syncCachedItemTracks } from './musicCacheService';
import { addToPlaylist } from './subsonicService';

export interface AddSongsToPlaylistResult {
  success: boolean;
  addedIds: string[];
}

/**
 * Deduplicate song IDs while preserving their original order.
 */
function uniqueSongIds(songIds: readonly string[]): string[] {
  return Array.from(new Set(songIds));
}

/**
 * Resolve target song IDs from in-memory target data or local SQLite without
 * making any HTTP requests. Returns `null` when an album's tracks are not yet
 * cached in SQLite.
 */
export async function resolveLocalTargetSongIds(
  target: AddToPlaylistTarget,
  db: InternalDb | null,
): Promise<string[] | null> {
  if (target.type === 'song') return [target.item.id];
  if (target.type === 'queue') {
    if (target.songs.length === 0) return null;
    return uniqueSongIds(target.songs.map((s) => s.id));
  }
  if (db) {
    const localIds = await listAlbumSongIds(db, target.item.id);
    if (localIds.length > 0) return uniqueSongIds(localIds);
  }
  return null;
}

/**
 * Resolve target song IDs, reading SQLite first and falling back to a single
 * `fetchAlbumDetail` call if an album's tracks are not yet locally cached.
 */
export async function resolveTargetSongIds(
  target: AddToPlaylistTarget,
): Promise<string[] | null> {
  const db = getDb();
  const local = await resolveLocalTargetSongIds(target, db);
  if (local) return local;
  if (target.type !== 'album') return null;

  const full = await fetchAlbumDetail(target.item.id, { prefetchCovers: false });
  const songs = full?.song;
  if (!songs?.length) return null;
  return uniqueSongIds(songs.map((s) => s.id));
}

/**
 * Add songs to an existing playlist while preventing duplicates:
 * 1. Filters `targetSongIds` against songs already present in the playlist.
 * 2. Short-circuits without sending any Subsonic API request if nothing new remains.
 * 3. Immediately updates local SQLite (`playlist_songs` + `playlists.song_count`)
 *    and notifies detail/library listeners after a successful API call.
 */
export async function addSongsToPlaylist(
  playlistId: string,
  targetSongIds: string[],
): Promise<AddSongsToPlaylistResult> {
  const uniqueTargetIds = uniqueSongIds(targetSongIds);
  if (uniqueTargetIds.length === 0) {
    return { success: true, addedIds: [] };
  }

  const db = getDb();
  let existingIds: string[] = [];
  if (db) {
    existingIds = await listPlaylistSongIds(db, playlistId);
    if (existingIds.length === 0) {
      const playlistRow = await getPlaylist(db, playlistId);
      const hasServerSongs = Number(playlistRow?.song_count ?? 0) > 0;
      const neverFetched = playlistRow?.detail_changed == null;
      if (hasServerSongs && neverFetched) {
        const detail = await fetchPlaylistDetail(playlistId, { prefetchCovers: false });
        if (detail?.entry) {
          existingIds = detail.entry.map((s) => s.id);
        }
      }
    }
  }

  const existingSet = new Set(existingIds);
  const songIdsToAdd = uniqueTargetIds.filter((id) => !existingSet.has(id));
  if (songIdsToAdd.length === 0) {
    return { success: true, addedIds: [] };
  }

  const success = await addToPlaylist(playlistId, songIdsToAdd);
  if (!success) {
    return { success: false, addedIds: [] };
  }

  // Only downloaded playlists need a re-fetch here to sync on-disk tracks;
  // non-downloaded playlists update local SQLite immediately so reopening the
  // sheet or playlist detail reflects the newly added songs right away.
  if (playlistId in musicCacheStore.getState().cachedItems) {
    const updated = await fetchPlaylistDetail(playlistId, { force: true });
    if (updated) {
      syncCachedItemTracks(playlistId, updated.entry ?? []);
    } else if (db) {
      await appendPlaylistSongs(db, playlistId, songIdsToAdd);
      bumpDetailChanged('playlist', playlistId);
    }
  } else if (db) {
    await appendPlaylistSongs(db, playlistId, songIdsToAdd);
    bumpDetailChanged('playlist', playlistId);
  }

  syncStatusStore.getState().bumpLibraryUpdated();
  return { success: true, addedIds: songIdsToAdd };
}
