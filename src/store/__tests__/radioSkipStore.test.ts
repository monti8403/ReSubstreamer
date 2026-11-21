const mockKvBacking = new Map<string, string>();
jest.mock('../persistence/kvStorage', () => ({
  kvStorageSync: {
    getItem: (k: string) => mockKvBacking.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mockKvBacking.set(k, v);
    },
    removeItem: (k: string) => {
      mockKvBacking.delete(k);
    },
  },
  kvStorage: {
    getItem: async (k: string) => mockKvBacking.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      mockKvBacking.set(k, v);
    },
    removeItem: async (k: string) => {
      mockKvBacking.delete(k);
    },
  },
  clearKvStorage: async () => {
    mockKvBacking.clear();
  },
}));

import { radioSkipStore, SKIP_TTL_MS } from '../radioSkipStore';

beforeEach(() => {
  mockKvBacking.clear();
  radioSkipStore.getState().reset();
});

describe('radioSkipStore', () => {
  it('records escalating per-track penalty, decays after 14 days, and clears on genuine play', () => {
    const t0 = 1_700_000_000_000;
    radioSkipStore.getState().recordSkip(
      { id: 'song-1', title: 'Track 1', artist: 'Artist A' },
      t0,
    );
    expect(radioSkipStore.getState().getSkipPenalty('song-1', t0)).toBe(25);
    expect(radioSkipStore.getState().getSkipPenalty('song-other-by-artist-a', t0)).toBe(0);

    radioSkipStore.getState().recordSkip({ id: 'song-1', title: 'Track 1', artist: 'Artist A' }, t0 + 5000);
    expect(radioSkipStore.getState().getSkipPenalty('song-1', t0 + 5000)).toBe(40);

    // Expires cleanly after TTL
    expect(radioSkipStore.getState().getSkipPenalty('song-1', t0 + 5000 + SKIP_TTL_MS + 1)).toBe(0);

    // Completing the track clears the penalty immediately
    radioSkipStore.getState().clearSkip('song-1');
    expect(radioSkipStore.getState().getSkipPenalty('song-1', t0 + 6000)).toBe(0);
  });

  it('returns recent skipped tracks ordered most recent first within TTL', () => {
    const now = 1_700_000_000_000;
    radioSkipStore.getState().recordSkip({ id: 'old', title: 'Old', artist: 'A' }, now - SKIP_TTL_MS - 10);
    radioSkipStore.getState().recordSkip({ id: 's1', title: 'First', artist: 'B' }, now - 5000);
    radioSkipStore.getState().recordSkip({ id: 's2', title: 'Second', artist: 'C' }, now - 1000);

    const recent = radioSkipStore.getState().getRecentSkippedTracks(5, now);
    expect(recent.map((r) => r.songId)).toEqual(['s2', 's1']);
  });
});
