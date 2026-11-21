/**
 * Persistent track-level skip memory for Smart Radio and BYOK AI.
 *
 * Records only individual songs skipped early (< 20s or < 30% of duration) so
 * those specific tracks receive a decaying score penalty for 14 days without
 * penalizing other songs by the same artist or genre. Completing a track
 * genuinely immediately clears its skip entry.
 */
import type { Child } from 'subsonic-api';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorageSync as kvStorage } from './persistence';

export const SKIP_TTL_MS = 14 * 86_400_000;
const MAX_SKIP_ENTRIES = 200;
const PERSIST_KEY = 'substreamer-radio-skips';

export interface SkippedTrackEntry {
  songId: string;
  title?: string;
  artist?: string;
  count: number;
  lastSkippedAt: number;
}

export interface RadioSkipState {
  skippedById: Record<string, SkippedTrackEntry>;
  recordSkip: (track: Pick<Child, 'id' | 'title' | 'artist'>, nowMs?: number) => void;
  clearSkip: (songId: string) => void;
  getSkipPenalty: (songId: string, nowMs?: number) => number;
  getRecentSkippedTracks: (limit?: number, nowMs?: number) => SkippedTrackEntry[];
  reset: () => void;
}

function pruneExpiredAndCap(
  entries: Record<string, SkippedTrackEntry>,
  nowMs: number,
): Record<string, SkippedTrackEntry> {
  const valid = Object.values(entries).filter(
    (e) => e && e.songId && nowMs - e.lastSkippedAt <= SKIP_TTL_MS,
  );
  if (valid.length <= MAX_SKIP_ENTRIES) {
    const out: Record<string, SkippedTrackEntry> = {};
    for (const e of valid) out[e.songId] = e;
    return out;
  }
  valid.sort((a, b) => b.lastSkippedAt - a.lastSkippedAt);
  const out: Record<string, SkippedTrackEntry> = {};
  for (const e of valid.slice(0, MAX_SKIP_ENTRIES)) {
    out[e.songId] = e;
  }
  return out;
}

export const radioSkipStore = create<RadioSkipState>()(
  persist(
    (set, get) => ({
      skippedById: {},

      recordSkip: (track, nowMs = Date.now()) => {
        const songId = track?.id?.trim();
        if (!songId) return;
        set((state) => {
          const prev = state.skippedById[songId];
          const isPrevFresh = prev && nowMs - prev.lastSkippedAt <= SKIP_TTL_MS;
          const nextCount = isPrevFresh ? Math.min(prev.count + 1, 10) : 1;
          const nextMap: Record<string, SkippedTrackEntry> = {
            ...state.skippedById,
            [songId]: {
              songId,
              title: track.title ?? prev?.title,
              artist: track.artist ?? prev?.artist,
              count: nextCount,
              lastSkippedAt: nowMs,
            },
          };
          return { skippedById: pruneExpiredAndCap(nextMap, nowMs) };
        });
      },

      clearSkip: (songId) => {
        if (!songId) return;
        const current = get().skippedById;
        if (!(songId in current)) return;
        const next = { ...current };
        delete next[songId];
        set({ skippedById: next });
      },

      getSkipPenalty: (songId, nowMs = Date.now()) => {
        if (!songId) return 0;
        const entry = get().skippedById[songId];
        if (!entry) return 0;
        if (nowMs - entry.lastSkippedAt > SKIP_TTL_MS) return 0;
        // Track-only penalty: 25 pts on first early skip, escalating up to 60 on repeat skips.
        return Math.min(60, 25 + Math.max(0, entry.count - 1) * 15);
      },

      getRecentSkippedTracks: (limit = 5, nowMs = Date.now()) => {
        const safeLimit = Math.max(0, Math.floor(limit));
        if (safeLimit === 0) return [];
        return Object.values(get().skippedById)
          .filter((e) => e && nowMs - e.lastSkippedAt <= SKIP_TTL_MS)
          .sort((a, b) => b.lastSkippedAt - a.lastSkippedAt)
          .slice(0, safeLimit);
      },

      reset: () => set({ skippedById: {} }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ skippedById: state.skippedById }),
    },
  ),
);
