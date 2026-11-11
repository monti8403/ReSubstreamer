import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { PlayerPhoneMini } from '../PlayerPhoneMini';
import { playerStore } from '@/store/playerStore';
import { playbackSettingsStore } from '@/store/playbackSettingsStore';
import * as playerService from '@/services/playerService';

jest.mock('@/store/persistence/kvStorage', () => require('@/store/persistence/__mocks__/kvStorage'));

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
    withTiming: (val: number) => val,
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
    playerStore.setState({
      currentTrack: mockTrack,
      playbackState: 'playing',
      position: 50,
      duration: 200,
      queueLoading: false,
      currentTrackIndex: 0,
      queue: [mockTrack, { ...mockTrack, id: 'track-2', title: 'Next Song' }],
      playbackHistory: [],
      error: null,
    });
    playbackSettingsStore.setState({
      repeatMode: 'off',
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
});
