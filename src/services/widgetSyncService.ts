import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { getTrackPlayer } from 'react-native-queue-player';
import { playerStore } from '../store/playerStore';
import { favoritesStore } from '../store/favoritesStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { recentPlaysStore } from '../store/recentPlaysStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { connectivityStore } from '../store/connectivityStore';
import { getDb } from '../store/persistence/db';
import { listAllStarredSongs, starredItemOf } from '../db/repository/favorites';
import { listDownloadedSongs, downloadedSongRowToChild } from '../db/repository/downloads';
import { fetchAlbumDetail, fetchPlaylistDetail } from './detailFetchService';
import { playArtistSongs, toggleStar } from './moreOptionsService';
import { resolveDisplayImage } from './imageCacheService';
import { getRandomSongs } from './subsonicService';
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

/**
 * Immediately synchronize the React Native state to the native
 * Android SharedPreferences and AppWidget.
 * No setTimeout debounce so background/standby threads never delay sync.
 */
export function scheduleWidgetSync(): void {
  if (Platform.OS !== 'android' || !MusicWidgetModule) return;
  void syncWidgetState();
}

/**
 * Read current player, settings, and favorites state and push to NativeModules.MusicWidgetModule.
 */
export async function syncWidgetState(): Promise<void> {
  if (Platform.OS !== 'android' || !MusicWidgetModule) return;

  try {
    const { currentTrack, playbackState } = playerStore.getState();
    const { songIds, overrides } = favoritesStore.getState();
    const { widgetTheme, widgetShuffleMode } = playbackSettingsStore.getState();
    const { recentItems } = recentPlaysStore.getState();

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

    // Resolve cover URIs for recent items if needed
    const resolvedRecents = await Promise.all(
      recentItems.map(async (item) => {
        if (!item.coverUri && item.id) {
          const res = await resolveDisplayImage(item.id, 200, { offline: false });
          if (res?.uri) return { ...item, coverUri: res.uri };
        }
        return item;
      })
    );

    MusicWidgetModule.updateWidgetState({
      trackId: currentTrack?.id ?? '',
      title: currentTrack?.title ?? '',
      artist: currentTrack?.artist ?? '',
      album: currentTrack?.album ?? '',
      coverUri,
      isPlaying: playbackState === 'playing',
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
 * Play a recent item (album, playlist, or artist) tapped from the widget.
 */
async function playRecentItem(id: string, type: string): Promise<void> {
  try {
    if (type === 'album') {
      const album = await fetchAlbumDetail(id);
      if (album?.song && album.song.length > 0) {
        await playTrack(album.song[0], album.song, id);
      }
    } else if (type === 'playlist') {
      const playlist = await fetchPlaylistDetail(id);
      if (playlist?.entry && playlist.entry.length > 0) {
        await playTrack(playlist.entry[0], playlist.entry, id);
      }
    } else if (type === 'artist') {
      await playArtistSongs(id, false);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[widgetSyncService] playRecentItem failed for ${type} ${id}:`, e);
  }
}

/**
 * Handle direct actions dispatched from Android widget PendingIntents.
 */
export async function handleWidgetAction(action: string, extras?: Record<string, any>): Promise<void> {
  switch (action) {
    case 'com.resubstreamer.widget.ACTION_PLAY_PAUSE': {
      const { currentTrack, playbackState, queue } = playerStore.getState();
      if (playbackState === 'playing') {
        await getTrackPlayer().pause();
      } else if (currentTrack && queue.length > 0) {
        await togglePlayPause();
      } else {
        restorePersistedQueueAfterBoot();
        const stateAfter = playerStore.getState();
        if (stateAfter.currentTrack && stateAfter.queue.length > 0) {
          await togglePlayPause();
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
      if (recentId && recentType) {
        await playRecentItem(recentId, recentType);
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
    return () => {};
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
    if (state.currentTrack !== prev.currentTrack || state.playbackState !== prev.playbackState) {
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

