/**
 * Autoplay controller — observes playback progress, queue position, and
 * user settings to drive seamless Infinite Autoplay refills via
 * `smartRadioService` without interrupting active audio.
 */
import type { Child } from 'subsonic-api';

import { offlineModeStore } from '../store/offlineModeStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { playerStore, type PlayerState } from '../store/playerStore';
import { getDb } from '../store/persistence/db';
import type {
  RadioAiSettingsSnapshot,
  RadioAiSettingsState,
} from '../store/radioAiSettingsStore';
import { withTimeout } from '../utils/withTimeout';
import {
  getForgottenGems,
  getQuickMoodChips,
  getSongsForMoodChip,
} from './localIntelligenceService';
import { getSmartRadioTracks } from './smartRadioService';
import { findSonicPath, isSonicSimilarityAvailable } from './subsonicService';

interface RadioAiSettingsStoreLike {
  getState: () => RadioAiSettingsSnapshot;
  subscribe?: (
    listener: (state: RadioAiSettingsState, prevState: RadioAiSettingsState) => void,
  ) => () => void;
}

const DEFAULT_RADIO_AI_SETTINGS: RadioAiSettingsSnapshot = {
  infiniteAutoplay: true,
  radioMode: 'mood',
  sources: {
    sonicSimilarity: true,
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

function getRadioAiSettingsStore(): RadioAiSettingsStoreLike | null {
  try {
    // Lazy require avoids crashing Jest suites that mock `react-native` without
    // `NativeModules`, which breaks transitive `expo-crypto` -> `expo-constants` init.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../store/radioAiSettingsStore') as {
      radioAiSettingsStore?: RadioAiSettingsStoreLike;
    };
    return mod?.radioAiSettingsStore ?? null;
  } catch {
    return null;
  }
}

function getRadioAiSettingsSnapshot(): RadioAiSettingsSnapshot {
  return getRadioAiSettingsStore()?.getState() ?? DEFAULT_RADIO_AI_SETTINGS;
}

interface RadioSkipStoreLike {
  recordSkip: (track: Pick<Child, 'id' | 'title' | 'artist'>) => void;
  clearSkip: (songId: string) => void;
}

function getRadioSkipStore(): RadioSkipStoreLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../store/radioSkipStore') as {
      radioSkipStore?: { getState: () => RadioSkipStoreLike };
    };
    return mod?.radioSkipStore?.getState() ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const AUTOPLAY_REFILL_COUNT = 14;
const REFILL_THRESHOLD_REMAINING = 3;
const MAX_RECENT_SEEDS = 3;
const MIN_COMPLETED_SECONDS = 20;
const MIN_COMPLETED_RATIO = 0.3;
const MIN_PROGRESS_FOR_SKIP_SECONDS = 1;
const SONIC_PATH_MIN_SESSION_TRACKS = 15;
const SONIC_PATH_COOLDOWN_TRACKS = 15;
const SONIC_PATH_WINDOW_SIZE = 8;
const SONIC_PATH_COUNT = 12;
const SONIC_PATH_TIMEOUT_MS = 2500;

/* ------------------------------------------------------------------ */
/*  Queue appender bridge (avoids Metro require cycle with playerService) */
/* ------------------------------------------------------------------ */

export type AutoplayQueueAppender = (tracks: Child[]) => Promise<void>;

let registeredQueueAppender: AutoplayQueueAppender | null = null;

/**
 * Register the queue-appending function (called by `playerService` at module
 * load so `autoplayController` does not statically cycle back into it).
 */
export function registerAutoplayQueueAppender(
  appender: AutoplayQueueAppender | null,
): void {
  registeredQueueAppender = appender;
}

function resolveQueueAppender(): AutoplayQueueAppender {
  if (registeredQueueAppender) return registeredQueueAppender;
  // Lazy fallback for isolated unit tests that mock `playerService` directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./playerService') as { addToQueue: AutoplayQueueAppender };
  return mod.addToQueue;
}

/* ------------------------------------------------------------------ */
/*  Session state                                                      */
/* ------------------------------------------------------------------ */

let isInitialized = false;
let isRefilling = false;
let isRadioSeedLoading = false;
let sessionEpoch = 0;

const sessionPlayedIds = new Set<string>();
let recentCompletedSeeds: Child[] = [];
let recentSessionTracks: Child[] = [];
let lastSonicPathAtSessionSize = 0;
let lastAttemptedRefillKey: string | null = null;

// Per-track progress tracker for genuine-completion detection on manual skips
let trackedCurrentTrack: Child | null = null;
let maxPositionForTrack = 0;
let trackDurationForTrack = 0;
let lastAutoAdvancedTrackId: string | null = null;

export interface AutoplaySessionState {
  initialized: boolean;
  sessionPlayedIds: Set<string>;
  recentCompletedSeeds: Child[];
  isRefilling: boolean;
  isRadioSeedLoading: boolean;
}

/** Snapshot of current autoplay session state (primarily for tests & diagnostics). */
export function getAutoplaySessionState(): AutoplaySessionState {
  return {
    initialized: isInitialized,
    sessionPlayedIds: new Set(sessionPlayedIds),
    recentCompletedSeeds: [...recentCompletedSeeds],
    isRefilling,
    isRadioSeedLoading,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function pushCompletedSeed(track: Child | null | undefined): void {
  if (!track?.id) return;
  recentCompletedSeeds = [
    track,
    ...recentCompletedSeeds.filter((t) => t.id !== track.id),
  ].slice(0, MAX_RECENT_SEEDS);
}

function pushRecentSessionTrack(track: Child | null | undefined): void {
  if (!track?.id) return;
  if (recentSessionTracks[0]?.id === track.id) return;
  recentSessionTracks = [
    track,
    ...recentSessionTracks.filter((t) => t.id !== track.id),
  ].slice(0, SONIC_PATH_WINDOW_SIZE);
}

function isMicroClusterStagnating(recentTracks: readonly Child[]): boolean {
  if (recentTracks.length < 6) return false;
  const artists = new Set<string>();
  const genres = new Set<string>();
  let tracksWithGenre = 0;

  for (const t of recentTracks) {
    const artist = t.artist?.trim().toLowerCase();
    if (artist) artists.add(artist);
    const genre = t.genre?.trim().toLowerCase();
    if (genre) {
      genres.add(genre);
      tracksWithGenre += 1;
    }
  }

  if (artists.size > 0 && artists.size <= 2) return true;
  if (tracksWithGenre >= 4 && genres.size <= 1) return true;
  return false;
}

async function selectSonicBridgeTarget(
  currentTrack: Child,
  excludeIds: ReadonlySet<string>,
): Promise<Child | null> {
  try {
    const chips = await getQuickMoodChips(8);
    if (chips.length > 0) {
      const currentGenreLower = currentTrack.genre?.trim().toLowerCase();
      const sortedChips = [...chips].sort((a, b) => {
        const aSame = a.kind === 'genre' && a.genre?.toLowerCase() === currentGenreLower ? 1 : 0;
        const bSame = b.kind === 'genre' && b.genre?.toLowerCase() === currentGenreLower ? 1 : 0;
        return aSame - bSame;
      });
      for (const chip of sortedChips.slice(0, 3)) {
        const chipSongs = await getSongsForMoodChip(chip, 15);
        const match = chipSongs.find(
          (s) => s?.id && s.id !== currentTrack.id && !excludeIds.has(s.id),
        );
        if (match) return match;
      }
    }
  } catch {
    // Fall through to forgotten gems / starred fallback
  }

  try {
    const gems = await getForgottenGems(15);
    const gemMatch = gems.find(
      (s) => s?.id && s.id !== currentTrack.id && !excludeIds.has(s.id),
    );
    if (gemMatch) return gemMatch;
  } catch {
    // Fall through to starred SQLite fallback
  }

  try {
    const db = getDb();
    if (db && typeof db.getAllAsync === 'function') {
      const rows = await db.getAllAsync<{ id: string; title: string | null; artist: string | null }>(
        `SELECT id, title, artist FROM songs
          WHERE starred IS NOT NULL AND id <> ?
          ORDER BY RANDOM() LIMIT 10`,
        [currentTrack.id],
      );
      const hit = rows?.find((r) => r?.id && !excludeIds.has(r.id));
      if (hit) {
        return {
          id: hit.id,
          title: hit.title ?? hit.id,
          artist: hit.artist ?? undefined,
          isDir: false,
        } as Child;
      }
    }
  } catch {
    // Best-effort bridge target selection
  }

  return null;
}

function canAttemptSonicBridge(
  currentTrack: Child | null | undefined,
  radioSettings: RadioAiSettingsSnapshot,
): boolean {
  if (
    radioSettings.radioMode !== 'balanced' &&
    radioSettings.radioMode !== 'discovery'
  ) {
    return false;
  }
  if (radioSettings.sources?.sonicSimilarity === false) return false;
  if (offlineModeStore.getState().offlineMode) return false;
  if (
    typeof isSonicSimilarityAvailable !== 'function' ||
    typeof findSonicPath !== 'function' ||
    !isSonicSimilarityAvailable()
  ) {
    return false;
  }
  if (!currentTrack?.id || currentTrack.isDir) return false;
  if (sessionPlayedIds.size < SONIC_PATH_MIN_SESSION_TRACKS) return false;
  if (sessionPlayedIds.size - lastSonicPathAtSessionSize < SONIC_PATH_COOLDOWN_TRACKS) {
    return false;
  }
  return isMicroClusterStagnating(recentSessionTracks);
}

async function tryBuildSonicBridge(
  currentTrack: Child,
  excludeIds: ReadonlySet<string>,
): Promise<Child[] | null> {
  const target = await selectSonicBridgeTarget(currentTrack, excludeIds);
  if (!target?.id) return null;

  const pathResult = await withTimeout(
    () => findSonicPath(currentTrack.id, target.id, SONIC_PATH_COUNT),
    SONIC_PATH_TIMEOUT_MS,
  );
  if (pathResult === 'timeout' || !Array.isArray(pathResult) || pathResult.length === 0) {
    return null;
  }

  // Spec guarantees startSongId as first element and endSongId as last;
  // strip currentTrack.id, already-played session tracks, and duplicates.
  const seen = new Set<string>(excludeIds);
  seen.add(currentTrack.id);
  const bridge: Child[] = [];
  for (const match of pathResult) {
    const song = match?.song;
    if (!song?.id || seen.has(song.id)) continue;
    seen.add(song.id);
    bridge.push(song);
  }

  if (bridge.length < 2) return null;
  lastSonicPathAtSessionSize = sessionPlayedIds.size;
  return bridge;
}

function buildSeedSongs(
  currentTrack: Child | null,
  completedSeeds: readonly Child[],
  queue: readonly Child[],
  currentTrackIndex: number,
): Child[] {
  const seeds: Child[] = [];
  const seen = new Set<string>();
  const push = (t: Child | null | undefined): void => {
    if (!t?.id || seen.has(t.id)) return;
    seen.add(t.id);
    seeds.push(t);
  };

  push(currentTrack);
  for (const s of completedSeeds) {
    if (seeds.length >= MAX_RECENT_SEEDS) break;
    push(s);
  }
  if (seeds.length === 0) {
    push(queue[currentTrackIndex]);
  }
  return seeds.slice(0, MAX_RECENT_SEEDS);
}

function isTrackGenuinelyPlayed(playedSec: number, durationSec: number): boolean {
  if (playedSec < MIN_COMPLETED_SECONDS) return false;
  if (durationSec > 0 && playedSec < durationSec * MIN_COMPLETED_RATIO) {
    return false;
  }
  return true;
}

function syncTrackProgressFromState(state: PlayerState): void {
  const incoming = state.currentTrack;
  if (incoming?.id) {
    sessionPlayedIds.add(incoming.id);
    pushRecentSessionTrack(incoming);

    if (!trackedCurrentTrack) {
      trackedCurrentTrack = incoming;
      maxPositionForTrack = 0;
      trackDurationForTrack = state.duration || incoming.duration || 0;
      return;
    }

    if (incoming.id === trackedCurrentTrack.id) {
      if ((state.position ?? 0) > maxPositionForTrack) {
        maxPositionForTrack = state.position ?? 0;
      }
      if ((state.duration ?? 0) > 0) {
        trackDurationForTrack = state.duration;
      }
      return;
    }

    // Track changed without an active auto-advance having already recorded it
    const outgoing = trackedCurrentTrack;
    if (lastAutoAdvancedTrackId === outgoing.id) {
      lastAutoAdvancedTrackId = null;
      getRadioSkipStore()?.clearSkip(outgoing.id);
    } else {
      const dur = trackDurationForTrack || outgoing.duration || 0;
      if (isTrackGenuinelyPlayed(maxPositionForTrack, dur)) {
        pushCompletedSeed(outgoing);
        getRadioSkipStore()?.clearSkip(outgoing.id);
      } else if (maxPositionForTrack >= MIN_PROGRESS_FOR_SKIP_SECONDS) {
        getRadioSkipStore()?.recordSkip(outgoing);
      }
    }

    // Reset position tracker to 0 because `setCurrentTrack` preserves the
    // outgoing track's `position` in `playerStore` until the next `onProgress`.
    trackedCurrentTrack = incoming;
    maxPositionForTrack = 0;
    trackDurationForTrack = incoming.duration || 0;
    return;
  }

  trackedCurrentTrack = null;
  maxPositionForTrack = 0;
  trackDurationForTrack = 0;
}

/* ------------------------------------------------------------------ */
/*  Core refill trigger                                                */
/* ------------------------------------------------------------------ */

async function maybeRefillQueue(): Promise<void> {
  if (isRefilling || isRadioSeedLoading) return;

  const radioSettings = getRadioAiSettingsSnapshot();
  if (!radioSettings.infiniteAutoplay) return;

  const playbackSettings = playbackSettingsStore.getState();
  if (playbackSettings.repeatMode !== 'off') return;

  const playerState = playerStore.getState();
  if (playerState.queueLoading) return;

  const { queue, currentTrackIndex, currentTrack } = playerState;
  if (!queue || queue.length === 0) return;
  if (currentTrackIndex == null || currentTrackIndex < 0) return;

  const remaining = queue.length - 1 - currentTrackIndex;
  if (remaining > REFILL_THRESHOLD_REMAINING) return;

  const attemptKey = `${sessionEpoch}:${queue.length}:${currentTrackIndex}:${currentTrack?.id ?? ''}`;
  if (lastAttemptedRefillKey === attemptKey) return;

  const seedSongs = buildSeedSongs(
    currentTrack,
    recentCompletedSeeds,
    queue,
    currentTrackIndex,
  );
  if (seedSongs.length === 0) return;

  const excludeIds = new Set<string>(sessionPlayedIds);
  for (const q of queue) {
    if (q?.id) excludeIds.add(q.id);
  }

  const epochAtStart = sessionEpoch;
  isRefilling = true;
  lastAttemptedRefillKey = attemptKey;

  try {
    const bridgeSeed = currentTrack ?? seedSongs[0];
    let newTracks: Child[] | null = canAttemptSonicBridge(bridgeSeed, radioSettings)
      ? await tryBuildSonicBridge(bridgeSeed, excludeIds)
      : null;
    if (!newTracks || newTracks.length === 0) {
      newTracks = await getSmartRadioTracks({
        seedSongs,
        targetCount: AUTOPLAY_REFILL_COUNT,
        excludeIds,
        settings: radioSettings,
        randomize: true,
      });
    }

    if (!newTracks || newTracks.length === 0) return;

    // Verify queue & settings were not replaced/cleared while fetching
    if (sessionEpoch !== epochAtStart) return;
    if (!getRadioAiSettingsSnapshot().infiniteAutoplay) return;
    if (playbackSettingsStore.getState().repeatMode !== 'off') return;

    const latestPlayer = playerStore.getState();
    if (!latestPlayer.queue || latestPlayer.queue.length === 0) return;
    if (latestPlayer.queueLoading) return;

    const existingUpcoming = new Set(
      latestPlayer.queue
        .slice(Math.max(0, latestPlayer.currentTrackIndex ?? 0))
        .map((t) => t.id),
    );
    const filteredNewTracks = newTracks.filter(
      (t) => Boolean(t?.id) && !existingUpcoming.has(t.id),
    );
    if (filteredNewTracks.length === 0) return;

    registerQueuedTracks(filteredNewTracks);
    const append = resolveQueueAppender();
    await append(filteredNewTracks);
  } catch {
    // Background refill is best-effort and must never disrupt active playback
  } finally {
    isRefilling = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Public lifecycle & hooks                                           */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to `playerStore`, `playbackSettingsStore`, and `radioAiSettingsStore`
 * (idempotent). Guards `.subscribe` because some unit tests mock `playerStore`
 * without a Zustand `.subscribe` method.
 */
export function initAutoplayController(): void {
  if (isInitialized) return;
  isInitialized = true;

  if (typeof playerStore.subscribe === 'function') {
    playerStore.subscribe((state, prevState) => {
      syncTrackProgressFromState(state);

      if (isRadioSeedLoading || isRefilling || state.queueLoading) return;
      if (!state.queue || state.queue.length === 0) return;
      if (state.currentTrackIndex == null || state.currentTrackIndex < 0) return;

      const remaining = state.queue.length - 1 - state.currentTrackIndex;
      if (remaining > REFILL_THRESHOLD_REMAINING) return;

      const trackOrQueueChanged =
        state.currentTrackIndex !== prevState.currentTrackIndex ||
        state.currentTrack?.id !== prevState.currentTrack?.id ||
        state.queue !== prevState.queue ||
        (prevState.queueLoading && !state.queueLoading);

      const sameTrack = state.currentTrack?.id === prevState.currentTrack?.id;
      const becameActive =
        (state.playbackState === 'playing' && prevState.playbackState !== 'playing') ||
        (sameTrack && (state.position ?? 0) > 0 && (prevState.position ?? 0) <= 0);

      // For a single-track queue, wait until playback is active or progressed
      // so initial radio setup doesn't prematurely fire before seed loading.
      if (state.queue.length === 1) {
        if (
          becameActive ||
          (trackOrQueueChanged &&
            (state.playbackState === 'playing' || (sameTrack && (state.position ?? 0) > 0)))
        ) {
          void maybeRefillQueue();
        }
        return;
      }

      if (trackOrQueueChanged || becameActive) {
        void maybeRefillQueue();
      }
    });
  }

  if (typeof playbackSettingsStore.subscribe === 'function') {
    playbackSettingsStore.subscribe((state, prevState) => {
      if (state.repeatMode === 'off' && prevState.repeatMode !== 'off') {
        lastAttemptedRefillKey = null;
        void maybeRefillQueue();
      }
    });
  }

  const radioStore = getRadioAiSettingsStore();
  if (radioStore && typeof radioStore.subscribe === 'function') {
    radioStore.subscribe((state, prevState) => {
      if (state.infiniteAutoplay && !prevState.infiniteAutoplay) {
        lastAttemptedRefillKey = null;
        void maybeRefillQueue();
      }
    });
  }
}

/**
 * Mark whether `playMoreLikeThis` is currently resolving its initial seed tracks
 * so `autoplayController` does not trigger a competing refill on the 1-track seed queue.
 */
export function setRadioSeedLoading(loading: boolean): void {
  isRadioSeedLoading = loading;
}

/**
 * Reset anti-repeat session state when the user explicitly starts a new manual queue.
 * Does NOT synchronously trigger a refill.
 */
export function onManualQueueStart(startTrack: Child, queue: Child[]): void {
  sessionEpoch += 1;
  sessionPlayedIds.clear();
  recentCompletedSeeds = [];
  recentSessionTracks = [];
  lastSonicPathAtSessionSize = 0;
  lastAttemptedRefillKey = null;
  lastAutoAdvancedTrackId = null;

  if (startTrack?.id) {
    sessionPlayedIds.add(startTrack.id);
    pushRecentSessionTrack(startTrack);
  }
  for (const track of queue) {
    if (track?.id) sessionPlayedIds.add(track.id);
  }

  trackedCurrentTrack = startTrack ?? null;
  maxPositionForTrack = 0;
  trackDurationForTrack = startTrack?.duration ?? 0;
}

/**
 * Notify controller that `outgoingTrack` finished playing naturally (`auto-advance`).
 */
export function onTrackAutoAdvanced(outgoingTrack: Child | undefined): void {
  if (outgoingTrack?.id) {
    sessionPlayedIds.add(outgoingTrack.id);
    pushRecentSessionTrack(outgoingTrack);
    pushCompletedSeed(outgoingTrack);
    lastAutoAdvancedTrackId = outgoingTrack.id;
    getRadioSkipStore()?.clearSkip(outgoingTrack.id);
  }
  maxPositionForTrack = 0;
  void maybeRefillQueue();
}

/**
 * Register tracks appended to the queue (e.g. by `playMoreLikeThis`) in
 * `sessionPlayedIds` so subsequent autoplay refills avoid repeating them.
 */
export function registerQueuedTracks(tracks: Child[]): void {
  for (const t of tracks) {
    if (t?.id) sessionPlayedIds.add(t.id);
  }
}

/** Clear all autoplay session state (called when queue is cleared/stopped). */
export function resetAutoplaySession(): void {
  sessionEpoch += 1;
  sessionPlayedIds.clear();
  recentCompletedSeeds = [];
  recentSessionTracks = [];
  lastSonicPathAtSessionSize = 0;
  isRadioSeedLoading = false;
  lastAttemptedRefillKey = null;
  trackedCurrentTrack = null;
  maxPositionForTrack = 0;
  trackDurationForTrack = 0;
  lastAutoAdvancedTrackId = null;
}
