import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { getTrackPlayer } from 'react-native-queue-player';
import { playerStore } from '../store/playerStore';
import { favoritesStore } from '../store/favoritesStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { recentPlaysStore, type RecentWidgetItem } from '../store/recentPlaysStore';
import { albumListsStore } from '../store/albumListsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { connectivityStore } from '../store/connectivityStore';
import { getDb } from '../store/persistence/db';
import { listAllStarredSongs, starredItemOf } from '../db/repository/favorites';
import { listDownloadedSongs, downloadedSongRowToChild } from '../db/repository/downloads';
import { fetchAlbumDetail, fetchPlaylistDetail } from './detailFetchService';
import { getPlaylistDetail } from '../db/repository/details';
import { SONG_LIST_COLS, type SongListRow, hydrateSongRows, songListRowToChild } from '../db/repository/songs';
import { musicCacheStore, getSongEnvelope } from '../store/musicCacheStore';
import { playArtistSongs, toggleStar } from './moreOptionsService';
import { resolveDisplayImage } from './imageCacheService';
import { getRandomSongs, type Child } from './subsonicService';
import {
  playTrack,
  shuffleQueue,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
  restorePersistedQueueAfterBoot,
} from './playerService';
import { shuffleArray } from '../utils/arrayHelpers';

const { MusicWidgetModule } = NativeModules;

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Synchronize the React Native state to the native Android SharedPreferences and AppWidget,
 * debounced by 40ms to collapse multiple rapid micro-state changes into a single smooth update.
 */
export function scheduleWidgetSync(): void {
  if (Platform.OS !== 'android' || !MusicWidgetModule) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncWidgetState();
  }, 40);
}

/**
 * Read current player, settings, and favorites state and push to NativeModules.MusicWidgetModule.
 */
export async function syncWidgetState(): Promise<void> {
  if (Platform.OS !== 'android' || !MusicWidgetModule) return;

  try {
    const { currentTrack, playbackState, queueLoading, retrying } = playerStore.getState();
    const { songIds, overrides } = favoritesStore.getState();
    const { widgetTheme, widgetShuffleMode } = playbackSettingsStore.getState();
    const { recentItems } = recentPlaysStore.getState();

    // Signal loading to widget when queue is actively loading
    const isLoading = Boolean(queueLoading) || Boolean(retrying && !currentTrack);

    const isStarred = currentTrack
      ? currentTrack.id in overrides
        ? overrides[currentTrack.id]
        : songIds.has(currentTrack.id)
      : false;

    let coverUri = '';
    if (currentTrack?.coverArt) {
      const resolved = await resolveDisplayImage(currentTrack.coverArt, 300, { offline: false });
      if (resolved?.uri) {
        coverUri = resolved.uri;
      }
    }

    // Build suggested/recent items: start with recorded recent items
    const rawRecents = recentItems ?? [];
    const effectiveRecents: RecentWidgetItem[] = [...rawRecents];

    // If fewer than 4 recent items, fill remaining slots with suggested albums from albumListsStore
    if (effectiveRecents.length < 4) {
      const { recentlyPlayed, recentlyAdded, frequentlyPlayed, randomSelection } = albumListsStore.getState();
      const candidates = [
        ...recentlyPlayed,
        ...recentlyAdded,
        ...frequentlyPlayed,
        ...randomSelection,
      ];
      for (const alb of candidates) {
        if (effectiveRecents.length >= 4) break;
        if (!effectiveRecents.some((r) => r.id === alb.id)) {
          effectiveRecents.push({
            id: alb.id,
            type: 'album',
            title: alb.name || (alb as any).title || '',
            subtitle: alb.artist || '',
            coverUri: alb.coverArt,
          });
        }
      }
    }

    // Resolve cover URIs for recent/suggested items if needed
    const resolvedRecents = await Promise.all(
      effectiveRecents.slice(0, 4).map(async (item) => {
        // If already a resolved local file or web URL, keep it
        if (
          item.coverUri &&
          (item.coverUri.startsWith('file://') ||
            item.coverUri.startsWith('http://') ||
            item.coverUri.startsWith('https://'))
        ) {
          return item;
        }
        // Otherwise resolve coverArt ID (or item ID) to a real authenticated URL or local cache file URI
        const artId = item.coverUri || item.id;
        const res = await resolveDisplayImage(artId, 200, { offline: false });
        return {
          ...item,
          coverUri: res?.uri ?? '',
        };
      })
    );

    MusicWidgetModule.updateWidgetState({
      trackId: currentTrack?.id ?? '',
      title: currentTrack?.title ?? '',
      artist: currentTrack?.artist ?? '',
      album: currentTrack?.album ?? '',
      coverUri,
      isPlaying: playbackState === 'playing' || playbackState === 'buffering',
      isLoading,
      isStarred,
      isShuffleActive: false,
      widgetTheme,
      widgetShuffleMode,
      recentItems: JSON.stringify(resolvedRecents),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[widgetSyncService] syncWidgetState failed:', e);
  }
}

/**
 * Execute shuffle according to user widget settings with "Play-First, Fetch-Later" pattern.
 */
async function executeShuffle(): Promise<void> {
  const isOffline =
    offlineModeStore.getState().offlineMode ||
    !connectivityStore.getState().hasConnection ||
    !connectivityStore.getState().isServerReachable;

  const mode = isOffline ? 'downloaded' : playbackSettingsStore.getState().widgetShuffleMode;

  if (mode === 'toggle_queue') {
    const queue = playerStore.getState().queue;
    if (queue.length >= 2) {
      await shuffleQueue();
      return;
    }
  }

  if (mode === 'starred') {
    const db = getDb();
    if (db) {
      try {
        const starred = (await listAllStarredSongs(db, { downloadedOnly: isOffline })).map(starredItemOf);
        if (starred.length > 0) {
          const shuffled = shuffleArray(starred);
          await playTrack(shuffled[0], shuffled);
          return;
        }
      } catch {
        // Fallback to downloaded
      }
    }
  }

  if (mode === 'all_songs' && !isOffline) {
    try {
      const songs = await getRandomSongs(50);
      if (songs && songs.length > 0) {
        await playTrack(songs[0], songs);
        return;
      }
    } catch {
      // Fallback to downloaded
    }
  }

  // Fallback: shuffle downloaded songs
  const db = getDb();
  if (db) {
    try {
      const rows = await listDownloadedSongs(db);
      const songs = rows.map(downloadedSongRowToChild);
      if (songs.length > 0) {
        const shuffled = shuffleArray(songs);
        await playTrack(shuffled[0], shuffled);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[widgetSyncService] playDownloadedRandom failed:', e);
    }
  }
}

/**
 * Play a recent item (album, playlist, artist, or song) tapped from the widget.
 * Ultra-resilient: probes offline cache -> online detail -> local DB fallback -> artist fallback -> shuffle.
 */
async function playRecentItem(
  id: string,
  type: string,
  title?: string,
  subtitle?: string,
): Promise<void> {
  try {
    // 1. First probe offline downloads / cached music items
    const cacheState = musicCacheStore.getState();
    const cachedItem =
      cacheState.cachedItems[id] ??
      cacheState.cachedItems[`${type}:${id}`] ??
      cacheState.cachedItems[`album:${id}`] ??
      cacheState.cachedItems[`playlist:${id}`];

    if (cachedItem && cachedItem.songIds?.length > 0) {
      const songs = cachedItem.songIds
        .map((sId) => getSongEnvelope(sId))
        .filter((s): s is Child => s !== null);
      if (songs.length > 0) {
        await playTrack(songs[0], songs, id);
        return;
      }
    }

    // 2. Check if id itself is a cached/downloaded single song
    const singleCachedSong = getSongEnvelope(id);
    if (singleCachedSong) {
      await playTrack(singleCachedSong, [singleCachedSong]);
      return;
    }

    // 3. Album flow
    if (type === 'album') {
      const album = await fetchAlbumDetail(id);
      if (album?.song && album.song.length > 0) {
        await playTrack(album.song[0], album.song, id);
        return;
      }

      // Local DB fallback: query songs with album_id or matching album title
      const db = getDb();
      if (db) {
        try {
          const rows = await db.getAllAsync<SongListRow>(
            `SELECT ${SONG_LIST_COLS} FROM songs WHERE album_id = ? OR (album = ? AND album != '') ORDER BY disc_number, track, sort_title`,
            [id, title ?? ''],
          );
          if (rows && rows.length > 0) {
            await hydrateSongRows(db, rows);
            const songs = rows.map(songListRowToChild);
            if (songs.length > 0) {
              await playTrack(songs[0], songs, id);
              return;
            }
          }
        } catch {
          // non-critical
        }
      }

      // If album lookup failed but we have artist name in subtitle, try artist songs
      if (subtitle) {
        await playArtistSongs(id, false, subtitle);
        const q = playerStore.getState().queue;
        if (q.length > 0) return;
      }
    }

    // 4. Playlist flow
    if (type === 'playlist') {
      const playlist = await fetchPlaylistDetail(id);
      if (playlist?.entry && playlist.entry.length > 0) {
        await playTrack(playlist.entry[0], playlist.entry, id);
        return;
      }

      const db = getDb();
      if (db) {
        try {
          const d = await getPlaylistDetail(db, id);
          if (d && d.entry && d.entry.length > 0) {
            await playTrack(d.entry[0], d.entry, id);
            return;
          }
        } catch {
          // non-critical
        }
      }
    }

    // 5. Artist flow
    if (type === 'artist') {
      await playArtistSongs(id, false, title);
      const q = playerStore.getState().queue;
      if (q.length > 0) return;
    }

    // 6. Single song flow
    if (type === 'song') {
      const db = getDb();
      if (db) {
        try {
          const row = await db.getFirstAsync<SongListRow>(
            `SELECT ${SONG_LIST_COLS} FROM songs WHERE id = ?`,
            [id],
          );
          if (row) {
            await hydrateSongRows(db, [row]);
            const song = songListRowToChild(row);
            await playTrack(song, [song]);
            return;
          }
        } catch {
          // non-critical
        }
      }
    }

    // 7. Resilient fallback: title could be artist or album
    if (title) {
      await playArtistSongs(id, false, title);
      const q = playerStore.getState().queue;
      if (q.length > 0) return;
    }

    // 8. If absolutely nothing else worked, start shuffle
    await executeShuffle();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[widgetSyncService] playRecentItem failed for ${type} ${id}:`, e);
    await executeShuffle();
  }
}

/**
 * Handle direct actions dispatched from Android widget PendingIntents.
 */
export async function handleWidgetAction(action: string, extras?: Record<string, any>): Promise<void> {
  switch (action) {
    case 'com.resubstreamer.widget.ACTION_PLAY_PAUSE': {
      const { currentTrack, playbackState, queue } = playerStore.getState();
      if (playbackState === 'playing' || playbackState === 'buffering') {
        await getTrackPlayer().pause();
      } else if (currentTrack && queue.length > 0) {
        await getTrackPlayer().play();
      } else {
        restorePersistedQueueAfterBoot();
        const stateAfter = playerStore.getState();
        if (stateAfter.currentTrack && stateAfter.queue.length > 0) {
          await getTrackPlayer().play();
        } else {
          await executeShuffle();
        }
      }
      break;
    }
    case 'com.resubstreamer.widget.ACTION_NEXT': {
      await skipToNext();
      break;
    }
    case 'com.resubstreamer.widget.ACTION_PREV': {
      await skipToPrevious();
      break;
    }
    case 'com.resubstreamer.widget.ACTION_STAR': {
      const currentTrack = playerStore.getState().currentTrack;
      if (currentTrack) {
        await toggleStar('song', currentTrack.id);
      }
      break;
    }
    case 'com.resubstreamer.widget.ACTION_SHUFFLE': {
      await executeShuffle();
      break;
    }
    case 'com.resubstreamer.widget.ACTION_PLAY_RECENT': {
      const recentId = extras?.recentId;
      const recentType = extras?.recentType;
      const recentTitle = extras?.recentTitle;
      const recentSubtitle = extras?.recentSubtitle;
      if (recentId && recentType) {
        await playRecentItem(recentId, recentType, recentTitle, recentSubtitle);
      }
      break;
    }
    default:
      break;
  }

  try {
    await syncWidgetState();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[widgetSyncService] handleWidgetAction post-sync failed:', e);
  }
}

let isInitialized = false;

/**
 * Initialize widget listeners and subscriptions.
 */
export function initWidgetSyncService(): () => void {
  if (Platform.OS !== 'android' || !MusicWidgetModule || isInitialized) {
    return () => { };
  }
  isInitialized = true;

  // Listen to interactive actions sent while ReactContext is active
  const sub = DeviceEventEmitter.addListener('onWidgetAction', (data) => {
    if (data?.action) {
      void handleWidgetAction(data.action, data);
    }
  });

  // Subscribe to relevant state stores
  const unsubPlayer = playerStore.subscribe((state, prev) => {
    if (
      state.currentTrack !== prev.currentTrack ||
      state.playbackState !== prev.playbackState ||
      state.queueLoading !== prev.queueLoading ||
      state.retrying !== prev.retrying
    ) {
      scheduleWidgetSync();
    }
  });

  const unsubFavorites = favoritesStore.subscribe(() => {
    scheduleWidgetSync();
  });

  const unsubSettings = playbackSettingsStore.subscribe((state, prev) => {
    if (state.widgetTheme !== prev.widgetTheme || state.widgetShuffleMode !== prev.widgetShuffleMode) {
      scheduleWidgetSync();
    }
  });

  const unsubRecents = recentPlaysStore.subscribe((state, prev) => {
    if (state.recentItems !== prev.recentItems) {
      scheduleWidgetSync();
    }
  });

  scheduleWidgetSync();

  return () => {
    sub.remove();
    unsubPlayer();
    unsubFavorites();
    unsubSettings();
    unsubRecents();
    isInitialized = false;
  };
}

