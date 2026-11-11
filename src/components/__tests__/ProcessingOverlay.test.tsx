jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { card: '#111', textPrimary: '#fff', primary: '#007AFF', red: '#f00' },
  }),
}));

jest.mock('../../hooks/useLayoutMode', () => ({
  useLayoutMode: () => 'phone',
}));

jest.mock('../../store/authStore', () => ({
  authStore: (fn: any) => fn({ isLoggedIn: true }),
}));

jest.mock('../../store/playerStore', () => ({
  playerStore: (fn: any) => fn({ currentTrack: null }),
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: (fn: any) => fn({ downloadQueue: [] }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }),
}));

jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, Text: RN.Text },
    useAnimatedStyle: () => ({}),
    useSharedValue: () => ({ value: 0 }),
    withTiming: () => 0,
    withSpring: () => 0,
  };
});

import { render, screen, act } from '@testing-library/react-native';

import { ProcessingOverlay } from '../ProcessingOverlay';
import {
  processingOverlayStore,
  type OverlayStatus,
} from '../../store/processingOverlayStore';

const BACKDROP = 'processingOverlayBackdrop';

function setStore(patch: { status: OverlayStatus; label: string }) {
  act(() => {
    processingOverlayStore.setState(patch);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  act(() => {
    processingOverlayStore.setState({ status: 'idle', label: '', _showedAt: 0 });
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ProcessingOverlay', () => {
  it('renders nothing while idle', () => {
    render(<ProcessingOverlay />);
    expect(screen.queryByTestId(BACKDROP)).toBeNull();
  });

  it('renders nothing when status is processing or success (fullscreen loaders disabled)', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'processing', label: 'Loading' });
    expect(screen.queryByTestId(BACKDROP)).toBeNull();

    setStore({ status: 'success', label: 'Done' });
    expect(screen.queryByTestId(BACKDROP)).toBeNull();
  });

  it('renders non-blocking error toast when status is error', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'error', label: 'Failed to load songs' });

    const wrapper = screen.getByTestId(BACKDROP);
    // Non-blocking touches pass through
    expect(wrapper.props.pointerEvents).toBe('box-none');
    expect(screen.getByText('Failed to load songs')).toBeTruthy();
  });

  it('auto-dismisses after 3 seconds', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'error', label: 'Network error' });
    expect(screen.getByTestId(BACKDROP)).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    // Dismiss transition started (hide called)
    expect(processingOverlayStore.getState().status).toBe('idle');

    // After animation buffer, unmounts
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId(BACKDROP)).toBeNull();
  });
});
