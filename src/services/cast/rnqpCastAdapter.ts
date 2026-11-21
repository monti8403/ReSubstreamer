import { Cast, type CastReceiver, type CastRoute } from 'react-native-queue-player';

import type {
  CastAdapter,
  CastDevice,
  CastPlaybackState,
  CastProtocolType,
  CastTrackMetadata,
} from './types';

function mapReceiverToCastDevice(receiver: CastReceiver): CastDevice | null {
  if (receiver.castProtocol !== 'chromecast' && receiver.castProtocol !== 'airplay') {
    return null;
  }
  const protocol: CastProtocolType = receiver.castProtocol;
  return {
    id: receiver.id,
    name: receiver.name || receiver.modelName || receiver.id,
    model: receiver.modelName || undefined,
    protocol,
    locationUrl: receiver.id,
    requiresPairing: receiver.capabilities?.requiresPairing ?? false,
    supportsRemoteVolume: receiver.capabilities?.supportsRemoteVolume ?? true,
  };
}

function mapRouteToCastDevice(route: CastRoute): CastDevice | null {
  if (route.castProtocol !== 'chromecast' && route.castProtocol !== 'airplay') {
    return null;
  }
  return {
    id: route.receiverId,
    name: route.name || route.receiverId,
    protocol: route.castProtocol,
    locationUrl: route.receiverId,
    requiresPairing: route.capabilities?.requiresPairing ?? false,
    supportsRemoteVolume: route.capabilities?.supportsRemoteVolume ?? true,
  };
}

/**
 * Adapter wrapping `react-native-queue-player`'s native CastManager
 * (Chromecast + AirPlay) behind Atrum's unified `CastAdapter` contract.
 * Also serves as the clean slot for future Google Cast extensions.
 */
export class RnQpCastAdapter implements CastAdapter {
  readonly protocol = 'chromecast' as const;

  private receiversSub: { remove(): void } | null = null;
  private routeSub: { remove(): void } | null = null;
  private sessionDiedSub: { remove(): void } | null = null;
  private onRouteChangedCallback: ((device: CastDevice | null) => void) | null = null;
  private onReceiversUpdatedCallback: ((devices: CastDevice[]) => void) | null = null;

  setListeners(callbacks: {
    onRouteChanged?: (device: CastDevice | null) => void;
    onReceiversUpdated?: (devices: CastDevice[]) => void;
  }): void {
    this.onRouteChangedCallback = callbacks.onRouteChanged ?? null;
    this.onReceiversUpdatedCallback = callbacks.onReceiversUpdated ?? null;
  }

  isAvailable(): boolean {
    try {
      const protocols = Cast.getSupportedProtocols?.() ?? [];
      return protocols.includes('chromecast') || protocols.includes('airplay');
    } catch {
      return false;
    }
  }

  getActiveRouteDevice(): CastDevice | null {
    try {
      if (typeof Cast.getCurrentRoute !== 'function') return null;
      return mapRouteToCastDevice(Cast.getCurrentRoute());
    } catch {
      return null;
    }
  }

  async startDiscovery(onDeviceFound: (device: CastDevice) => void): Promise<void> {
    this.cleanupSubscriptions();
    if (!this.isAvailable()) return;

    if (typeof Cast.addReceiversListener === 'function') {
      this.receiversSub = Cast.addReceiversListener((receivers) => {
        const mapped = receivers
          .map(mapReceiverToCastDevice)
          .filter((d): d is CastDevice => d !== null);
        this.onReceiversUpdatedCallback?.(mapped);
        for (const d of mapped) {
          onDeviceFound(d);
        }
      });
    }

    if (typeof Cast.addRouteListener === 'function') {
      this.routeSub = Cast.addRouteListener((route) => {
        this.onRouteChangedCallback?.(mapRouteToCastDevice(route));
      });
    }

    if (typeof Cast.addSessionDiedListener === 'function') {
      this.sessionDiedSub = Cast.addSessionDiedListener(() => {
        this.onRouteChangedCallback?.(null);
      });
    }

    try {
      await Cast.startDiscovery();
    } catch {
      // Non-fatal when native discovery is unavailable in tests or restricted devices
    }
  }

  async stopDiscovery(): Promise<void> {
    this.cleanupSubscriptions();
    try {
      await Cast.stopDiscovery();
    } catch {
      // Best-effort
    }
  }

  async connect(device: CastDevice, options?: { password?: string }): Promise<void> {
    await Cast.connect(
      device.id,
      options?.password ? { password: options.password } : undefined,
    );
  }

  async disconnect(): Promise<void> {
    await Cast.disconnect();
  }

  async loadTrack(_track: CastTrackMetadata, _startPositionMs?: number): Promise<void> {
    // Handled natively inside RNQP TrackPlayer when Chromecast/AirPlay route is active
  }

  async play(): Promise<void> {
    // Handled natively via RNQP TrackPlayer
  }

  async pause(): Promise<void> {
    // Handled natively via RNQP TrackPlayer
  }

  async stop(): Promise<void> {
    await Cast.disconnect();
  }

  async seek(_positionMs: number): Promise<void> {
    // Handled natively via RNQP TrackPlayer
  }

  async setVolume(volumePercent: number): Promise<void> {
    if (typeof Cast.setRouteVolume !== 'function') return;
    const normalized = Math.max(0, Math.min(1, volumePercent / 100));
    await Cast.setRouteVolume(normalized);
  }

  async getPlaybackState(): Promise<CastPlaybackState> {
    let volume = 50;
    try {
      if (typeof Cast.getRouteVolume === 'function') {
        const raw = Cast.getRouteVolume();
        if (Number.isFinite(raw)) {
          volume = Math.max(0, Math.min(100, Math.round(raw * 100)));
        }
      }
    } catch {
      // Ignore
    }
    return {
      status: 'idle',
      positionMs: 0,
      durationMs: 0,
      volume,
    };
  }

  private cleanupSubscriptions(): void {
    this.receiversSub?.remove();
    this.receiversSub = null;
    this.routeSub?.remove();
    this.routeSub = null;
    this.sessionDiedSub?.remove();
    this.sessionDiedSub = null;
  }
}
