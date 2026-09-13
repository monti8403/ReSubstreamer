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
  /** History of recently played tracks that were removed from the active queue. */
  playbackHistory: Child[];

  /* ---- Setters (called by playerService) ---- */
  setCurrentTrack: (track: Child | null, index?: number | null) => void;
  setPlaybackState: (state: PlaybackStatus) => void;
  setQueue: (queue: Child[]) => void;
  setProgress: (position: number, duration: number, buffered: number) => void;
  setError: (error: string | null) => void;
  setRetrying: (retrying: boolean) => void;
  setQueueLoading: (loading: boolean) => void;
  setQueueFormats: (formats: Record<string, EffectiveFormat>) => void;
  addQueueFormat: (songId: string, fmt: EffectiveFormat) => void;
  clearQueueFormats: () => void;
  setTrackSource: (source: TrackSource | null) => void;
  addToHistory: (track: Child) => void;
  popFromHistory: () => Child | null;
  clearHistory: () => void;
  consumeQueueTracks: (
    tracksToHistory: Child[],
    newQueue: Child[],
    currentTrack: Child | null,
    currentTrackIndex?: number | null,
  ) => void;
}

let _queueKeySeq = 0;

export function ensureQueueKey(item: any): string {
  if (!item) return '';
  if (!item._queueKey) {
    item._queueKey = `${item.id ?? 'track'}_${++_queueKeySeq}`;
  }
  return item._queueKey;
}

export const playerStore = create<PlayerState>()((set) => ({
  currentTrack: null,
  currentTrackIndex: null,
  playbackState: 'idle',
  queue: [],
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
    for (let i = 0; i < queue.length; i++) {
      ensureQueueKey(queue[i]);
    }
    set({ queue });
  },
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
  playbackHistory: [],
  addToHistory: (track) =>
    set((state) => {
      if (!track) return state;
      const next = [track, ...state.playbackHistory.filter((t) => t.id !== track.id)].slice(0, 30);
      return { playbackHistory: next };
    }),
  popFromHistory: () => {
    let popped: Child | null = null;
    set((state) => {
      if (state.playbackHistory.length === 0) return state;
      popped = state.playbackHistory[0] ?? null;
      return { playbackHistory: state.playbackHistory.slice(1) };
    });
    return popped;
  },
  clearHistory: () => set({ playbackHistory: [] }),
  consumeQueueTracks: (tracksToHistory, newQueue, currentTrack, currentTrackIndex = 0) =>
    set((state) => {
      let nextHistory = state.playbackHistory;
      for (const track of tracksToHistory) {
        if (!track) continue;
        nextHistory = [track, ...nextHistory.filter((t) => t.id !== track.id)].slice(0, 30);
      }
      return {
        playbackHistory: nextHistory,
        queue: newQueue,
        currentTrack,
        currentTrackIndex,
      };
    }),
}));
