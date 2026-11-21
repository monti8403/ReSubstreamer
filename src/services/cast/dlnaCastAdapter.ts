import type { CastAdapter, CastDevice, CastPlaybackState, CastTrackMetadata } from './types';
import {
  UPNP_AV_TRANSPORT_SERVICE,
  UPNP_RENDERING_CONTROL_SERVICE,
  buildDidlLiteXml,
  buildSoapEnvelope,
  escapeXml,
  formatUpnpDuration,
  mergeCastPlaybackState,
  parseDeviceDescriptionXml,
  parseSoapFault,
} from './dlnaXmlUtils';
import {
  startNativeSsdpDiscovery,
  stopNativeSsdpDiscovery,
  subscribeSsdpDeviceFound,
  subscribeSsdpScanFinished,
} from './nativeCastBridge';

const DISCOVERY_TIMEOUT_MS = 6000;
const DESCRIPTION_FETCH_TIMEOUT_MS = 5000;
const SOAP_TIMEOUT_MS = 4000;
const POLL_SOAP_TIMEOUT_MS = 2500;
const DISCONNECT_STOP_TIMEOUT_MS = 1500;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
    : null;
  try {
    return await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DlnaCastAdapter implements CastAdapter {
  readonly protocol = 'dlna' as const;

  private connectedDevice: CastDevice | null = null;
  private lastKnownVolume = 50;
  private unsubDeviceFound: (() => void) | null = null;
  private unsubScanFinished: (() => void) | null = null;
  private onDiscoveryFinishedCallback: (() => void) | null = null;
  private pendingDescriptionLocations = new Set<string>();

  setOnDiscoveryFinished(cb: (() => void) | null): void {
    this.onDiscoveryFinishedCallback = cb;
  }

  getConnectedDevice(): CastDevice | null {
    return this.connectedDevice;
  }

  async startDiscovery(onDeviceFound: (device: CastDevice) => void): Promise<void> {
    this.cleanupDiscoverySubscriptions();
    this.pendingDescriptionLocations.clear();

    const seenDeviceIds = new Set<string>();

    this.unsubDeviceFound = subscribeSsdpDeviceFound((event) => {
      const location = event.location?.trim();
      if (!location || this.pendingDescriptionLocations.has(location)) return;
      this.pendingDescriptionLocations.add(location);

      void this.fetchAndParseDeviceDescription(location).then((device) => {
        if (!device) return;
        if (seenDeviceIds.has(device.id)) return;
        seenDeviceIds.add(device.id);
        onDeviceFound(device);
      });
    });

    this.unsubScanFinished = subscribeSsdpScanFinished(() => {
      this.cleanupDiscoverySubscriptions();
      this.onDiscoveryFinishedCallback?.();
    });

    try {
      await startNativeSsdpDiscovery(DISCOVERY_TIMEOUT_MS);
    } catch (error) {
      this.cleanupDiscoverySubscriptions();
      this.onDiscoveryFinishedCallback?.();
      throw error;
    }
  }

  async stopDiscovery(): Promise<void> {
    this.cleanupDiscoverySubscriptions();
    this.pendingDescriptionLocations.clear();
    try {
      await stopNativeSsdpDiscovery();
    } catch {
      // Best-effort cleanup
    }
  }

  async connect(device: CastDevice): Promise<void> {
    let resolvedDevice = device;
    if (!resolvedDevice.avTransportControlUrl && resolvedDevice.locationUrl) {
      const refreshed = await this.fetchAndParseDeviceDescription(resolvedDevice.locationUrl);
      if (refreshed) {
        resolvedDevice = refreshed;
      }
    }
    if (!resolvedDevice.avTransportControlUrl) {
      throw new Error(`Device "${device.name}" does not expose AVTransport control URL`);
    }

    this.connectedDevice = resolvedDevice;
    this.lastKnownVolume = 50;

    // Best-effort initial volume query
    if (resolvedDevice.renderingControlUrl) {
      try {
        const state = await this.getPlaybackState();
        this.lastKnownVolume = state.volume;
      } catch {
        // Non-fatal
      }
    }
  }

  async disconnect(): Promise<void> {
    const device = this.connectedDevice;
    this.connectedDevice = null;
    if (device?.avTransportControlUrl) {
      try {
        await this.sendSoapAction(
          device.avTransportControlUrl,
          UPNP_AV_TRANSPORT_SERVICE,
          'Stop',
          '<InstanceID>0</InstanceID>',
          DISCONNECT_STOP_TIMEOUT_MS,
        );
      } catch {
        // Device may be unreachable or already stopped
      }
    }
  }

  async loadTrack(track: CastTrackMetadata, startPositionMs = 0): Promise<void> {
    const controlUrl = this.requireAvTransportUrl();
    const didl = buildDidlLiteXml(track);

    // Best-effort stop before replacing the transport URI (some AVRs require this)
    try {
      await this.sendSoapAction(
        controlUrl,
        UPNP_AV_TRANSPORT_SERVICE,
        'Stop',
        '<InstanceID>0</InstanceID>',
        DISCONNECT_STOP_TIMEOUT_MS,
      );
    } catch {
      // Ignore Stop faults when already stopped / idle
    }

    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'SetAVTransportURI',
      `<InstanceID>0</InstanceID>` +
        `<CurrentURI>${escapeXml(track.streamUrl)}</CurrentURI>` +
        `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`,
    );

    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'Play',
      '<InstanceID>0</InstanceID><Speed>1</Speed>',
    );

    if (startPositionMs > 2000) {
      // Give the renderer a brief moment to initialize the HTTP stream before seeking
      await new Promise((r) => setTimeout(r, 500));
      try {
        await this.seek(startPositionMs);
      } catch {
        // Some renderers reject initial Seek before buffering completes; keep playing from 0
      }
    }
  }

  async setNextTrack(track: CastTrackMetadata | null): Promise<void> {
    const controlUrl = this.connectedDevice?.avTransportControlUrl;
    if (!controlUrl) return;

    try {
      if (!track) {
        await this.sendSoapAction(
          controlUrl,
          UPNP_AV_TRANSPORT_SERVICE,
          'SetNextAVTransportURI',
          '<InstanceID>0</InstanceID><NextURI></NextURI><NextURIMetaData></NextURIMetaData>',
          SOAP_TIMEOUT_MS,
        );
        return;
      }

      const didl = buildDidlLiteXml(track);
      await this.sendSoapAction(
        controlUrl,
        UPNP_AV_TRANSPORT_SERVICE,
        'SetNextAVTransportURI',
        `<InstanceID>0</InstanceID>` +
          `<NextURI>${escapeXml(track.streamUrl)}</NextURI>` +
          `<NextURIMetaData>${escapeXml(didl)}</NextURIMetaData>`,
        SOAP_TIMEOUT_MS,
      );
    } catch {
      // Best-effort: many DLNA renderers (e.g. certain TVs) do not implement SetNextAVTransportURI
    }
  }

  async play(): Promise<void> {
    const controlUrl = this.requireAvTransportUrl();
    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'Play',
      '<InstanceID>0</InstanceID><Speed>1</Speed>',
    );
  }

  async pause(): Promise<void> {
    const controlUrl = this.requireAvTransportUrl();
    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'Pause',
      '<InstanceID>0</InstanceID>',
    );
  }

  async stop(): Promise<void> {
    const controlUrl = this.requireAvTransportUrl();
    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'Stop',
      '<InstanceID>0</InstanceID>',
    );
  }

  async seek(positionMs: number): Promise<void> {
    const controlUrl = this.requireAvTransportUrl();
    const target = formatUpnpDuration(Math.max(0, positionMs) / 1000);
    await this.sendSoapAction(
      controlUrl,
      UPNP_AV_TRANSPORT_SERVICE,
      'Seek',
      `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${target}</Target>`,
    );
  }

  async setVolume(volumePercent: number): Promise<void> {
    const renderingUrl = this.connectedDevice?.renderingControlUrl;
    if (!renderingUrl) return;
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    this.lastKnownVolume = clamped;
    await this.sendSoapAction(
      renderingUrl,
      UPNP_RENDERING_CONTROL_SERVICE,
      'SetVolume',
      `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${clamped}</DesiredVolume>`,
    );
  }

  async getPlaybackState(): Promise<CastPlaybackState> {
    const avUrl = this.requireAvTransportUrl();
    const renderingUrl = this.connectedDevice?.renderingControlUrl;

    const [transportRes, positionRes, volumeRes] = await Promise.allSettled([
      this.sendSoapAction(
        avUrl,
        UPNP_AV_TRANSPORT_SERVICE,
        'GetTransportInfo',
        '<InstanceID>0</InstanceID>',
        POLL_SOAP_TIMEOUT_MS,
      ),
      this.sendSoapAction(
        avUrl,
        UPNP_AV_TRANSPORT_SERVICE,
        'GetPositionInfo',
        '<InstanceID>0</InstanceID>',
        POLL_SOAP_TIMEOUT_MS,
      ),
      renderingUrl
        ? this.sendSoapAction(
            renderingUrl,
            UPNP_RENDERING_CONTROL_SERVICE,
            'GetVolume',
            '<InstanceID>0</InstanceID><Channel>Master</Channel>',
            POLL_SOAP_TIMEOUT_MS,
          )
        : Promise.resolve(null),
    ]);

    const transportXml =
      transportRes.status === 'fulfilled' ? transportRes.value : null;
    const positionXml =
      positionRes.status === 'fulfilled' ? positionRes.value : null;
    const volumeXml =
      volumeRes.status === 'fulfilled' ? volumeRes.value : null;

    if (!transportXml && !positionXml) {
      throw new Error('DLNA renderer did not respond to status poll');
    }

    const merged = mergeCastPlaybackState(
      transportXml,
      positionXml,
      volumeXml,
      this.lastKnownVolume,
    );
    this.lastKnownVolume = merged.volume;
    return merged;
  }

  private cleanupDiscoverySubscriptions(): void {
    this.unsubDeviceFound?.();
    this.unsubDeviceFound = null;
    this.unsubScanFinished?.();
    this.unsubScanFinished = null;
  }

  private requireAvTransportUrl(): string {
    const url = this.connectedDevice?.avTransportControlUrl;
    if (!url) {
      throw new Error('No DLNA device connected');
    }
    return url;
  }

  private async fetchAndParseDeviceDescription(locationUrl: string): Promise<CastDevice | null> {
    try {
      const response = await fetchWithTimeout(
        locationUrl,
        { method: 'GET' },
        DESCRIPTION_FETCH_TIMEOUT_MS,
      );
      if (!response.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[DLNA] Description fetch HTTP ${response.status} for ${locationUrl}`);
        return null;
      }
      const xml = await response.text();
      return parseDeviceDescriptionXml(xml, locationUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[DLNA] Description fetch failed for ${locationUrl}:`, err);
      return null;
    }
  }

  private async sendSoapAction(
    controlUrl: string,
    serviceType: string,
    action: string,
    innerBodyXml: string,
    timeoutMs = SOAP_TIMEOUT_MS,
  ): Promise<string> {
    const body = buildSoapEnvelope(serviceType, action, innerBodyXml);
    const response = await fetchWithTimeout(
      controlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${action}"`,
        },
        body,
      },
      timeoutMs,
    );

    const text = await response.text();
    if (!response.ok) {
      const fault = parseSoapFault(text);
      throw new Error(
        `SOAP ${action} failed (${response.status}): ${fault ?? response.statusText}`,
      );
    }
    return text;
  }
}
