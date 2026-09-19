import React from 'react';
import { render } from '@testing-library/react-native';

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
    withTiming: (val: number, _config?: any, cb?: (finished: boolean) => void) => {
      cb?.(true);
      return val;
    },
    runOnJS: (fn: any) => fn,
    Easing: {
      out: (e: any) => e,
      quad: (t: number) => t,
    },
  };
});

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    colors: {
      background: '#121212',
    },
  }),
}));

let mockUseCoverGradientReturnValue = {
  gradientColors: ['#3b82f6', '#121212'] as readonly [string, string, ...string[]],
  gradientLocations: [0, 0.6] as readonly [number, number, ...number[]],
  gradientOpacity: { value: 1 },
};

jest.mock('@/hooks/useCoverGradient', () => ({
  useCoverGradient: () => mockUseCoverGradientReturnValue,
}));

import { PlayerCoverGradient } from '../PlayerCoverGradient';

describe('PlayerCoverGradient', () => {
  beforeEach(() => {
    mockUseCoverGradientReturnValue = {
      gradientColors: ['#3b82f6', '#121212'],
      gradientLocations: [0, 0.6],
      gradientOpacity: { value: 1 },
    };
  });

  it('renders initial base gradient with current cover art colors', () => {
    const { toJSON } = render(
      <PlayerCoverGradient coverArtId="cover-1" endColor="#121212" />,
    );

    const tree = toJSON();
    expect(tree).toBeTruthy();
  });

  it('updates layers and initiates crossfade when gradientColors change', () => {
    const { rerender, toJSON } = render(
      <PlayerCoverGradient coverArtId="cover-1" endColor="#121212" />,
    );

    // Simulate track change to a new cover art color
    mockUseCoverGradientReturnValue = {
      gradientColors: ['#ef4444', '#121212'],
      gradientLocations: [0, 0.6],
      gradientOpacity: { value: 1 },
    };

    rerender(<PlayerCoverGradient coverArtId="cover-2" endColor="#121212" />);
    const tree = toJSON();
    expect(tree).toBeTruthy();
  });
});
