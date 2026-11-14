/**
 * In-memory Zustand store for playback state.
 *
 * Updated by playerService event listeners so the UI stays in sync
 * with the native audio player, including across background/foreground
 * transitions.
 */

import { create } from 'zustand';
import type { TrackSource } from 'react-native-queue-player';

import { type EffectiveFormat } from '../types/audio';
import type { Child } from '../services/subsonicService';

export type PlaybackStatus =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'loading'
  | 'stopped';

export interface PlayerState {
  /** The currently active track, or null when nothing is loaded. */
  currentTrack: Child | null;
  /** Index of the currently active track in the queue, or null when nothing is loaded. */
  currentTrackIndex: number | null;
  /** High-level playback state. */
  playbackState: PlaybackStatus;
  /** The full queue of Child objects currently loaded. */
  queue: Child[];
  /** Current playback position in seconds. */
  position: number;
  /** Duration of the current track in seconds. */
  duration: number;
  /** Absolute buffered edge from the start of the track, in seconds. */
  bufferedPosition: number;
  /** Last playback error message, or null when healthy. */
  error: string | null;
  /** Whether the player is currently auto-retrying after an error. */
  retrying: boolean;
  /** True while `playTrack()` is loading the queue and skipping to the start index. */
  queueLoading: boolean;
  /** Effective post-transcode format for each track in the current queue, keyed by song ID. */
  queueFormats: Record<string, EffectiveFormat>;
  /** Where the active track is playing from: local file, lookahead cache, or live stream. */
  trackSource: TrackSource | null;
  /** Track IDs explicitly added to the queue by the user. */
  userQueueTrackIds: string[];

  /* ---- Setters (called by playerService) ---- */
  setCurrentTrack: (track: Child | null, index?: number | null) => void;
  setPlaybackState: (state: PlaybackStatus) => void;
  setQueue: (queue: Child[]) => void;
  setUserQueueTrackIds: (ids: string[]) => void;
  addUserQueueTrackIds: (ids: string[]) => void;
  removeUserQueueTrackIds: (ids: string[]) => void;
  clearUserQueueTrackIds: () => void;
  setProgress: (position: number, duration: number, buffered: number) => void;
  setError: (error: string | null) => void;
  setRetrying: (retrying: boolean) => void;
  setQueueLoading: (loading: boolean) => void;
  setQueueFormats: (formats: Record<string, EffectiveFormat>) => void;
  addQueueFormat: (songId: string, fmt: EffectiveFormat) => void;
  clearQueueFormats: () => void;
  setTrackSource: (source: TrackSource | null) => void;
}

let _queueKeySeq = 0;
const _fallbackQueueKeys = new WeakMap<object, string>();

export function ensureQueueKey(item: any): string {
  if (!item) return '';
  if (typeof item === 'object') {
    if (typeof item._queueKey === 'string' && item._queueKey.length > 0) {
      return item._queueKey;
    }
    const existing = _fallbackQueueKeys.get(item);
    if (existing) return existing;
    const key = `${item.id ?? 'track'}_${++_queueKeySeq}`;
    _fallbackQueueKeys.set(item, key);
    return key;
  }
  return '';
}

function withUniqueQueueKeys(queue: Child[]): Child[] {
  if (queue.length === 0) return queue;
  const seenKeys = new Set<string>();
  const seenRefs = new WeakSet<object>();
  let cloned: Child[] | null = null;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i] as (Child & { _queueKey?: string }) | null | undefined;
    if (!item || typeof item !== 'object') continue;

    const ownKey =
      typeof item._queueKey === 'string' && item._queueKey.length > 0
        ? item._queueKey
        : undefined;
    const candidateKey = ownKey ?? _fallbackQueueKeys.get(item);
    const isDuplicateRef = seenRefs.has(item);
    const isDuplicateKey = candidateKey !== undefined && seenKeys.has(candidateKey);

    if (!isDuplicateRef && !isDuplicateKey) {
      seenRefs.add(item);
      if (candidateKey) {
        seenKeys.add(candidateKey);
      }
      continue;
    }

    if (!cloned) {
      cloned = queue.slice();
    }
    const newKey = `${item.id ?? 'track'}_${++_queueKeySeq}`;
    seenKeys.add(newKey);
    cloned[i] = { ...item, _queueKey: newKey } as Child;
  }

  return cloned ?? queue;
}

export const playerStore = create<PlayerState>()((set) => ({
  currentTrack: null,
  currentTrackIndex: null,
  playbackState: 'idle',
  queue: [],
  userQueueTrackIds: [],
  position: 0,
  duration: 0,
  bufferedPosition: 0,
  error: null,
  retrying: false,
  queueLoading: false,
  queueFormats: {},
  trackSource: null,

  setCurrentTrack: (track, index) =>
    set({
      currentTrack: track,
      currentTrackIndex: index ?? null,
      ...(track ? {} : { trackSource: null }),
    }),
  setPlaybackState: (playbackState) => set({ playbackState }),
  setQueue: (queue) => {
    set({ queue: withUniqueQueueKeys(queue) });
  },
  setUserQueueTrackIds: (userQueueTrackIds) => set({ userQueueTrackIds }),
  addUserQueueTrackIds: (ids) =>
    set((state) => {
      const filtered = state.userQueueTrackIds.filter((id) => !ids.includes(id));
      return { userQueueTrackIds: [...filtered, ...ids] };
    }),
  removeUserQueueTrackIds: (ids) =>
    set((state) => ({
      userQueueTrackIds: state.userQueueTrackIds.filter((id) => !ids.includes(id)),
    })),
  clearUserQueueTrackIds: () => set({ userQueueTrackIds: [] }),
  setProgress: (position, duration, buffered) =>
    set((state) => ({
      position,
      duration: duration > 0 ? duration : (state.currentTrack?.duration ?? 0),
      bufferedPosition: buffered,
    })),
  setError: (error) => set({ error }),
  setRetrying: (retrying) => set({ retrying }),
  setQueueLoading: (loading) => set({ queueLoading: loading }),
  setQueueFormats: (queueFormats) => set({ queueFormats }),
  addQueueFormat: (songId, fmt) =>
    set((state) => ({ queueFormats: { ...state.queueFormats, [songId]: fmt } })),
  clearQueueFormats: () => set({ queueFormats: {} }),
  setTrackSource: (trackSource) => set({ trackSource }),
}));
