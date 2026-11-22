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
    addManualDlnaDevice: jest.fn().mockResolvedValue({
      id: 'dlna:manual-kodi',
      name: 'Kodi',
      protocol: 'dlna',
      locationUrl: 'http://192.168.0.56:1225/',
    }),
    connectToDevice: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/cast/nativeCastBridge', () => ({
  checkLocalNetworkPermission: jest.fn().mockResolvedValue('not_required'),
  getSystemAudioState: jest.fn().mockResolvedValue(null),
  openSystemOutputSwitcher: jest.fn().mockResolvedValue('mediarouter2'),
  requestLocalNetworkPermission: jest.fn().mockResolvedValue('not_required'),
  selectSystemAudioRoute: jest.fn().mockResolvedValue(true),
  setSystemMediaVolume: jest.fn().mockResolvedValue(50),
  subscribeSystemRoutesChanged: jest.fn().mockReturnValue(jest.fn()),
}));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { castController } from '../../services/cast/castController';
import {
  checkLocalNetworkPermission,
  getSystemAudioState,
  openSystemOutputSwitcher,
  requestLocalNetworkPermission,
  selectSystemAudioRoute,
  setSystemMediaVolume,
} from '../../services/cast/nativeCastBridge';
import { castStore } from '../../store/castStore';
import { DevicePickerSheet } from '../DevicePickerSheet';
import { useRoutePickerStore } from '../RoutePicker/useRoutePickerStore';

const flush = () => act(async () => {});

describe('DevicePickerSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkLocalNetworkPermission as jest.Mock).mockResolvedValue('not_required');
    (requestLocalNetworkPermission as jest.Mock).mockResolvedValue('not_required');
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
    await waitFor(() => {
      expect(castController.startDiscovery).toHaveBeenCalledTimes(1);
    });
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

  it('shows active Bluetooth device name, media volume slider, and lets user switch system routes directly', async () => {
    (getSystemAudioState as jest.Mock).mockResolvedValue({
      volumePercent: 40,
      routes: [
        { id: 'speaker', name: 'Phone', kind: 'speaker', isSelected: false },
        { id: 'bt-echo', name: 'Echo Dot-0HP', kind: 'bluetooth', isSelected: true },
      ],
    });

    act(() => useRoutePickerStore.getState().open());
    render(<DevicePickerSheet />);

    await waitFor(() => {
      expect(screen.getAllByText('Echo Dot-0HP').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('local-volume-slider')).toBeTruthy();
      expect(screen.getByText('40%')).toBeTruthy();
    });

    expect(screen.getAllByText('Bluetooth audio').length).toBeGreaterThanOrEqual(1);

    fireEvent(screen.getByTestId('local-volume-slider'), 'valueChange', 55);
    expect(setSystemMediaVolume).toHaveBeenCalledWith(55);

    fireEvent(screen.getByTestId('local-volume-slider'), 'slidingComplete', 65);
    expect(setSystemMediaVolume).toHaveBeenCalledWith(65);

    fireEvent.press(screen.getByTestId('system-route-speaker'));
    await waitFor(() => {
      expect(selectSystemAudioRoute).toHaveBeenCalledWith('speaker');
    });

    await flush();
  });

  it('hides manual UPnP IP box by default and connects via + toggle', async () => {
    (getSystemAudioState as jest.Mock).mockResolvedValue(null);

    act(() => useRoutePickerStore.getState().open());
    render(<DevicePickerSheet />);

    expect(screen.queryByTestId('manual-dlna-box')).toBeNull();

    fireEvent.press(screen.getByTestId('device-picker-toggle-manual'));
    expect(screen.getByTestId('manual-dlna-box')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('manual-dlna-input'), '192.168.0.56:1225');
    fireEvent.press(screen.getByTestId('manual-dlna-submit'));

    await waitFor(() => {
      expect(castController.addManualDlnaDevice).toHaveBeenCalledWith('192.168.0.56:1225');
    });

    await flush();
  });

  it('shows local network permission card when denied and retries discovery when granted', async () => {
    (requestLocalNetworkPermission as jest.Mock).mockResolvedValue('denied');

    act(() => useRoutePickerStore.getState().open());
    render(<DevicePickerSheet />);

    await waitFor(() => {
      expect(screen.getByTestId('local-network-permission-card')).toBeTruthy();
    });
    expect(castController.startDiscovery).not.toHaveBeenCalled();

    (requestLocalNetworkPermission as jest.Mock).mockResolvedValue('granted');
    fireEvent.press(screen.getByTestId('local-network-permission-button'));

    await waitFor(() => {
      expect(castController.startDiscovery).toHaveBeenCalledTimes(1);
    });

    await flush();
  });
});
