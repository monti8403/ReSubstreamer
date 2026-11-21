jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1D9BF0',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      border: '#333333',
      card: '#1e1e1e',
      inputBg: '#2a2a2a',
    },
  }),
}));

jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

jest.mock('../../services/cast/castController', () => ({
  castController: {
    startDiscovery: jest.fn().mockResolvedValue(undefined),
    stopDiscovery: jest.fn().mockResolvedValue(undefined),
    connectToDevice: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/cast/nativeCastBridge', () => ({
  openSystemOutputSwitcher: jest.fn().mockResolvedValue('mediarouter2'),
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { castController } from '../../services/cast/castController';
import { openSystemOutputSwitcher } from '../../services/cast/nativeCastBridge';
import { castStore } from '../../store/castStore';
import { DevicePickerSheet } from '../DevicePickerSheet';
import { useRoutePickerStore } from '../RoutePicker/useRoutePickerStore';

const flush = () => act(async () => {});

describe('DevicePickerSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    castStore.getState().reset();
    act(() => useRoutePickerStore.getState().close());
  });

  it('renders nothing and does not start discovery when closed', async () => {
    render(<DevicePickerSheet />);
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
    expect(castController.startDiscovery).not.toHaveBeenCalled();
    await flush();
  });

  it('starts discovery when opened and renders system output switcher + discovered DLNA device', async () => {
    castStore.setState({
      discoveredDevices: [
        {
          id: 'dlna:sonos-1',
          name: 'Sonos Living Room',
          manufacturer: 'Sonos',
          model: 'One',
          protocol: 'dlna',
          locationUrl: 'http://192.168.1.40:1400/desc.xml',
          avTransportControlUrl: 'http://192.168.1.40:1400/ctrl',
          supportsRemoteVolume: true,
        },
      ],
    });

    act(() => useRoutePickerStore.getState().open());
    render(<DevicePickerSheet />);

    expect(screen.getByTestId('bottom-sheet')).toBeTruthy();
    expect(castController.startDiscovery).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Sonos Living Room')).toBeTruthy();

    fireEvent.press(screen.getByTestId('device-picker-system-output'));
    expect(openSystemOutputSwitcher).toHaveBeenCalledTimes(1);

    await flush();
  });

  it('displays volume control and disconnect button when connected to a remote device', async () => {
    castStore.setState({
      connectedDevice: {
        id: 'dlna:kodi',
        name: 'Kodi TV',
        protocol: 'dlna',
        locationUrl: 'http://192.168.1.20:1826/desc.xml',
        avTransportControlUrl: 'http://192.168.1.20:1826/ctrl',
        renderingControlUrl: 'http://192.168.1.20:1826/render',
        supportsRemoteVolume: true,
      },
      playbackState: {
        status: 'playing',
        positionMs: 12000,
        durationMs: 180000,
        volume: 75,
      },
    });

    act(() => useRoutePickerStore.getState().open());
    render(<DevicePickerSheet />);

    expect(screen.getByText('Kodi TV')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();

    fireEvent.press(screen.getByTestId('device-picker-disconnect'));
    expect(castController.disconnect).toHaveBeenCalledTimes(1);

    await flush();
  });

  it('stops discovery when closed', async () => {
    act(() => useRoutePickerStore.getState().open());
    const { rerender } = render(<DevicePickerSheet />);

    act(() => useRoutePickerStore.getState().close());
    rerender(<DevicePickerSheet />);

    expect(castController.stopDiscovery).toHaveBeenCalledTimes(1);
    await flush();
  });
});
