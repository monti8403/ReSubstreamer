import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { Child } from 'subsonic-api';

import type {
  HourlyDaylist,
  JumpBackInItem,
  QuickMoodChip,
} from '../../services/localIntelligenceService';
import { completedScrobbleStore } from '../../store/completedScrobbleStore';
import { offlineModeStore } from '../../store/offlineModeStore';

const mockGetJumpBackIn = jest.fn<Promise<JumpBackInItem[]>, []>();
const mockGetHourlyDaylist = jest.fn<Promise<HourlyDaylist>, []>();
const mockGetOnRepeat = jest.fn<Promise<Child[]>, []>();
const mockGetForgottenGems = jest.fn<Promise<Child[]>, []>();
const mockGetQuickMoodChips = jest.fn<Promise<QuickMoodChip[]>, []>();
const mockGetDynamicMixSummaries = jest.fn().mockResolvedValue([]);
const mockResolveDynamicMix = jest.fn().mockResolvedValue(null);

jest.mock('../../services/localIntelligenceService', () => ({
  getJumpBackIn: () => mockGetJumpBackIn(),
  getHourlyDaylist: () => mockGetHourlyDaylist(),
  getOnRepeat: () => mockGetOnRepeat(),
  getForgottenGems: () => mockGetForgottenGems(),
  getQuickMoodChips: () => mockGetQuickMoodChips(),
  getDynamicMixSummaries: () => mockGetDynamicMixSummaries(),
  resolveDynamicMix: (...args: any[]) => mockResolveDynamicMix(...args),
}));

import { useLocalIntelligence } from '../useLocalIntelligence';

const makeDaylist = (title = 'Morning Mix'): HourlyDaylist => ({
  hour: 9,
  timeSlotKey: 'daylistMorning',
  title,
  subtitle: 'Picked for your morning mix',
  topGenres: ['Rock'],
  songs: [{ id: 's1', title: 'Song 1', isDir: false } as Child],
});

const makeJump = (id: string): JumpBackInItem => ({
  id,
  type: 'album',
  title: `Album ${id}`,
  lastPlayedAt: 1000,
  playCount: 2,
});

const makeChip = (id: string): QuickMoodChip => ({
  id,
  label: id,
  kind: 'genre',
  genre: id,
  songCount: 3,
});

function seedMocks(tag = 'v1'): void {
  mockGetJumpBackIn.mockResolvedValue([makeJump(tag)]);
  mockGetHourlyDaylist.mockResolvedValue(makeDaylist(`Mix ${tag}`));
  mockGetOnRepeat.mockResolvedValue([{ id: `rep-${tag}`, title: tag, isDir: false } as Child]);
  mockGetForgottenGems.mockResolvedValue([{ id: `gem-${tag}`, title: tag, isDir: false } as Child]);
  mockGetQuickMoodChips.mockResolvedValue([makeChip(tag)]);
}

beforeEach(() => {
  jest.clearAllMocks();
  completedScrobbleStore.setState({ recentScrobbles: [] });
  offlineModeStore.setState({ offlineMode: false });
  seedMocks('v1');
});

describe('useLocalIntelligence', () => {
  it('loads all five local intelligence datasets in parallel on mount', async () => {
    const { result } = renderHook(() => useLocalIntelligence());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetJumpBackIn).toHaveBeenCalledTimes(1);
    expect(mockGetHourlyDaylist).toHaveBeenCalledTimes(1);
    expect(mockGetOnRepeat).toHaveBeenCalledTimes(1);
    expect(mockGetForgottenGems).toHaveBeenCalledTimes(1);
    expect(mockGetQuickMoodChips).toHaveBeenCalledTimes(1);

    expect(result.current.jumpBackIn.map((x) => x.id)).toEqual(['v1']);
    expect(result.current.daylist?.title).toBe('Mix v1');
    expect(result.current.onRepeat.map((x) => x.id)).toEqual(['rep-v1']);
    expect(result.current.forgottenGems.map((x) => x.id)).toEqual(['gem-v1']);
    expect(result.current.quickMoodChips.map((x) => x.id)).toEqual(['v1']);
  });

  it('refreshes when recentScrobbles.length or offlineMode changes', async () => {
    const { result } = renderHook(() => useLocalIntelligence());
    await waitFor(() => expect(result.current.loading).toBe(false));

    seedMocks('v2');
    act(() => {
      completedScrobbleStore.setState({
        recentScrobbles: [
          { id: 'sc1', song: { id: 's1', title: 'S1', isDir: false } as Child, time: 1000 },
        ],
      });
    });

    await waitFor(() => expect(result.current.daylist?.title).toBe('Mix v2'));
    expect(mockGetJumpBackIn).toHaveBeenCalledTimes(2);

    seedMocks('v3');
    act(() => {
      offlineModeStore.setState({ offlineMode: true });
    });

    await waitFor(() => expect(result.current.daylist?.title).toBe('Mix v3'));
    expect(mockGetJumpBackIn).toHaveBeenCalledTimes(3);
  });

  it('supports manual refresh()', async () => {
    const { result } = renderHook(() => useLocalIntelligence());
    await waitFor(() => expect(result.current.loading).toBe(false));

    seedMocks('manual');
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.daylist?.title).toBe('Mix manual');
    expect(result.current.jumpBackIn.map((x) => x.id)).toEqual(['manual']);
  });

  it('guards against state updates after unmount and supersedes stale requests', async () => {
    let resolveFirst!: (val: JumpBackInItem[]) => void;
    mockGetJumpBackIn.mockImplementationOnce(
      () =>
        new Promise<JumpBackInItem[]>((r) => {
          resolveFirst = r;
        }),
    );

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = renderHook(() => useLocalIntelligence());
      unmount();

      await act(async () => {
        resolveFirst([makeJump('late')]);
        await Promise.resolve();
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
