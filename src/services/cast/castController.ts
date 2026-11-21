import { AppState } from 'react-native';
import { getTrackPlayer } from 'react-native-queue-player';

import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { playerStore } from '../../store/playerStore';
import { castStore } from '../../store/castStore';
import { resolveSongCoverArt } from '../../hooks/useSongCoverArt';
import { onTrackAutoAdvanced } from '../autoplayController';
import { persistCurrentIndex } from '../queuePersistenceService';
import { addCompletedScrobble, sendNowPlaying } from '../scrobbleService';
import {
  ensureCoverArtAuth,
  getCoverArtUrl,
  getDlnaStreamUrl,
  type Child,
} from '../subsonicService';
import { DlnaCastAdapter } from './dlnaCastAdapter';
import { RnQpCastAdapter } from './rnqpCastAdapter';
import type {
  CastAdapter,
  CastDevice,
  CastPlaybackState,
  CastPlaybackStatus,
  CastProtocolType,
  CastTrackMetadata,
} from './types';

const DLNA_POLL_INTERVAL_MS = 1500;
const MAX_CONSECUTIVE_POLL_ERRORS = 4;

export interface CastLocalPlayerBridge {
  pauseLocalEngine: () => Promise<void>;
  syncLocalCursor: (index: number, positionSec: number) => Promise<void>;
  onRemoteTrackChanged: (
    outgoingChild: Child | null,
    incomingChild: Child,
    incomingIndex: number,
    isAutoAdvance: boolean,
  ) => void;
  getPlaylistIdForTrack: (trackId: string) => string | undefined;
}

function mapCastStatusToPlayerStatus(status: CastPlaybackStatus) {
  switch (status) {
    case 'playing':
      return 'playing' as const;
    case 'paused':
      return 'paused' as const;
    case 'buffering':
      return 'buffering' as const;
    case 'stopped':
    case 'error':
      return 'stopped' as const;
    case 'idle':
    default:
      return 'idle' as const;
  }
}

function normalizeUriForCompare(uri: string | undefined): string {
  return (uri ?? '').trim();
}

export class CastController {
  private readonly adapters = new Map<CastProtocolType, CastAdapter>();
  private readonly dlnaAdapter: DlnaCastAdapter;
  private readonly rnqpAdapter: RnQpCastAdapter;

  private bridge: CastLocalPlayerBridge | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private consecutivePollErrors = 0;

  private isManualTransition = false;
  private userPausedOrStopped = false;
  private wasPlayingRemote = false;
  private maxPositionMsRemote = 0;
  private activeTrackId: string | null = null;
  private activeStreamUrl: string | null = null;
  private activeTrackScrobbled = false;
  private preloadedNext: {
    index: number;
    track: Child;
    streamUrl: string;
  } | null = null;

  private appStateListenerRegistered = false;

  constructor(options?: {
    dlnaAdapter?: DlnaCastAdapter;
    rnqpAdapter?: RnQpCastAdapter;
  }) {
    this.dlnaAdapter = options?.dlnaAdapter ?? new DlnaCastAdapter();
    this.rnqpAdapter = options?.rnqpAdapter ?? new RnQpCastAdapter();

    this.registerAdapter(this.dlnaAdapter);
    this.registerAdapter(this.rnqpAdapter);

    this.dlnaAdapter.setOnDiscoveryFinished(() => {
      castStore.getState().setIsScanning(false);
    });

    this.rnqpAdapter.setListeners({
      onRouteChanged: (device) => {
        const current = castStore.getState().connectedDevice;
        if (device) {
          if (current?.protocol === 'dlna') {
            return;
          }
          castStore.getState().setConnectedDevice(device);
        } else if (current && current.protocol !== 'dlna') {
          castStore.getState().setConnectedDevice(null);
        }
      },
      onReceiversUpdated: (rnqpDevices) => {
        const dlnaOnly = castStore
          .getState()
          .discoveredDevices.filter((d) => d.protocol === 'dlna');
        castStore.getState().setDiscoveredDevices([...dlnaOnly, ...rnqpDevices]);
      },
    });
  }

  registerAdapter(adapter: CastAdapter): void {
    this.adapters.set(adapter.protocol, adapter);
    if (adapter.protocol === 'chromecast') {
      // RNQP adapter also handles AirPlay when available
      this.adapters.set('airplay', adapter);
    }
  }

  registerLocalPlayerBridge(bridge: CastLocalPlayerBridge | null): void {
    this.bridge = bridge;
  }

  ensureLifecycleListener(): void {
    if (this.appStateListenerRegistered) return;
    if (typeof AppState?.addEventListener !== 'function') return;
    this.appStateListenerRegistered = true;
    AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        void this.stopDiscovery();
      }
    });
  }

  isDlnaSessionActive(): boolean {
    return castStore.getState().connectedDevice?.protocol === 'dlna';
  }

  async startDiscovery(): Promise<void> {
    this.ensureLifecycleListener();
    castStore.getState().setLastError(null);
    castStore.getState().setIsScanning(true);

    // Preserve currently connected device in list if needed, clear stale discovered devices
    const connected = castStore.getState().connectedDevice;
    castStore
      .getState()
      .setDiscoveredDevices(connected ? [connected] : []);

    const seenAdapters = new Set<CastAdapter>();
    const discoveryTasks: Promise<void>[] = [];

    for (const adapter of this.adapters.values()) {
      if (seenAdapters.has(adapter)) continue;
      seenAdapters.add(adapter);
      discoveryTasks.push(
        adapter
          .startDiscovery((device) => {
            castStore.getState().upsertDiscoveredDevice(device);
          })
          .catch(() => {
            // Individual adapter discovery failure shouldn't break other protocols
          }),
      );
    }

    await Promise.allSettled(discoveryTasks);
  }

  async stopDiscovery(): Promise<void> {
    castStore.getState().setIsScanning(false);
    const seenAdapters = new Set<CastAdapter>();
    const stopTasks: Promise<void>[] = [];
    for (const adapter of this.adapters.values()) {
      if (seenAdapters.has(adapter)) continue;
      seenAdapters.add(adapter);
      stopTasks.push(adapter.stopDiscovery().catch(() => {}));
    }
    await Promise.allSettled(stopTasks);
  }

  async connectToDevice(
    device: CastDevice,
    options?: { password?: string },
  ): Promise<void> {
    const adapter = this.adapters.get(device.protocol);
    if (!adapter) {
      throw new Error(`No CastAdapter registered for protocol "${device.protocol}"`);
    }

    castStore.getState().setLastError(null);
    castStore.getState().setConnectingDeviceId(device.id);

    try {
      const existing = castStore.getState().connectedDevice;
      if (existing && existing.id !== device.id) {
        await this.disconnectInternal(false);
      }

      if (device.protocol === 'dlna') {
        const ps = playerStore.getState();
        const currentTrack = ps.currentTrack;
        const startPositionMs = Math.max(0, Math.round((ps.position ?? 0) * 1000));

        await this.pauseLocalEngine();
        await adapter.connect(device, options);

        const connectedDevice =
          (adapter === this.dlnaAdapter ? this.dlnaAdapter.getConnectedDevice() : null) ??
          device;
        castStore.getState().setConnectedDevice(connectedDevice);
        castStore.getState().upsertDiscoveredDevice(connectedDevice);

        if (currentTrack) {
          const index = ps.currentTrackIndex ?? 0;
          await this.loadAndPlayDlnaTrack(currentTrack, index, startPositionMs, false);
        } else {
          playerStore.getState().setPlaybackState('idle');
        }

        this.startDlnaPolling();
      } else {
        await adapter.connect(device, options);
        castStore.getState().setConnectedDevice(device);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to connect';
      castStore.getState().setLastError(msg);
      throw error;
    } finally {
      castStore.getState().setConnectingDeviceId(null);
    }
  }

  async disconnect(): Promise<void> {
    await this.disconnectInternal(true);
  }

  private async disconnectInternal(syncBackToLocal: boolean): Promise<void> {
    this.stopDlnaPolling();
    const device = castStore.getState().connectedDevice;
    const ps = playerStore.getState();
    const currentIndex = ps.currentTrackIndex ?? 0;
    const lastPositionSec = Math.max(0, ps.position ?? 0);
    const hadTrack = ps.currentTrack !== null;

    this.resetRemoteTracking();

    if (device) {
      const adapter = this.adapters.get(device.protocol);
      if (adapter) {
        try {
          await adapter.disconnect();
        } catch {
          // Best-effort disconnect
        }
      }
    }

    castStore.getState().setConnectedDevice(null);

    if (syncBackToLocal && device?.protocol === 'dlna' && hadTrack) {
      await this.syncLocalCursor(currentIndex, lastPositionSec);
      playerStore.getState().setPlaybackState('paused');
    }
  }

  async playTrackFromStore(
    index: number,
    startPositionMs = 0,
    isAutoAdvance = false,
  ): Promise<void> {
    if (!this.isDlnaSessionActive()) return;
    const ps = playerStore.getState();
    const queue = ps.queue;
    if (index < 0 || index >= queue.length) return;
    const track = queue[index];
    const outgoing = ps.currentTrack;

    this.notifyTrackChange(outgoing, track, index, isAutoAdvance);
    await this.loadAndPlayDlnaTrack(track, index, startPositionMs, false);
  }

  async togglePlayPause(): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter) return;

    const status = playerStore.getState().playbackState;
    if (status === 'playing' || status === 'buffering') {
      this.userPausedOrStopped = true;
      await adapter.pause();
      playerStore.getState().setPlaybackState('paused');
      castStore.getState().setPlaybackState({
        ...castStore.getState().playbackState,
        status: 'paused',
      });
    } else {
      this.userPausedOrStopped = false;
      const castStatus = castStore.getState().playbackState.status;
      const ps = playerStore.getState();
      if ((castStatus === 'stopped' || castStatus === 'idle') && ps.currentTrack) {
        await this.loadAndPlayDlnaTrack(
          ps.currentTrack,
          ps.currentTrackIndex ?? 0,
          Math.round((ps.position ?? 0) * 1000),
          false,
        );
      } else {
        await adapter.play();
        playerStore.getState().setPlaybackState('playing');
        castStore.getState().setPlaybackState({
          ...castStore.getState().playbackState,
          status: 'playing',
        });
      }
    }
  }

  async seekTo(positionSec: number): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter) return;
    const targetSec = Math.max(0, positionSec);
    await adapter.seek(targetSec * 1000);
    const store = playerStore.getState();
    store.setProgress(targetSec, store.duration, store.duration);
    castStore.getState().setPlaybackState({
      ...castStore.getState().playbackState,
      positionMs: Math.round(targetSec * 1000),
    });
  }

  async skipToNext(): Promise<void> {
    if (!this.isDlnaSessionActive()) return;
    const ps = playerStore.getState();
    const queue = ps.queue;
    if (queue.length === 0) return;

    const currentIndex = ps.currentTrackIndex ?? 0;
    const repeatMode = playbackSettingsStore.getState().repeatMode;
    let nextIndex = currentIndex + 1;

    if (nextIndex >= queue.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
      } else {
        return;
      }
    }

    await this.playTrackFromStore(nextIndex, 0, false);
  }

  async skipToPrevious(): Promise<void> {
    if (!this.isDlnaSessionActive()) return;
    const ps = playerStore.getState();
    const queue = ps.queue;
    if (queue.length === 0) return;

    const { skipPreviousBehavior } = playbackSettingsStore.getState();
    if (skipPreviousBehavior === 'restart-or-previous' && (ps.position ?? 0) > 3) {
      await this.seekTo(0);
      return;
    }

    const currentIndex = ps.currentTrackIndex ?? 0;
    const repeatMode = playbackSettingsStore.getState().repeatMode;
    let prevIndex = currentIndex - 1;

    if (prevIndex < 0) {
      if (repeatMode === 'all') {
        prevIndex = queue.length - 1;
      } else {
        await this.seekTo(0);
        return;
      }
    }

    await this.playTrackFromStore(prevIndex, 0, false);
  }

  async skipToTrack(index: number): Promise<void> {
    if (!this.isDlnaSessionActive()) return;
    await this.playTrackFromStore(index, 0, false);
  }

  async stopRemotePlayback(): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter) return;
    this.userPausedOrStopped = true;
    this.resetRemoteTracking();
    try {
      await adapter.stop();
    } catch {
      // Best-effort
    }
  }

  async setVolume(volumePercent: number): Promise<void> {
    const device = castStore.getState().connectedDevice;
    if (!device) return;
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    castStore.getState().setVolume(clamped);
    const adapter = this.adapters.get(device.protocol);
    if (adapter) {
      await adapter.setVolume(clamped);
    }
  }

  async syncNextTrack(): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter || !adapter.setNextTrack) return;

    const ps = playerStore.getState();
    const queue = ps.queue;
    const currentIndex = ps.currentTrackIndex ?? 0;
    const repeatMode = playbackSettingsStore.getState().repeatMode;

    let nextIndex: number | null = null;
    if (repeatMode === 'one' && ps.currentTrack) {
      nextIndex = currentIndex;
    } else if (currentIndex + 1 < queue.length) {
      nextIndex = currentIndex + 1;
    } else if (repeatMode === 'all' && queue.length > 0) {
      nextIndex = 0;
    }

    if (nextIndex == null || !queue[nextIndex]) {
      this.preloadedNext = null;
      await adapter.setNextTrack(null);
      return;
    }

    const nextChild = queue[nextIndex];
    const meta = await this.buildTrackMetadata(nextChild);
    if (!meta) {
      this.preloadedNext = null;
      await adapter.setNextTrack(null);
      return;
    }

    this.preloadedNext = {
      index: nextIndex,
      track: nextChild,
      streamUrl: meta.streamUrl,
    };
    await adapter.setNextTrack(meta);
  }

  /**
   * Exposed for unit tests to run one polling iteration deterministically.
   */
  async pollOnce(): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter || this.pollInFlight || this.isManualTransition) return;

    this.pollInFlight = true;
    try {
      const state = await adapter.getPlaybackState();
      this.consecutivePollErrors = 0;
      await this.handleDlnaPollState(state);
    } catch (error) {
      this.consecutivePollErrors += 1;
      if (this.consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        const msg =
          error instanceof Error ? error.message : 'Lost connection to DLNA device';
        castStore.getState().setLastError(msg);
        await this.disconnectInternal(true);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async handleDlnaPollState(state: CastPlaybackState): Promise<void> {
    castStore.getState().setPlaybackState(state);

    const ps = playerStore.getState();
    const currentTrack = ps.currentTrack;
    const currentIndex = ps.currentTrackIndex ?? 0;

    // 1. Check if the renderer auto-advanced to the preloaded next URI (SetNextAVTransportURI)
    if (
      this.preloadedNext &&
      state.currentTrackUri &&
      normalizeUriForCompare(state.currentTrackUri) ===
        normalizeUriForCompare(this.preloadedNext.streamUrl) &&
      normalizeUriForCompare(this.preloadedNext.streamUrl) !==
        normalizeUriForCompare(this.activeStreamUrl ?? undefined)
    ) {
      const outgoing = currentTrack;
      if (outgoing && !this.activeTrackScrobbled) {
        this.activeTrackScrobbled = true;
        this.reportScrobble(outgoing);
      }

      const incoming = this.preloadedNext.track;
      const incomingIndex = this.preloadedNext.index;
      this.activeTrackId = incoming.id;
      this.activeStreamUrl = this.preloadedNext.streamUrl;
      this.activeTrackScrobbled = false;
      this.wasPlayingRemote = state.status === 'playing' || state.status === 'buffering';
      this.maxPositionMsRemote = state.positionMs;
      this.preloadedNext = null;

      this.notifyTrackChange(outgoing, incoming, incomingIndex, true);
      playerStore
        .getState()
        .setPlaybackState(mapCastStatusToPlayerStatus(state.status));
      const durSec =
        state.durationMs > 0 ? state.durationMs / 1000 : (incoming.duration ?? 0);
      playerStore.getState().setProgress(state.positionMs / 1000, durSec, durSec);

      void this.syncNextTrack();
      return;
    }

    // 2. Normal progress & status sync for active track
    const durationSec =
      state.durationMs > 0 ? state.durationMs / 1000 : (currentTrack?.duration ?? 0);
    const positionSec = Math.max(0, state.positionMs / 1000);

    if (state.status === 'playing' || state.status === 'buffering') {
      this.wasPlayingRemote = true;
      this.userPausedOrStopped = false;
      if (state.positionMs > this.maxPositionMsRemote) {
        this.maxPositionMsRemote = state.positionMs;
      }
      playerStore.getState().setProgress(positionSec, durationSec, durationSec);
      playerStore.getState().setPlaybackState(mapCastStatusToPlayerStatus(state.status));

      // Check scrobble milestone
      const triggerPct = playbackSettingsStore.getState().scrobbleTrigger;
      if (
        currentTrack &&
        !this.activeTrackScrobbled &&
        triggerPct < 100 &&
        durationSec > 0 &&
        positionSec >= (durationSec * triggerPct) / 100
      ) {
        this.activeTrackScrobbled = true;
        this.reportScrobble(currentTrack);
      }
      return;
    }

    if (state.status === 'paused') {
      playerStore.getState().setProgress(positionSec, durationSec, durationSec);
      playerStore.getState().setPlaybackState('paused');
      return;
    }

    // 3. Detect natural end-of-track transition: PLAYING -> STOPPED near track end
    if (
      state.status === 'stopped' &&
      this.wasPlayingRemote &&
      !this.userPausedOrStopped
    ) {
      const durationMs =
        state.durationMs > 0
          ? state.durationMs
          : Math.max(0, (currentTrack?.duration ?? 0) * 1000);

      const nearEndThresholdMs =
        durationMs > 0 ? Math.max(1000, durationMs - 8000) : 2000;
      const reachedNearEnd =
        state.positionMs >= nearEndThresholdMs ||
        (state.positionMs === 0 && this.maxPositionMsRemote >= nearEndThresholdMs);

      if (reachedNearEnd) {
        this.wasPlayingRemote = false;
        if (currentTrack && !this.activeTrackScrobbled) {
          this.activeTrackScrobbled = true;
          this.reportScrobble(currentTrack);
        }
        await this.advanceAfterRemoteTrackEnd(currentTrack, currentIndex);
        return;
      }
    }

    playerStore.getState().setPlaybackState(mapCastStatusToPlayerStatus(state.status));
  }

  private async advanceAfterRemoteTrackEnd(
    outgoingTrack: Child | null,
    currentIndex: number,
  ): Promise<void> {
    const ps = playerStore.getState();
    const queue = ps.queue;
    if (queue.length === 0) return;

    const repeatMode = playbackSettingsStore.getState().repeatMode;
    if (repeatMode === 'one' && outgoingTrack) {
      await this.loadAndPlayDlnaTrack(outgoingTrack, currentIndex, 0, true);
      return;
    }

    let nextIndex: number | null = null;
    if (currentIndex + 1 < queue.length) {
      nextIndex = currentIndex + 1;
    } else if (repeatMode === 'all') {
      nextIndex = 0;
    }

    if (nextIndex == null) {
      const dur = outgoingTrack?.duration ?? ps.duration ?? 0;
      if (dur > 0) {
        playerStore.getState().setProgress(dur, dur, dur);
      }
      playerStore.getState().setPlaybackState('stopped');
      return;
    }

    const nextChild = queue[nextIndex];
    this.notifyTrackChange(outgoingTrack, nextChild, nextIndex, true);
    await this.loadAndPlayDlnaTrack(nextChild, nextIndex, 0, false);
  }

  private async loadAndPlayDlnaTrack(
    track: Child,
    _index: number,
    startPositionMs: number,
    isRepeatOneLoop: boolean,
  ): Promise<void> {
    const adapter = this.getActiveDlnaAdapter();
    if (!adapter) return;

    this.isManualTransition = true;
    this.userPausedOrStopped = false;
    this.wasPlayingRemote = false;
    this.maxPositionMsRemote = startPositionMs;
    this.preloadedNext = null;

    if (!isRepeatOneLoop || this.activeTrackId !== track.id) {
      this.activeTrackId = track.id;
      this.activeTrackScrobbled = false;
    } else {
      this.activeTrackScrobbled = false;
    }

    playerStore.getState().setPlaybackState('buffering');
    playerStore.getState().setError(null);

    try {
      const meta = await this.buildTrackMetadata(track);
      if (!meta) {
        throw new Error('Stream URL unavailable while offline or signed out');
      }

      this.activeStreamUrl = meta.streamUrl;
      await adapter.loadTrack(meta, startPositionMs);

      this.wasPlayingRemote = true;
      const startSec = Math.max(0, startPositionMs / 1000);
      const durSec = track.duration ?? 0;
      playerStore.getState().setProgress(startSec, durSec, durSec);
      playerStore.getState().setPlaybackState('playing');
      castStore.getState().setPlaybackState({
        ...castStore.getState().playbackState,
        status: 'playing',
        positionMs: startPositionMs,
        durationMs: durSec * 1000,
        currentTrackUri: meta.streamUrl,
      });

      const playlistId = this.bridge?.getPlaylistIdForTrack(track.id);
      void sendNowPlaying(track, playlistId);
      void this.syncNextTrack();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'DLNA playback error';
      castStore.getState().setLastError(message);
      playerStore.getState().setError(message);
      playerStore.getState().setPlaybackState('stopped');
    } finally {
      this.isManualTransition = false;
    }
  }

  private async buildTrackMetadata(track: Child): Promise<CastTrackMetadata | null> {
    await ensureCoverArtAuth();
    const stream = getDlnaStreamUrl(
      track.id,
      track.suffix,
      castStore.getState().dlnaFormatPreference,
    );
    if (!stream) return null;

    const coverArtId = resolveSongCoverArt(track);
    const coverArtUrl = coverArtId ? getCoverArtUrl(coverArtId, 600) : null;

    return {
      id: track.id,
      title: track.title,
      artist: track.artist ?? 'Unknown Artist',
      album: track.album ?? undefined,
      coverArtUrl,
      durationSec: track.duration ?? 0,
      streamUrl: stream.url,
      mimeType: stream.mimeType,
    };
  }

  private notifyTrackChange(
    outgoingChild: Child | null,
    incomingChild: Child,
    incomingIndex: number,
    isAutoAdvance: boolean,
  ): void {
    if (this.bridge) {
      this.bridge.onRemoteTrackChanged(
        outgoingChild,
        incomingChild,
        incomingIndex,
        isAutoAdvance,
      );
      return;
    }

    if (isAutoAdvance && outgoingChild) {
      onTrackAutoAdvanced(outgoingChild);
    }
    playerStore.getState().setCurrentTrack(incomingChild, incomingIndex);
    persistCurrentIndex(incomingIndex);
  }

  private reportScrobble(track: Child): void {
    const playlistId = this.bridge?.getPlaylistIdForTrack(track.id);
    void addCompletedScrobble(track, playlistId);
  }

  private async pauseLocalEngine(): Promise<void> {
    if (this.bridge) {
      await this.bridge.pauseLocalEngine();
      return;
    }
    try {
      await getTrackPlayer().pause();
    } catch {
      // Ignore in test environments
    }
  }

  private async syncLocalCursor(index: number, positionSec: number): Promise<void> {
    if (this.bridge) {
      await this.bridge.syncLocalCursor(index, positionSec);
      return;
    }
    try {
      const tp = getTrackPlayer();
      if (tp.getCurrentTrackIndex() !== index && index >= 0) {
        await tp.skipToIndex(index);
      }
      if (positionSec > 0) {
        await tp.seekTo(positionSec);
      }
    } catch {
      // Best-effort
    }
  }

  private getActiveDlnaAdapter(): CastAdapter | null {
    if (!this.isDlnaSessionActive()) return null;
    return this.dlnaAdapter;
  }

  private startDlnaPolling(): void {
    this.stopDlnaPolling();
    const timer = setInterval(() => {
      void this.pollOnce();
    }, DLNA_POLL_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pollTimer = timer;
  }

  private stopDlnaPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollInFlight = false;
    this.consecutivePollErrors = 0;
  }

  private resetRemoteTracking(): void {
    this.isManualTransition = false;
    this.userPausedOrStopped = false;
    this.wasPlayingRemote = false;
    this.maxPositionMsRemote = 0;
    this.activeTrackId = null;
    this.activeStreamUrl = null;
    this.activeTrackScrobbled = false;
    this.preloadedNext = null;
  }
}

export const castController = new CastController();
