jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../subsonicService', () => ({
  ensureCoverArtAuth: jest.fn().mockResolvedValue(undefined),
  getCoverArtUrl: jest.fn((id: string) => `https://srv/rest/getCoverArt.view?id=${id}`),
  getDlnaStreamUrl: jest.fn((trackId: string, suffix?: string, pref?: string) => {
    const fmt =
      pref === 'flac'
        ? 'flac'
        : pref === 'mp3' || suffix === 'opus' || suffix === 'ogg'
          ? 'mp3'
          : suffix || 'mp3';
    return {
      url: `https://srv/rest/stream.view?id=${trackId}&format=${fmt}`,
      mimeType: fmt === 'flac' ? 'audio/flac' : 'audio/mpeg',
    };
  }),
}));

const mockOnTrackAutoAdvanced = jest.fn();
jest.mock('../../autoplayController', () => ({
  onTrackAutoAdvanced: (...args: unknown[]) => mockOnTrackAutoAdvanced(...args),
}));

const mockAddCompletedScrobble = jest.fn();
const mockSendNowPlaying = jest.fn();
jest.mock('../../scrobbleService', () => ({
  addCompletedScrobble: (...args: unknown[]) => mockAddCompletedScrobble(...args),
  sendNowPlaying: (...args: unknown[]) => mockSendNowPlaying(...args),
}));

const mockPersistCurrentIndex = jest.fn();
jest.mock('../../queuePersistenceService', () => ({
  persistCurrentIndex: (...args: unknown[]) => mockPersistCurrentIndex(...args),
}));

import { getTrackPlayer } from 'react-native-queue-player';
import { castStore } from '../../../store/castStore';
import { playbackSettingsStore } from '../../../store/playbackSettingsStore';
import { playerStore } from '../../../store/playerStore';
import type { Child } from '../../subsonicService';
import { CastController } from '../castController';
import type { DlnaCastAdapter } from '../dlnaCastAdapter';
import type { RnQpCastAdapter } from '../rnqpCastAdapter';
import type { CastDevice, CastPlaybackState } from '../types';

function makeTrack(id: string, title: string, suffix = 'flac', duration = 200): Child {
  return {
    id,
    title,
    artist: 'Test Artist',
    album: 'Test Album',
    coverArt: `art-${id}`,
    suffix,
    duration,
    isDir: false,
    parent: 'p1',
  } as Child;
}

const DLNA_DEVICE: CastDevice = {
  id: 'dlna:kodi-1',
  name: 'Kodi Living Room',
  manufacturer: 'XBMC',
  model: 'Kodi',
  protocol: 'dlna',
  locationUrl: 'http://192.168.1.25:1826/desc.xml',
  avTransportControlUrl: 'http://192.168.1.25:1826/AVTransport/control',
  renderingControlUrl: 'http://192.168.1.25:1826/RenderingControl/control',
  supportsRemoteVolume: true,
};

function createMockDlnaAdapter() {
  let state: CastPlaybackState = {
    status: 'playing',
    positionMs: 0,
    durationMs: 200000,
    volume: 65,
  };
  return {
    protocol: 'dlna' as const,
    setOnDiscoveryFinished: jest.fn(),
    getConnectedDevice: jest.fn(() => DLNA_DEVICE),
    startDiscovery: jest.fn().mockResolvedValue(undefined),
    stopDiscovery: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    loadTrack: jest.fn().mockResolvedValue(undefined),
    setNextTrack: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    seek: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
    getPlaybackState: jest.fn(async () => state),
    __setMockState: (next: CastPlaybackState) => {
      state = next;
    },
  };
}

function createMockRnqpAdapter() {
  return {
    protocol: 'chromecast' as const,
    setListeners: jest.fn(),
    isAvailable: jest.fn(() => false),
    getActiveRouteDevice: jest.fn(() => null),
    startDiscovery: jest.fn().mockResolvedValue(undefined),
    stopDiscovery: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    loadTrack: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    seek: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
    getPlaybackState: jest.fn().mockResolvedValue({
      status: 'idle',
      positionMs: 0,
      durationMs: 0,
      volume: 50,
    }),
  };
}

describe('CastController', () => {
  const track1 = makeTrack('t1', 'Song One', 'opus', 180);
  const track2 = makeTrack('t2', 'Song Two', 'flac', 210);
  const track3 = makeTrack('t3', 'Song Three', 'mp3', 190);

  let mockDlna: ReturnType<typeof createMockDlnaAdapter>;
  let mockRnqp: ReturnType<typeof createMockRnqpAdapter>;
  let controller: CastController;

  beforeEach(() => {
    jest.clearAllMocks();
    castStore.getState().reset();
    playbackSettingsStore.setState({
      repeatMode: 'off',
      scrobbleTrigger: 50,
      dlnaFormatPreference: 'auto',
      skipPreviousBehavior: 'always-previous',
    });
    playerStore.setState({
      queue: [track1, track2, track3],
      currentTrack: track1,
      currentTrackIndex: 0,
      playbackState: 'playing',
      position: 42,
      duration: 180,
      bufferedPosition: 80,
      error: null,
    });

    mockDlna = createMockDlnaAdapter();
    mockRnqp = createMockRnqpAdapter();
    controller = new CastController({
      dlnaAdapter: mockDlna as unknown as DlnaCastAdapter,
      rnqpAdapter: mockRnqp as unknown as RnQpCastAdapter,
    });
  });

  afterEach(async () => {
    await controller.disconnect();
  });

  it('performs local -> DLNA handoff: pauses Media3, loads HTTP Subsonic URL at saved position, and preloads next track', async () => {
    const tp = getTrackPlayer();

    await controller.connectToDevice(DLNA_DEVICE);

    expect(tp.pause).toHaveBeenCalledTimes(1);
    expect(mockDlna.connect).toHaveBeenCalledWith(DLNA_DEVICE, undefined);
    expect(castStore.getState().connectedDevice?.id).toBe(DLNA_DEVICE.id);

    // Track 1 has suffix 'opus' -> auto mode falls back to format=mp3
    expect(mockDlna.loadTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't1',
        streamUrl: 'https://srv/rest/stream.view?id=t1&format=mp3',
        mimeType: 'audio/mpeg',
      }),
      42000,
    );

    expect(mockSendNowPlaying).toHaveBeenCalledWith(track1, undefined);

    // Wait a tick for fire-and-forget syncNextTrack
    await Promise.resolve();
    expect(mockDlna.setNextTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't2',
        streamUrl: 'https://srv/rest/stream.view?id=t2&format=flac',
        mimeType: 'audio/flac',
      }),
    );
  });

  it('auto-advances to the next track when DLNA transitions PLAYING -> STOPPED near track end and notifies AutoplayController', async () => {
    await controller.connectToDevice(DLNA_DEVICE);
    mockDlna.loadTrack.mockClear();
    mockSendNowPlaying.mockClear();

    // Simulate active playback past 50% scrobble threshold and near track end
    mockDlna.__setMockState({
      status: 'playing',
      positionMs: 175000,
      durationMs: 180000,
      volume: 65,
      currentTrackUri: 'https://srv/rest/stream.view?id=t1&format=mp3',
    });
    await controller.pollOnce();

    expect(mockAddCompletedScrobble).toHaveBeenCalledWith(track1, undefined);
    expect(playerStore.getState().position).toBe(175);

    // Renderer reports STOPPED at track end (RelTime reset to 0 as Kodi/Sonos often do)
    mockDlna.__setMockState({
      status: 'stopped',
      positionMs: 0,
      durationMs: 180000,
      volume: 65,
    });
    await controller.pollOnce();

    expect(mockOnTrackAutoAdvanced).toHaveBeenCalledWith(track1);
    expect(playerStore.getState().currentTrack?.id).toBe('t2');
    expect(playerStore.getState().currentTrackIndex).toBe(1);
    expect(mockPersistCurrentIndex).toHaveBeenCalledWith(1);
    expect(mockDlna.loadTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't2' }),
      0,
    );
  });

  it('detects gapless SetNextAVTransportURI track switch via currentTrackUri change', async () => {
    await controller.connectToDevice(DLNA_DEVICE);
    await Promise.resolve();

    mockDlna.__setMockState({
      status: 'playing',
      positionMs: 2000,
      durationMs: 210000,
      volume: 65,
      currentTrackUri: 'https://srv/rest/stream.view?id=t2&format=flac',
    });
    await controller.pollOnce();

    expect(mockAddCompletedScrobble).toHaveBeenCalledWith(track1, undefined);
    expect(mockOnTrackAutoAdvanced).toHaveBeenCalledWith(track1);
    expect(playerStore.getState().currentTrack?.id).toBe('t2');
    expect(playerStore.getState().currentTrackIndex).toBe(1);
  });

  it('performs DLNA -> local handoff on disconnect and syncs local Media3 cursor to current position', async () => {
    const tp = getTrackPlayer();
    (tp.getCurrentTrackIndex as jest.Mock).mockReturnValue(0);

    await controller.connectToDevice(DLNA_DEVICE);
    await controller.skipToTrack(1);
    playerStore.setState({ position: 77, currentTrack: track2, currentTrackIndex: 1 });

    await controller.disconnect();

    expect(mockDlna.disconnect).toHaveBeenCalledTimes(1);
    expect(castStore.getState().connectedDevice).toBeNull();
    expect(tp.skipToIndex).toHaveBeenCalledWith(1);
    expect(tp.seekTo).toHaveBeenCalledWith(77);
    expect(playerStore.getState().playbackState).toBe('paused');
  });
});
