import { create } from 'zustand';

import type {
  CastDevice,
  CastPlaybackState,
  DlnaStreamFormatPreference,
} from '../services/cast/types';
import { playbackSettingsStore } from './playbackSettingsStore';

export interface CastState {
  connectedDevice: CastDevice | null;
  connectingDeviceId: string | null;
  discoveredDevices: CastDevice[];
  isScanning: boolean;
  playbackState: CastPlaybackState;
  lastError: string | null;
  dlnaFormatPreference: DlnaStreamFormatPreference;

  setConnectedDevice: (device: CastDevice | null) => void;
  setConnectingDeviceId: (deviceId: string | null) => void;
  upsertDiscoveredDevice: (device: CastDevice) => void;
  setDiscoveredDevices: (devices: CastDevice[]) => void;
  clearDiscoveredDevices: () => void;
  setIsScanning: (isScanning: boolean) => void;
  setPlaybackState: (state: CastPlaybackState) => void;
  setVolume: (volume: number) => void;
  setLastError: (error: string | null) => void;
  setDlnaFormatPreference: (pref: DlnaStreamFormatPreference) => void;
  reset: () => void;
}

const INITIAL_PLAYBACK_STATE: CastPlaybackState = {
  status: 'idle',
  positionMs: 0,
  durationMs: 0,
  volume: 50,
};

function readInitialDlnaPreference(): DlnaStreamFormatPreference {
  try {
    return playbackSettingsStore.getState?.()?.dlnaFormatPreference ?? 'auto';
  } catch {
    return 'auto';
  }
}

export const castStore = create<CastState>()((set) => ({
  connectedDevice: null,
  connectingDeviceId: null,
  discoveredDevices: [],
  isScanning: false,
  playbackState: { ...INITIAL_PLAYBACK_STATE },
  lastError: null,
  dlnaFormatPreference: readInitialDlnaPreference(),

  setConnectedDevice: (connectedDevice) =>
    set({
      connectedDevice,
      lastError: null,
      ...(connectedDevice ? {} : { playbackState: { ...INITIAL_PLAYBACK_STATE } }),
    }),

  setConnectingDeviceId: (connectingDeviceId) => set({ connectingDeviceId }),

  upsertDiscoveredDevice: (device) =>
    set((state) => {
      const idx = state.discoveredDevices.findIndex(
        (d) =>
          d.id === device.id ||
          (d.protocol === device.protocol &&
            d.locationUrl.length > 0 &&
            d.locationUrl === device.locationUrl),
      );
      if (idx === -1) {
        return { discoveredDevices: [...state.discoveredDevices, device] };
      }
      const next = state.discoveredDevices.slice();
      next[idx] = { ...next[idx], ...device };
      return { discoveredDevices: next };
    }),

  setDiscoveredDevices: (discoveredDevices) => set({ discoveredDevices }),

  clearDiscoveredDevices: () => set({ discoveredDevices: [] }),

  setIsScanning: (isScanning) => set({ isScanning }),

  setPlaybackState: (playbackState) => set({ playbackState }),

  setVolume: (volume) =>
    set((state) => ({
      playbackState: {
        ...state.playbackState,
        volume: Math.max(0, Math.min(100, Math.round(volume))),
      },
    })),

  setLastError: (lastError) => set({ lastError }),

  setDlnaFormatPreference: (dlnaFormatPreference) => {
    try {
      playbackSettingsStore.getState?.()?.setDlnaFormatPreference?.(dlnaFormatPreference);
    } catch {
      // ignore if mocked in tests
    }
    set({ dlnaFormatPreference });
  },

  reset: () =>
    set({
      connectedDevice: null,
      connectingDeviceId: null,
      discoveredDevices: [],
      isScanning: false,
      playbackState: { ...INITIAL_PLAYBACK_STATE },
      lastError: null,
      dlnaFormatPreference: readInitialDlnaPreference(),
    }),
}));

if (typeof playbackSettingsStore.subscribe === 'function') {
  playbackSettingsStore.subscribe((state, prev) => {
    if (state.dlnaFormatPreference !== prev.dlnaFormatPreference) {
      castStore.setState({ dlnaFormatPreference: state.dlnaFormatPreference });
    }
  });
}
