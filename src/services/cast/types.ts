export type CastProtocolType = 'dlna' | 'chromecast' | 'airplay';

export type DlnaStreamFormatPreference = 'auto' | 'mp3' | 'flac';

export interface CastDevice {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol: CastProtocolType;
  locationUrl: string;
  avTransportControlUrl?: string;
  renderingControlUrl?: string;
  requiresPairing?: boolean;
  supportsRemoteVolume?: boolean;
}

export type CastPlaybackStatus =
  | 'idle'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'error';

export interface CastPlaybackState {
  status: CastPlaybackStatus;
  positionMs: number;
  durationMs: number;
  volume: number;
  currentTrackUri?: string;
}

export interface CastTrackMetadata {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArtUrl?: string | null;
  durationSec: number;
  streamUrl: string;
  mimeType: string;
}

export interface CastAdapter {
  readonly protocol: CastProtocolType;
  startDiscovery(onDeviceFound: (device: CastDevice) => void): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(device: CastDevice, options?: { password?: string }): Promise<void>;
  disconnect(): Promise<void>;
  loadTrack(track: CastTrackMetadata, startPositionMs?: number): Promise<void>;
  setNextTrack?(track: CastTrackMetadata | null): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volumePercent: number): Promise<void>;
  getPlaybackState(): Promise<CastPlaybackState>;
}
