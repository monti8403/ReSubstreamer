/**
 * Player bootstrap — configures the RNQP engine ONCE, at module load, before
 * the app UI mounts. Imported from `index.js` ahead of the expo-router entry so
 * the player is ready on every launch path, including cold-start system wakes
 * (lock screen, CarPlay, assistant) that can run JS before any screen mounts.
 *
 * Per the RNQP setup guide, `configure()` must run from a module — NOT a React
 * effect. Event-listener wiring, remote-control options, sleep-timer bridging
 * and the deferred queue restore stay in `initPlayer()` / boot effects, which
 * run once the UI boots (the engine is already configured by then).
 *
 * Subsonic stream URLs are self-authenticating (auth is in the query string, and
 * on iOS they route through the loopback SSL proxy), so no `httpHeaders` are
 * needed — only the shipped User-Agent.
 */
import { getTrackPlayer } from 'react-native-queue-player';

import { errMessage } from '../utils/errorMessage';
import { installHeadlessMediaService } from './headlessMediaService';
import { initWidgetSyncService } from './widgetSyncService';
import { LOOKAHEAD_MAX_CACHE_MB, playbackSettingsStore, type SkipPreviousBehavior } from '../store/playbackSettingsStore';
import { kvStorageSync } from '../store/persistence/kvStorage';
import { ensureNowPlayingPlaceholderUri } from './nowPlayingPlaceholder';
import { setNativeSkipPreviousBehavior } from 'expo-move-to-back';

import { markPlayerReady, whenPlayerReady } from './playerReadyState';
export { whenPlayerReady };

function readInitialSkipPreviousBehavior(): { value: SkipPreviousBehavior; hydrated: boolean } {
  if (playbackSettingsStore.persist?.hasHydrated?.()) {
    return {
      value: playbackSettingsStore.getState().skipPreviousBehavior,
      hydrated: true,
    };
  }
  try {
    const raw = kvStorageSync.getItem('substreamer-playback-settings');
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as { state?: { skipPreviousBehavior?: SkipPreviousBehavior } };
      const persisted = parsed?.state?.skipPreviousBehavior;
      if (persisted === 'always-previous' || persisted === 'restart-or-previous') {
        return { value: persisted, hydrated: true };
      }
    }
  } catch {
    // Fall back to unhydrated default; initPlayer/onRehydrateStorage will re-apply.
  }
  return {
    value: playbackSettingsStore.getState().skipPreviousBehavior,
    hydrated: false,
  };
}

const initialSkip = readInitialSkipPreviousBehavior();
if (initialSkip.hydrated) {
  setNativeSkipPreviousBehavior(initialSkip.value);
}

// The lookahead-cache disk budget AND eviction policy are fixed here at
// configure() — Android's Media3 SimpleCache is built at the right size (it
// can't resize live), and eviction is a configure-time property (changing it
// clears + rebuilds the cache). Enable + track count are then applied live via
// playerService.applyLookaheadCacheConfig().
void getTrackPlayer()
  .configure({
    audioContentType: 'music',
    userAgent: 'atrum',
    // Skip-back behavior respects user setting: 'restart-or-previous' or 'previous'.
    skipToPreviousBehavior: initialSkip.value === 'restart-or-previous' ? 'restart-or-previous' : 'previous',
    // Our mild gray-waveform placeholder (matches the in-app cover-art
    // placeholder) in place of RNQP's built-in. Needs a local file:// URI.
    placeholderArtworkUri: ensureNowPlayingPlaceholderUri(),
    autoRetries: 3,
    lookaheadCacheMaxSizeMb: LOOKAHEAD_MAX_CACHE_MB,
    // LRU keeps the most-recently-played tracks (best for a client where users
    // re-listen). RNQP's default is already 'lru'; pinned here for clarity.
    lookaheadCacheEvictionPolicy: 'lru',
    // Progress fan-out: 500ms foreground; near-paused (10s) while backgrounded so
    // the off-screen progress firehose (and its re-render loop) is throttled
    // natively. Native re-emits immediately on foreground so the UI resumes live.
    progressUpdateIntervalMs: 500,
    backgroundProgressUpdateIntervalMs: 10000,
  })
  .then(() => {
    // Register the CarPlay / Android Auto browse service AFTER configure() has
    // bound the native service — registering earlier lands the callbacks on a
    // null binder and silently drops the snapshot. installHeadlessMediaService is
    // idempotent; this covers the cold car / Siri / Assistant wake that runs
    // this bundle before any screen (or login) mounts.
    installHeadlessMediaService();
    initWidgetSyncService();
    markPlayerReady();
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[playerBootstrap] configure failed:', errMessage(e));
    markPlayerReady();
  });

