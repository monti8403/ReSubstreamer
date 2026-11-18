import React from 'react';
import { act, render, fireEvent } from '@testing-library/react-native';
import { PlayerPhoneMini } from '../PlayerPhoneMini';
import { playerStore } from '@/store/playerStore';
import { playbackSettingsStore } from '@/store/playbackSettingsStore';
import * as playerService from '@/services/playerService';

jest.mock('@/store/persistence/kvStorage', () => require('@/store/persistence/__mocks__/kvStorage'));

const mockWithTimingCalls: Array<{ val: number; cb?: (finished: boolean) => void }> = [];
const mockTimingControl = { defer: false };

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      View,
      createAnimatedComponent: (c: unknown) => c,
    },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: jest.fn((val: number, _config?: unknown, cb?: (finished: boolean) => void) => {
      mockWithTimingCalls.push({ val, cb });
      if (cb && !mockTimingControl.defer) {
        cb(true);
      }
      return val;
    }),
    withSpring: (val: number) => val,
    cancelAnimation: jest.fn(),
    interpolate: (val: number, _input: number[], output: number[]) =>
      val === 0 ? output[0] : output[1],
    Extrapolation: { CLAMP: 'clamp' },
    Easing: {
      in: (e: unknown) => e,
      out: (e: unknown) => e,
      inOut: (e: unknown) => e,
      cubic: (t: number) => t,
      quad: (t: number) => t,
      bezier: () => (t: number) => t,
    },
    runOnJS: (fn: Function) => fn,
  };
});

jest.mock('react-native-gesture-handler', () => {
  const { Pressable } = require('react-native');
  const makeChainable = () => {
    const g: Record<string, () => unknown> = {};
    const methods = [
      'enabled', 'activeOffsetY', 'failOffsetY', 'activeOffsetX', 'failOffsetX',
      'cancelsTouchesInView',
      'onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize',
    ];
    for (const m of methods) g[m] = () => g;
    return g;
  };
  return {
    Pressable,
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: {
      Pan: makeChainable,
      Tap: makeChainable,
      Exclusive: (..._args: any[]) => makeChainable(),
    },
  };
});

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    colors: {
      background: '#000000',
      card: '#1e1e1e',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      primary: '#ff6600',
      border: '#333333',
      label: '#aaaaaa',
      red: '#ff0000',
      inputBg: '#222222',
    },
  }),
}));

jest.mock('@/hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => 'cover-1',
}));

jest.mock('@/hooks/useImagePalette', () => ({
  useImagePalette: () => ({
    primary: '#334455',
    gradientOpacity: { value: 1 },
  }),
}));

jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
}));

jest.mock('@/components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: (props: object) => <View testID="cached-image" {...props} /> };
});

jest.mock('@/components/MarqueeText', () => {
  const { Text } = require('react-native');
  return { MarqueeText: ({ children, style }: { children: React.ReactNode; style?: object }) => <Text style={style}>{children}</Text> };
});

jest.mock('@/services/playerService', () => ({
  skipToNext: jest.fn(),
  skipToPrevious: jest.fn(),
  togglePlayPause: jest.fn(),
}));

describe('PlayerPhoneMini', () => {
  const mockTrack = {
    id: 'track-1',
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 200,
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWithTimingCalls.length = 0;
    mockTimingControl.defer = false;
    playerStore.setState({
      currentTrack: mockTrack,
      playbackState: 'playing',
      position: 50,
      duration: 200,
      queueLoading: false,
      currentTrackIndex: 0,
      queue: [mockTrack, { ...mockTrack, id: 'track-2', title: 'Next Song' }],
      error: null,
    });
    playbackSettingsStore.setState({
      repeatMode: 'off',
      skipPreviousBehavior: 'always-previous',
    });
  });

  it('renders track title and artist', () => {
    const { getByText } = render(<PlayerPhoneMini />);
    expect(getByText('Test Song')).toBeTruthy();
    expect(getByText('Test Artist')).toBeTruthy();
  });

  it('renders controls and responds to button presses', () => {
    const { getByTestId } = render(<PlayerPhoneMini />);
    
    // Test play/pause toggle
    const toggleMock = jest.spyOn(playerService, 'togglePlayPause');
    const skipNextMock = jest.spyOn(playerService, 'skipToNext');
    const skipPrevMock = jest.spyOn(playerService, 'skipToPrevious');

    // Press play/pause
    fireEvent.press(getByTestId('mini-play-pause'));
    expect(toggleMock).toHaveBeenCalledTimes(1);

    // Press next
    fireEvent.press(getByTestId('mini-next'));
    expect(skipNextMock).toHaveBeenCalledTimes(1);

    // Press prev (enable canSkipPrevious by setting position > 3)
    fireEvent.press(getByTestId('mini-prev'));
    expect(skipPrevMock).toHaveBeenCalledTimes(1);
  });

  it('isolates left zone with overflow: hidden', () => {
    const { getByTestId } = render(<PlayerPhoneMini />);
    const leftZone = getByTestId('mini-left-zone');
    expect(leftZone.props.style).toEqual(
      expect.objectContaining({
        flex: 1,
        overflow: 'hidden',
      }),
    );
  });

  it('returns null when there is no current track', () => {
    playerStore.setState({ currentTrack: null });
    const { toJSON } = render(<PlayerPhoneMini />);
    expect(toJSON()).toBeNull();
  });

  it('animates slide exit and entry when pressing mini-next and mini-prev', () => {
    const track2 = { ...mockTrack, id: 'track-2', title: 'Next Song' };
    playerStore.setState({
      currentTrack: track2,
      currentTrackIndex: 1,
      position: 1,
      queue: [mockTrack, track2, { ...mockTrack, id: 'track-3', title: 'Third Song' }],
    });

    const { getByTestId } = render(<PlayerPhoneMini />);
    mockWithTimingCalls.length = 0;

    fireEvent.press(getByTestId('mini-next'));
    expect(playerService.skipToNext).toHaveBeenCalledTimes(1);
    expect(mockWithTimingCalls.some((c) => c.val < 0)).toBe(true);
    expect(mockWithTimingCalls.some((c) => c.val === 0)).toBe(true);

    mockWithTimingCalls.length = 0;
    fireEvent.press(getByTestId('mini-prev'));
    expect(playerService.skipToPrevious).toHaveBeenCalledTimes(1);
    expect(mockWithTimingCalls.some((c) => c.val > 1)).toBe(true);
    expect(mockWithTimingCalls.some((c) => c.val === 0)).toBe(true);
  });

  it('does not slide when mini-prev restarts current track (>3s) with restart-or-previous enabled', () => {
    const track2 = { ...mockTrack, id: 'track-2', title: 'Next Song' };
    playerStore.setState({
      currentTrack: track2,
      currentTrackIndex: 1,
      position: 15,
      queue: [mockTrack, track2],
    });
    playbackSettingsStore.setState({ skipPreviousBehavior: 'restart-or-previous' });

    const { getByTestId } = render(<PlayerPhoneMini />);
    mockWithTimingCalls.length = 0;

    fireEvent.press(getByTestId('mini-prev'));
    expect(playerService.skipToPrevious).toHaveBeenCalledTimes(1);
    expect(mockWithTimingCalls).toHaveLength(0);
  });

  it('flushes rapid multi-taps on mini-next without losing skips', () => {
    mockTimingControl.defer = true;
    const { getByTestId } = render(<PlayerPhoneMini />);

    fireEvent.press(getByTestId('mini-next'));
    // Exit animation hasn't hit midpoint yet
    expect(playerService.skipToNext).not.toHaveBeenCalled();

    // Rapid second tap flushes first skip immediately
    fireEvent.press(getByTestId('mini-next'));
    expect(playerService.skipToNext).toHaveBeenCalledTimes(1);

    // Complete second exit animation callback
    const lastExitCall = mockWithTimingCalls.filter((c) => c.cb).pop();
    act(() => {
      lastExitCall?.cb?.(true);
    });
    expect(playerService.skipToNext).toHaveBeenCalledTimes(2);
  });

  it('animates external track changes and skips duplicate animation for internal skips', () => {
    const track2 = { ...mockTrack, id: 'track-2', title: 'Next Song' };
    const track3 = { ...mockTrack, id: 'track-3', title: 'Third Song' };
    const sharedQueue = [mockTrack, track2, track3];

    playerStore.setState({
      currentTrack: track2,
      currentTrackIndex: 1,
      queue: sharedQueue,
    });

    const { getByTestId } = render(<PlayerPhoneMini />);
    mockWithTimingCalls.length = 0;

    // External advance to track 3 -> animates slide-in
    act(() => {
      playerStore.setState({
        currentTrack: track3,
        currentTrackIndex: 2,
        queue: sharedQueue,
      });
    });
    expect(mockWithTimingCalls.some((c) => c.val === 0)).toBe(true);

    // External jump back to track 1 -> animates slide-in from left
    mockWithTimingCalls.length = 0;
    act(() => {
      playerStore.setState({
        currentTrack: mockTrack,
        currentTrackIndex: 0,
        queue: sharedQueue,
      });
    });
    expect(mockWithTimingCalls.some((c) => c.val === 0)).toBe(true);

    // Internal mini-next triggers skip + store change -> does not double-trigger external anim
    fireEvent.press(getByTestId('mini-next'));
    mockWithTimingCalls.length = 0;
    act(() => {
      playerStore.setState({
        currentTrack: track2,
        currentTrackIndex: 1,
        queue: sharedQueue,
      });
    });
    expect(mockWithTimingCalls).toHaveLength(0);
  });
});
