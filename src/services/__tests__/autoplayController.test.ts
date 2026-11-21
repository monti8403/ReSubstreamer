jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../secureKeyVault', () => ({
  loadApiKeySecret: jest.fn().mockResolvedValue(''),
  saveApiKeySecret: jest.fn().mockResolvedValue(undefined),
  clearApiKeySecret: jest.fn().mockResolvedValue(undefined),
}));

const mockAddToQueue = jest.fn<Promise<void>, [any[]]>().mockResolvedValue(undefined);
jest.mock('../playerService', () => ({
  addToQueue: (tracks: any[]) => mockAddToQueue(tracks),
}));

const mockGetSmartRadioTracks = jest.fn();
jest.mock('../smartRadioService', () => ({
  getSmartRadioTracks: (...args: any[]) => mockGetSmartRadioTracks(...args),
}));

const mockIsSonicSimilarityAvailable = jest.fn().mockReturnValue(false);
const mockFindSonicPath = jest.fn().mockResolvedValue([]);
jest.mock('../subsonicService', () => ({
  isSonicSimilarityAvailable: () => mockIsSonicSimilarityAvailable(),
  findSonicPath: (...args: any[]) => mockFindSonicPath(...args),
}));

const mockGetQuickMoodChips = jest.fn().mockResolvedValue([]);
const mockGetSongsForMoodChip = jest.fn().mockResolvedValue([]);
const mockGetForgottenGems = jest.fn().mockResolvedValue([]);
jest.mock('../localIntelligenceService', () => ({
  getQuickMoodChips: (...args: any[]) => mockGetQuickMoodChips(...args),
  getSongsForMoodChip: (...args: any[]) => mockGetSongsForMoodChip(...args),
  getForgottenGems: (...args: any[]) => mockGetForgottenGems(...args),
}));

import type { Child } from 'subsonic-api';

import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { playerStore } from '../../store/playerStore';
import { radioAiSettingsStore } from '../../store/radioAiSettingsStore';
import {
  getAutoplaySessionState,
  initAutoplayController,
  onManualQueueStart,
  onTrackAutoAdvanced,
  registerAutoplayQueueAppender,
  registerQueuedTracks,
  resetAutoplaySession,
  setRadioSeedLoading,
} from '../autoplayController';

const makeSong = (id: string, duration = 200): Child =>
  ({
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    duration,
    isDir: false,
  }) as Child;

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  registerAutoplayQueueAppender(null);
  initAutoplayController();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSmartRadioTracks.mockResolvedValue([]);
  mockIsSonicSimilarityAvailable.mockReturnValue(false);
  mockFindSonicPath.mockResolvedValue([]);
  mockGetQuickMoodChips.mockResolvedValue([]);
  mockGetSongsForMoodChip.mockResolvedValue([]);
  mockGetForgottenGems.mockResolvedValue([]);
  resetAutoplaySession();
  radioAiSettingsStore.getState().resetRadioAiSettings();
  radioAiSettingsStore.getState().setInfiniteAutoplay(true);
  playbackSettingsStore.setState({ repeatMode: 'off' } as any);
  playerStore.setState({
    currentTrack: null,
    currentTrackIndex: null,
    queue: [],
    position: 0,
    duration: 0,
    playbackState: 'idle',
    queueLoading: false,
  });
});

describe('autoplayController', () => {
  it('resets sessionPlayedIds and recentCompletedSeeds on onManualQueueStart without synchronous refill', () => {
    const queue = [makeSong('s1')];
    playerStore.setState({
      queue,
      currentTrack: queue[0],
      currentTrackIndex: 0,
      playbackState: 'idle',
      position: 0,
    });

    onManualQueueStart(queue[0], queue);

    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();
    const state = getAutoplaySessionState();
    expect(state.sessionPlayedIds.has('s1')).toBe(true);
    expect(state.recentCompletedSeeds).toEqual([]);
  });

  it('blocks premature refill while isRadioSeedLoading is true', async () => {
    const s1 = makeSong('s1');
    setRadioSeedLoading(true);
    onManualQueueStart(s1, [s1]);

    playerStore.setState({
      queue: [s1],
      currentTrack: s1,
      currentTrackIndex: 0,
      playbackState: 'playing',
      position: 10,
    });
    await flushPromises();

    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();

    const radioTracks = Array.from({ length: 15 }, (_, i) => makeSong(`r${i}`));
    registerQueuedTracks(radioTracks);
    playerStore.setState({ queue: [s1, ...radioTracks], currentTrackIndex: 0 });
    setRadioSeedLoading(false);

    expect(getAutoplaySessionState().sessionPlayedIds.has('r0')).toBe(true);
    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();
  });

  it('triggers background refill (targetCount 14) when <= 3 tracks remain in queue', async () => {
    const queue = Array.from({ length: 6 }, (_, i) => makeSong(`q${i}`));
    const recommendations = Array.from({ length: 14 }, (_, i) => makeSong(`rec${i}`));
    mockGetSmartRadioTracks.mockResolvedValue(recommendations);

    onManualQueueStart(queue[0], queue);
    playerStore.setState({
      queue,
      currentTrack: queue[0],
      currentTrackIndex: 0,
      playbackState: 'playing',
    });
    await flushPromises();
    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();

    // Advance to index 2 (remaining = 6 - 1 - 2 = 3 <= 3)
    playerStore.setState({
      currentTrack: queue[2],
      currentTrackIndex: 2,
    });
    await flushPromises();

    expect(mockGetSmartRadioTracks).toHaveBeenCalledTimes(1);
    expect(mockGetSmartRadioTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 14,
      }),
    );
    expect(mockAddToQueue).toHaveBeenCalledWith(recommendations);
  });

  it('respects infiniteAutoplay=false and repeatMode!=off, and triggers when flipped near end', async () => {
    const queue = Array.from({ length: 4 }, (_, i) => makeSong(`q${i}`));
    const recommendations = [makeSong('rec1')];
    mockGetSmartRadioTracks.mockResolvedValue(recommendations);

    radioAiSettingsStore.getState().setInfiniteAutoplay(false);
    playbackSettingsStore.setState({ repeatMode: 'all' } as any);
    onManualQueueStart(queue[0], queue);
    playerStore.setState({
      queue,
      currentTrack: queue[2],
      currentTrackIndex: 2,
      playbackState: 'playing',
    });
    await flushPromises();
    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();

    // Turn infiniteAutoplay on while repeatMode is still 'all' -> still blocked
    radioAiSettingsStore.getState().setInfiniteAutoplay(true);
    await flushPromises();
    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();

    // Flip repeatMode to 'off' -> triggers!
    playbackSettingsStore.setState({ repeatMode: 'off' } as any);
    await flushPromises();
    expect(mockGetSmartRadioTracks).toHaveBeenCalledTimes(1);
    expect(mockAddToQueue).toHaveBeenCalledWith(recommendations);
  });

  it('tracks genuinely completed seeds and ignores tracks skipped before 20s or 30%', async () => {
    const t1 = makeSong('t1', 200);
    const t2 = makeSong('t2', 200);
    const t3 = makeSong('t3', 200);
    const t4 = makeSong('t4', 200);
    const t5 = makeSong('t5', 200);

    onManualQueueStart(t1, [t1, t2, t3, t4, t5]);

    // 1. t1 plays 10s (< 20s) -> skipped -> ignored
    playerStore.setState({ queue: [t1, t2, t3, t4, t5], currentTrack: t1, currentTrackIndex: 0, duration: 200, position: 10 });
    playerStore.setState({ currentTrack: t2, currentTrackIndex: 1, position: 0 });
    expect(getAutoplaySessionState().recentCompletedSeeds.map((s) => s.id)).toEqual([]);

    // 2. t2 plays 40s (>= 20s, but < 30% of 200s = 60s) -> skipped -> ignored
    playerStore.setState({ position: 40, duration: 200 });
    playerStore.setState({ currentTrack: t3, currentTrackIndex: 2, position: 0 });
    expect(getAutoplaySessionState().recentCompletedSeeds.map((s) => s.id)).toEqual([]);

    // 3. t3 plays 70s (>= 20s and >= 30%) -> skipped -> recorded!
    playerStore.setState({ position: 70, duration: 200 });
    playerStore.setState({ currentTrack: t4, currentTrackIndex: 3, position: 0 });
    expect(getAutoplaySessionState().recentCompletedSeeds.map((s) => s.id)).toEqual(['t3']);

    // 4. t4 naturally auto-advances -> recorded!
    onTrackAutoAdvanced(t4);
    expect(getAutoplaySessionState().recentCompletedSeeds.map((s) => s.id)).toEqual(['t4', 't3']);
  });

  it('uses concurrency mutex and discards stale results if session resets during fetch', async () => {
    let resolveFetch!: (tracks: Child[]) => void;
    mockGetSmartRadioTracks.mockImplementation(
      () =>
        new Promise<Child[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const queue = [makeSong('q1'), makeSong('q2')];
    onManualQueueStart(queue[0], queue);
    playerStore.setState({
      queue,
      currentTrack: queue[0],
      currentTrackIndex: 0,
      playbackState: 'playing',
    });

    // Second trigger while in-flight must be ignored by isRefilling mutex
    onTrackAutoAdvanced(queue[0]);
    expect(mockGetSmartRadioTracks).toHaveBeenCalledTimes(1);
    expect(getAutoplaySessionState().isRefilling).toBe(true);

    // User starts a new queue while fetch is pending -> stale fetch must be discarded
    const newQueue = [makeSong('new1')];
    onManualQueueStart(newQueue[0], newQueue);
    resolveFetch([makeSong('stale-rec')]);
    await flushPromises();

    expect(mockAddToQueue).not.toHaveBeenCalled();
    expect(getAutoplaySessionState().isRefilling).toBe(false);
  });

  it('triggers findSonicPath anti-stagnation after >=15 session tracks in balanced/discovery and strips currentSongId', async () => {
    mockIsSonicSimilarityAvailable.mockReturnValue(true);
    mockGetForgottenGems.mockResolvedValue([makeSong('gem-target')]);
    mockFindSonicPath.mockResolvedValue([
      { song: makeSong('s15'), similarity: 1.0 },
      { song: makeSong('bridge-1'), similarity: 0.8 },
      { song: makeSong('bridge-2'), similarity: 0.7 },
      { song: makeSong('gem-target'), similarity: 0.5 },
    ]);

    radioAiSettingsStore.getState().setRadioMode('balanced');
    radioAiSettingsStore.getState().setSource('sonicSimilarity', true);

    const initialTracks = Array.from({ length: 20 }, (_, i) => ({
      ...makeSong(`s${i}`),
      artist: 'Same Cluster Artist',
      genre: 'Techno',
    })) as Child[];

    onManualQueueStart(initialTracks[0], [initialTracks[0]]);
    // Step through 16 played tracks while remaining > 3; at index 16 remaining === 3 triggers refill
    for (let i = 1; i <= 16; i++) {
      playerStore.setState({
        queue: initialTracks,
        currentTrack: initialTracks[i],
        currentTrackIndex: i,
        playbackState: 'playing',
        position: 5,
      });
    }
    await flushPromises();

    expect(mockFindSonicPath).toHaveBeenCalledWith('s16', 'gem-target', 12);
    expect(mockGetSmartRadioTracks).not.toHaveBeenCalled();
    expect(mockAddToQueue).toHaveBeenCalledTimes(1);
    const appendedIds = mockAddToQueue.mock.calls[0][0].map((t: Child) => t.id);
    expect(appendedIds).toEqual(['bridge-1', 'bridge-2', 'gem-target']);
    expect(appendedIds).not.toContain('s16');
  });
});
