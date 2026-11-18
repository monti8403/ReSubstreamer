import React from 'react';
import { render, act } from '@testing-library/react-native';

const pendingCallbacks: Array<(done: boolean) => void> = [];

jest.mock('react-native-reanimated', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      View,
      createAnimatedComponent: (Comp: unknown) => Comp,
    },
    useSharedValue: (init: number) => ReactActual.useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    useAnimatedProps: (fn: () => object) => fn(),
    withTiming: (val: number, _config?: object, cb?: (done: boolean) => void) => {
      if (cb) pendingCallbacks.push(cb);
      return val;
    },
    withDelay: (_ms: number, val: unknown) => val,
    withSequence: (...args: unknown[]) => args[args.length - 1],
    interpolate: (_v: number, _input: number[], output: number[]) => output[0],
    Easing: {
      out: (e: unknown) => e,
      inOut: (e: unknown) => e,
      cubic: (t: number) => t,
      quad: (t: number) => t,
    },
    runOnJS: (fn: Function) => fn,
  };
});

jest.mock('react-native-svg', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ children, ...props }: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, { testID: 'atrum-splash-svg', ...props }, children),
    G: ({ children }: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, children),
    Path: (props: Record<string, unknown>) => ReactActual.createElement(View, props),
  };
});

const { AtrumAnimatedSplash } = require('../AtrumAnimatedSplash');

describe('AtrumAnimatedSplash', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    pendingCallbacks.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('invokes onReady when laid out and holds exit until canExit=true and intro completes', () => {
    const onReady = jest.fn();
    const onFinish = jest.fn();

    const { rerender, UNSAFE_getByProps } = render(
      <AtrumAnimatedSplash onReady={onReady} canExit={false} onFinish={onFinish} />,
    );

    const container = UNSAFE_getByProps({ pointerEvents: 'auto' });
    act(() => {
      container.props.onLayout?.();
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    // Intro completion callback (`ring2`) runs.
    const introCb = pendingCallbacks[0];
    act(() => {
      introCb?.(true);
      jest.advanceTimersByTime(64);
    });
    // Still blocked while canExit is false.
    expect(onFinish).not.toHaveBeenCalled();

    rerender(<AtrumAnimatedSplash onReady={onReady} canExit={true} onFinish={onFinish} />);

    act(() => {
      jest.advanceTimersByTime(32);
    });

    // Exit animation callback fires onFinish.
    const exitCb = pendingCallbacks[pendingCallbacks.length - 1];
    act(() => {
      exitCb?.(true);
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
