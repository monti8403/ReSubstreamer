/**
 * Centralised "more options" actions used by swipe gestures, long-press
 * menus, and the more-options bottom sheet.
 *
 * Keeps star/queue logic in one place so row and card components stay thin.
 */

import i18n from '../i18n/i18n';
import { fetchArtistBase, fetchArtistTopSongs } from './detailFetchService';
import { favoritesStore } from '../store/favoritesStore';
import { getSongEnvelope, musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { refreshPlaylistLibrary } from './normalizedLibrarySync';
import { getDb } from '../store/persistence/db';
import { getAlbumDetail, getArtistBase, getArtistTopSongsRow, getPlaylistDetail } from '../db/repository/details';
import { processingOverlayStore } from '../store/processingOverlayStore';
import { playerStore } from '../store/playerStore';
import { shuffleArray } from '../utils/arrayHelpers';
import { runPool } from '../utils/promisePool';
import {
  deleteCachedItem as deleteCachedItemService,
  enqueueSongDownload as enqueueSongDownloadService,
  removeCachedAlbumSong as removeCachedAlbumSongService,
} from './musicCacheService';
import {
  addSongToUserQueue,
  addTracksToUserQueue,
  addToQueue,
  moveQueueItemToPlayNext as _moveQueueItemToPlayNext,
  moveQueueItemToUserQueue as _moveQueueItemToUserQueue,
  playSongNext,
  playTrack,
  removeFromQueue,
  reorderQueue as _reorderQueue,
} from './playerService';
import {
  onManualQueueStart,
  registerQueuedTracks,
  setRadioSeedLoading,
} from './autoplayController';
import { getSmartRadioTracks } from './smartRadioService';
import {
  createNewPlaylist,
  getAlbum,
  getPlaylist,
  getSimilarSongs2,
  getTopSongs,
  starAlbum,
  starArtist,
  starSong,
  unstarAlbum,
  unstarArtist,
  unstarSong,
  type AlbumID3,
  type ArtistID3,
  type Child,
  type Playlist,
} from './subsonicService';

/* ------------------------------------------------------------------ */
/*  Star / Unstar                                                      */
/* ------------------------------------------------------------------ */

type StarrableType = 'song' | 'album' | 'artist';

/**
 * Toggle the starred (favorite) state for an item and refresh the
 * favorites store so all views stay in sync.
 *
 * Reads current starred state from `favoritesStore` (the single source of
 * truth) and applies an optimistic override for instant UI feedback before
 * the server round-trip completes.
 *
 * Returns the new starred state (`true` = now starred).
 */
export async function toggleStar(
  type: StarrableType,
  id: string,
): Promise<boolean> {
  const state = favoritesStore.getState();

  const currentlyStarred = (() => {
    if (id in state.overrides) return state.overrides[id];
    switch (type) {
      case 'song':
        return state.songIds.has(id);
      case 'album':
        return state.albumIds.has(id);
      case 'artist':
        return state.artistIds.has(id);
    }
  })();

  const starred = !currentlyStarred;

  // Optimistic update – UI reflects the change immediately
  state.setOverride(id, starred);

  try {
    switch (type) {
      case 'song':
        if (starred) await starSong(id);
        else await unstarSong(id);
        break;
      case 'album':
        if (starred) await starAlbum(id);
        else await unstarAlbum(id);
        break;
      case 'artist':
        if (starred) await starArtist(id);
        else await unstarArtist(id);
        break;
    }

    // Refresh from server (clears overrides on success)
    favoritesStore.getState().fetchStarred();
  } catch {
    // Revert optimistic update on failure
    state.setOverride(id, currentlyStarred);
  }

  return starred;
}

/* ------------------------------------------------------------------ */
/*  Queue management                                                   */
/* ------------------------------------------------------------------ */

/**
 * Add a single song / track to the user play queue (plays next or after existing queued tracks).
 */
export async function addSongToQueue(song: Child): Promise<void> {
  await addSongToUserQueue(song);
}

/**
 * Insert a single song right after the currently-playing track so it
 * plays next without disturbing what's playing now. Falls back to
 * starting fresh playback when the queue is empty.
 */
export async function playSongNextInQueue(song: Child): Promise<void> {
  await playSongNext(song);
}

/**
 * Add every song from an album to the user play queue (Spotify-style).
 * Uses cached album data when available, otherwise fetches from the API.
 */
export async function addAlbumToQueue(album: AlbumID3): Promise<void> {
  const db = getDb();
  let songs: Child[] | undefined = db ? (await getAlbumDetail(db, album.id))?.songs : undefined;
  if (!songs?.length) {
    const full = await getAlbum(album.id);
    songs = full?.song;
  }
  if (!songs?.length) return;
  await addTracksToUserQueue(songs);
}

/**
 * Add every song from a playlist to the user play queue (Spotify-style).
 * Uses cached playlist data when available, otherwise fetches from the API.
 */
export async function addPlaylistToQueue(playlist: Playlist): Promise<void> {
  const db = getDb();
  let entries: Child[] | undefined = db
    ? (await getPlaylistDetail(db, playlist.id))?.entry
    : undefined;
  if (!entries?.length) {
    const full = await getPlaylist(playlist.id);
    entries = full?.entry;
  }
  if (!entries?.length) return;
  await addTracksToUserQueue(entries);
}

/**
 * Remove a track from the play queue by its index.
 */
export async function removeItemFromQueue(index: number): Promise<void> {
  await removeFromQueue(index);
}

/**
 * Move a queue item to immediately after the currently playing track ("Play Next").
 */
export async function moveQueueItemToPlayNext(index: number): Promise<void> {
  await _moveQueueItemToPlayNext(index);
}

/**
 * Move a queue item from "Next Up" to the user queue ("Aggiungi alla coda").
 */
export async function moveQueueItemToUserQueue(index: number): Promise<void> {
  await _moveQueueItemToUserQueue(index);
}

/**
 * Reorder a queue item from fromIndex to toIndex.
 */
export async function reorderQueue(
  fromIndex: number,
  toIndex: number,
  explicitUserQueueTrackIds?: string[],
): Promise<void> {
  await _reorderQueue(fromIndex, toIndex, explicitUserQueueTrackIds);
}

/* ------------------------------------------------------------------ */
/*  Play more like this                                                */
/* ------------------------------------------------------------------ */

/**
 * Fetch similar songs for a given track via `smartRadioService` and append
 * them to the play queue.
 * Implements the Spotify "Play-First, Fetch-Later" pattern:
 * 1. Plays the tapped song immediately (zero perceived latency, no blocking overlay).
 * 2. Fetches smart-radio tracks in the background.
 * 3. Race Condition Guard: silently drops results if the user switched songs before the fetch finished.
 * 4. Registers queued tracks in `autoplayController` and appends via `addToQueue(tracks)`.
 */
export async function playMoreLikeThis(
  song: Child,
  options?: { downloadedOnly?: boolean },
): Promise<void> {
  setRadioSeedLoading(true);
  let playFailed = false;
  const playPromise = playTrack(song, [song]).catch(() => {
    playFailed = true;
  });
  onManualQueueStart(song, [song]);

  const target = layoutPreferencesStore.getState().listLength || 20;

  const backgroundPromise = (async () => {
    try {
      const tracks = await getSmartRadioTracks({
        seedSongs: [song],
        targetCount: target,
        excludeIds: new Set([song.id]),
        downloadedOnly: options?.downloadedOnly,
        randomize: true,
      });

      await playPromise;
      if (playFailed) return;

      // Race condition guard: verify the user is still playing the song that triggered this queue
      const currentTrack = playerStore.getState().currentTrack;
      if (currentTrack?.id !== song.id) {
        return;
      }

      if (!tracks || tracks.length === 0) return;

      registerQueuedTracks(tracks);
      await addToQueue(tracks);
    } catch {
      // 100% silent in background - the current song continues uninterrupted
    } finally {
      setRadioSeedLoading(false);
    }
  })();

  await backgroundPromise;
}

/* ------------------------------------------------------------------ */
/*  Play mix of similar artists                                        */
/* ------------------------------------------------------------------ */

function sortArtistSongsChronologically(songs: Child[]): Child[] {
  return [...songs].sort((a, b) => {
    const yearDiff = (a.year ?? 0) - (b.year ?? 0);
    if (yearDiff !== 0) return yearDiff;
    const discDiff = (a.discNumber ?? 1) - (b.discNumber ?? 1);
    if (discDiff !== 0) return discDiff;
    return (a.track ?? 0) - (b.track ?? 0);
  });
}

/**
 * Fetch similar songs for a given artist (mix of similar artists) and set them as the play queue.
 */
export async function playSimilarArtistsMix(artist: ArtistID3): Promise<void> {
  try {
    const tracks = await getSimilarSongs2(artist.id, layoutPreferencesStore.getState().listLength);
    if (tracks.length === 0) {
      processingOverlayStore.getState().showError(i18n.t('noSimilarArtistsMixAvailable'));
      return;
    }

    await playTrack(tracks[0], tracks);
  } catch {
    processingOverlayStore.getState().showError(i18n.t('failedToLoadSimilarArtistsMix'));
  }
}

/* ------------------------------------------------------------------ */
/*  Artist top songs playlist                                          */
/* ------------------------------------------------------------------ */

/**
 * Create a new playlist from an artist's top songs.
 * Uses cached data when available, otherwise fetches artist detail.
 * Refreshes playlist library on success.
 */
export async function saveArtistTopSongsPlaylist(artist: ArtistID3): Promise<void> {
  try {
    // Local-first inside the fetcher: this only hits the server on a genuine miss.
    const topSongs = (await fetchArtistTopSongs(artist.id))?.songs ?? [];

    if (topSongs.length === 0) {
      processingOverlayStore.getState().showError(i18n.t('noTopSongsAvailable'));
      return;
    }

    const songIds = topSongs.map((s) => s.id);
    const success = await createNewPlaylist(`${artist.name} Top Songs`, songIds);
    if (!success) {
      processingOverlayStore.getState().showError(i18n.t('failedToCreatePlaylist'));
      return;
    }

    await refreshPlaylistLibrary();
  } catch {
    processingOverlayStore.getState().showError(i18n.t('failedToCreatePlaylist'));
  }
}

/* ------------------------------------------------------------------ */
/*  Play more by this artist                                           */
/* ------------------------------------------------------------------ */

const MORE_BY_ARTIST_MIN = 5;

/**
 * Fetch all songs by an artist across all albums.
 * Online: walks every album in the artist detail, fetches songs, filters by artist.
 * Offline: scans cached music items for matching tracks.
 * Returns `null` with an error toast if no songs are found.
 */
async function fetchAllArtistSongs(
  artistId: string,
  artistName: string,
): Promise<Child[] | null> {
  const offline = offlineModeStore.getState().offlineMode;

  if (offline) {
    const state = musicCacheStore.getState();
    const items = Object.values(state.cachedItems);
    // Match on the row (cheap) and build the full `Child` only for the hits.
    // `album`/`coverArt` keep coming from the containing item, as they always have.
    const songs = items.flatMap((item) =>
      item.songIds.flatMap((id) => {
        if (state.cachedSongs[id]?.artist !== artistName) return [];
        const envelope = getSongEnvelope(id);
        return envelope ? [{ ...envelope, album: item.name, coverArt: item.coverArtId }] : [];
      }),
    );

    if (songs.length === 0) {
      processingOverlayStore.getState().showError(i18n.t('noOfflineSongsByArtist', { artist: artistName }));
      return null;
    }
    return songs;
  }

  // Local-first inside the fetcher: only hits the server when we don't hold the albums.
  const db = getDb();
  const artistBase = await fetchArtistBase(artistId);
  const albums = artistBase?.albums;
  const effectiveArtistName = artistName || artistBase?.artist?.name || '';
  if (!albums?.length) {
    if (effectiveArtistName) {
      const top = await getTopSongs(effectiveArtistName, 50);
      if (top && top.length > 0) return top;
    }
    processingOverlayStore.getState().showError(i18n.t('noSongsFoundByArtist', { artist: effectiveArtistName }));
    return null;
  }

  // Fetch songs from each album (normalized detail where available, else server),
  // bounded to concurrency 4 to avoid HTTP connection spikes on large discographies.
  const byAlbumId = new Map<string, Child[]>();
  const { fulfilled } = await runPool(
    albums,
    async (album) => {
      const cached = db ? await getAlbumDetail(db, album.id) : null;
      if (cached) return cached.songs;
      const fetched = await getAlbum(album.id);
      return fetched?.song ?? [];
    },
    { concurrency: 4 },
  );
  for (const { item, value } of fulfilled) {
    byAlbumId.set(item.id, value);
  }
  const albumSongs = albums.map((album) => byAlbumId.get(album.id) ?? []);

  // Flatten and filter to only this artist's songs (handles compilations)
  const songs = albumSongs.flat().filter(
    (s) =>
      (s.artistId && s.artistId === artistId) ||
      (effectiveArtistName && s.artist?.toLowerCase() === effectiveArtistName.toLowerCase()),
  );

  const effectiveSongs = songs.length > 0 ? songs : albumSongs.flat();

  if (effectiveSongs.length === 0) {
    processingOverlayStore.getState().showError(i18n.t('noSongsFoundByArtist', { artist: effectiveArtistName }));
    return null;
  }
  return effectiveSongs;
}

/**
 * Build a shuffled queue of songs by a specific artist and start playback.
 * Online: fetches all albums by the artist, collects songs, shuffles.
 * Offline: scans cached music items for matching tracks.
 * Implements "Play-First, Fetch-Later".
 */
export async function playMoreByArtist(
  artistId: string,
  artistName: string,
  initialTracks?: Child[],
): Promise<void> {
  const target = layoutPreferencesStore.getState().listLength;
  let startingTracks = initialTracks && initialTracks.length > 0 ? initialTracks : [];

  if (startingTracks.length === 0) {
    const db = getDb();
    if (db) {
      try {
        const topCached = (await getArtistTopSongsRow(db, artistId))?.songs;
        if (topCached?.length) {
          startingTracks = topCached;
        }
      } catch {
        // non-critical cache miss
      }
    }
  }

  let playedInitialTrackId: string | null = null;
  let playPromise: Promise<void> | null = null;

  if (startingTracks.length > 0) {
    const startQueue = shuffleArray(startingTracks).slice(0, target);
    playedInitialTrackId = startQueue[0].id;
    playPromise = playTrack(startQueue[0], startQueue);
  }

  try {
    const songs = await fetchAllArtistSongs(artistId, artistName);
    if (!songs) return;

    if (songs.length < MORE_BY_ARTIST_MIN) {
      const offline = offlineModeStore.getState().offlineMode;
      const key = offline ? 'notEnoughOfflineSongsByArtist' : 'notEnoughSongsByArtist';
      processingOverlayStore.getState().showError(i18n.t(key, { artist: artistName }));
      return;
    }

    if (playPromise) {
      await playPromise;
      const currentTrack = playerStore.getState().currentTrack;
      if (!currentTrack) return;
      const belongsToArtist =
        currentTrack.artistId === artistId ||
        currentTrack.artist?.toLowerCase() === artistName.toLowerCase();
      if (!belongsToArtist && currentTrack.id !== playedInitialTrackId) {
        return;
      }

      const currentQueue = playerStore.getState().queue;
      const existingIds = new Set(currentQueue.map((t) => t.id));
      const remaining = songs.filter((s) => !existingIds.has(s.id));

      if (remaining.length > 0 && currentQueue.length < target) {
        const needed = target - currentQueue.length;
        const toAdd = shuffleArray(remaining).slice(0, needed);
        await addToQueue(toAdd);
      }
    } else {
      const queue = shuffleArray(songs).slice(0, target);
      await playTrack(queue[0], queue);
    }
  } catch {
    processingOverlayStore.getState().showError(
      i18n.t('failedToLoadArtistSongs', { artist: artistName }),
    );
  }
}

/**
 * Play all songs by an artist. When shuffle is false, songs are ordered
 * chronologically by album (year → disc → track). No song count cap.
 * Implements "Play-First, Fetch-Later".
 */
export async function playAllByArtist(
  artistId: string,
  artistName: string,
  shuffle: boolean,
  initialTracks?: Child[],
): Promise<void> {
  let startingTracks = initialTracks && initialTracks.length > 0 ? initialTracks : [];

  if (startingTracks.length === 0) {
    const db = getDb();
    if (db) {
      try {
        const topCached = (await getArtistTopSongsRow(db, artistId))?.songs;
        if (topCached?.length) {
          startingTracks = topCached;
        }
      } catch {
        // non-critical cache miss
      }
    }
  }

  let playedInitialTrackId: string | null = null;
  let playPromise: Promise<void> | null = null;

  if (startingTracks.length > 0) {
    const startQueue = shuffle
      ? shuffleArray(startingTracks)
      : sortArtistSongsChronologically(startingTracks);
    playedInitialTrackId = startQueue[0].id;
    playPromise = playTrack(startQueue[0], startQueue);
  }

  try {
    const songs = await fetchAllArtistSongs(artistId, artistName);
    if (!songs || songs.length === 0) return;

    if (playPromise) {
      await playPromise;

      const currentTrack = playerStore.getState().currentTrack;
      if (!currentTrack) return;
      const belongsToArtist =
        currentTrack.artistId === artistId ||
        currentTrack.artist?.toLowerCase() === artistName.toLowerCase();
      if (!belongsToArtist && currentTrack.id !== playedInitialTrackId) {
        return;
      }

      const currentQueue = playerStore.getState().queue;
      const existingIds = new Set(currentQueue.map((t) => t.id));
      const remaining = songs.filter((s) => !existingIds.has(s.id));

      if (remaining.length > 0) {
        const orderedRemaining = shuffle
          ? shuffleArray(remaining)
          : sortArtistSongsChronologically(remaining);
        await addToQueue(orderedRemaining);
      }
    } else {
      const queue = shuffle
        ? shuffleArray(songs)
        : sortArtistSongsChronologically(songs);
      await playTrack(queue[0], queue);
    }
  } catch {
    processingOverlayStore.getState().showError(
      i18n.t('failedToLoadArtistSongs', { artist: artistName }),
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Download management                                                */
/* ------------------------------------------------------------------ */

export {
  enqueueAlbumDownload,
  enqueuePlaylistDownload,
  enqueueSongDownload,
} from './musicCacheService';

export { deleteCachedItem as removeDownload, cancelDownload } from './musicCacheService';

/** Synthetic itemId used for single-song download items. */
export function songItemId(songId: string): string {
  return `song:${songId}`;
}

/**
 * Trigger a single-song download and surface a toast / overlay confirming the
 * action. If the underlying song is already fully pooled, the call still
 * creates the `song:` item edge so the song is visible in the music-cache
 * browser — the service layer handles that short-circuit internally.
 */
export async function handleDownloadSong(song: Child): Promise<void> {
  if (!song?.id) return;
  try {
    await enqueueSongDownloadService(song);
  } catch {
    processingOverlayStore.getState().showError(i18n.t('downloadFailed'));
  }
}

/**
 * Remove a song's download. Covers both ways a song can be cached:
 *   1. A synthetic `song:` item (explicit single-song download).
 *   2. Pooled via its parent album — that album edge is dropped, reverting
 *      the album to a partial download.
 * The service layer refcounts the underlying song and only deletes the file
 * once nothing else references it.
 */
export async function handleRemoveSongDownload(song: Child): Promise<void> {
  if (!song?.id) return;
  try {
    let removed = false;

    // Explicit single-song download edge, if any.
    if (musicCacheStore.getState().cachedItems[songItemId(song.id)]) {
      await deleteCachedItemService(songItemId(song.id));
      removed = true;
    }

    // Pooled via its parent album → drop the album edge (album becomes partial).
    if (song.albumId && (await removeCachedAlbumSongService(song.albumId, song.id))) {
      removed = true;
    }

    if (!removed) {
      processingOverlayStore.getState().showError(i18n.t('failedToLoad'));
    }
  } catch {
    processingOverlayStore.getState().showError(i18n.t('failedToLoad'));
  }
}

/**
 * Convenience entry point to play or shuffle an artist's songs by id.
 */
export async function playArtistSongs(
  artistId: string,
  shuffle: boolean,
  fallbackArtistName?: string,
): Promise<void> {
  const db = getDb();
  let artistName = fallbackArtistName ?? '';
  let startingTracks: Child[] | undefined;
  if (db) {
    try {
      const topCached = await getArtistTopSongsRow(db, artistId);
      if (topCached?.songs?.length) {
        artistName = topCached.songs[0].artist ?? artistName;
        startingTracks = topCached.songs;
      } else {
        const base = await getArtistBase(db, artistId);
        if (base?.artist?.name) {
          artistName = base.artist.name;
        }
      }
    } catch {
      // non-critical
    }
  }
  await playAllByArtist(artistId, artistName, shuffle, startingTracks);
}
