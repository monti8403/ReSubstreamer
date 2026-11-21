import type { CastDevice, CastPlaybackState, CastPlaybackStatus, CastTrackMetadata } from './types';

export const UPNP_AV_TRANSPORT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
export const UPNP_RENDERING_CONTROL_SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripCdata(raw: string): string {
  const trimmed = raw.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return cdataMatch ? cdataMatch[1] : trimmed;
}

/**
 * Extract the inner text of the first matching XML tag (namespace-prefix tolerant).
 */
export function extractXmlTag(xml: string, tagName: string): string | undefined {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escapedTag}>`,
    'i',
  );
  const match = regex.exec(xml);
  if (!match) return undefined;
  return unescapeXml(stripCdata(match[1])).trim();
}

/**
 * Extract all XML blocks for a given tag name using balanced open/close tag
 * matching so nested blocks (e.g. UPnP `<device>` inside `<deviceList>`) are
 * captured individually.
 */
export function extractAllXmlBlocks(xml: string, tagName: string): string[] {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRegex = new RegExp(
    `<(\\/?)(?:[a-zA-Z0-9_-]+:)?${escapedTag}(?:\\s[^>]*)?(\\/?)>`,
    'gi',
  );
  const blocks: string[] = [];
  const openStarts: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const isSelfClosing = match[2] === '/';
    if (isSelfClosing) {
      if (!isClosing) {
        blocks.push(match[0]);
      }
      continue;
    }
    if (!isClosing) {
      openStarts.push(match.index);
    } else if (openStarts.length > 0) {
      const start = openStarts.pop()!;
      blocks.push(xml.slice(start, match.index + match[0].length));
    }
  }

  return blocks;
}

/**
 * Resolve a relative or absolute UPnP control URL against a base location URL.
 */
export function resolveUpnpUrl(baseUrl: string, controlUrl: string): string {
  const trimmed = controlUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const baseMatch = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(baseUrl.trim());
  if (!baseMatch) return trimmed;
  const origin = baseMatch[1];
  const basePath = baseMatch[2] || '/';

  if (trimmed.startsWith('/')) {
    return `${origin}${trimmed}`;
  }

  const lastSlash = basePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : '/';
  return `${origin}${dir}${trimmed}`;
}

/**
 * Parse a UPnP device description XML document fetched from SSDP `LOCATION`.
 * Returns `null` if the device is neither a MediaRenderer nor exposes AVTransport:1.
 */
export function parseDeviceDescriptionXml(
  xml: string,
  locationUrl: string,
): CastDevice | null {
  if (!xml || typeof xml !== 'string') return null;

  const urlBase = extractXmlTag(xml, 'URLBase');
  const baseForResolution =
    urlBase && /^https?:\/\//i.test(urlBase) ? urlBase : locationUrl;

  const services = extractAllXmlBlocks(xml, 'service');
  let avTransportControlUrl: string | undefined;
  let renderingControlUrl: string | undefined;

  for (const svc of services) {
    const serviceType = extractXmlTag(svc, 'serviceType') ?? '';
    const controlUrl = extractXmlTag(svc, 'controlURL');
    if (!controlUrl) continue;

    if (
      !avTransportControlUrl &&
      serviceType.toLowerCase().includes('urn:schemas-upnp-org:service:avtransport:')
    ) {
      avTransportControlUrl = resolveUpnpUrl(baseForResolution, controlUrl);
    } else if (
      !renderingControlUrl &&
      serviceType.toLowerCase().includes('urn:schemas-upnp-org:service:renderingcontrol:')
    ) {
      renderingControlUrl = resolveUpnpUrl(baseForResolution, controlUrl);
    }
  }

  const hasMediaRendererType = /urn:schemas-upnp-org:device:mediarenderer:/i.test(xml);
  if (!avTransportControlUrl && !hasMediaRendererType) {
    return null;
  }
  // A renderer must expose AVTransport controlURL for us to cast audio to it.
  if (!avTransportControlUrl) {
    return null;
  }

  // Prefer the innermost <device> block that declares MediaRenderer / AVTransport if nested.
  let targetDeviceBlock = xml;
  const deviceBlocks = extractAllXmlBlocks(xml, 'device');
  if (deviceBlocks.length > 0) {
    const rendererBlock = deviceBlocks.find(
      (b) =>
        /urn:schemas-upnp-org:device:mediarenderer:/i.test(b) ||
        /urn:schemas-upnp-org:service:avtransport:/i.test(b),
    );
    if (rendererBlock) {
      targetDeviceBlock = rendererBlock;
    }
  }

  const friendlyName =
    extractXmlTag(targetDeviceBlock, 'friendlyName') ??
    extractXmlTag(xml, 'friendlyName') ??
    'DLNA Renderer';
  const manufacturer =
    extractXmlTag(targetDeviceBlock, 'manufacturer') ??
    extractXmlTag(xml, 'manufacturer');
  const modelName =
    extractXmlTag(targetDeviceBlock, 'modelName') ??
    extractXmlTag(xml, 'modelName') ??
    extractXmlTag(targetDeviceBlock, 'modelDescription');
  const udn =
    extractXmlTag(targetDeviceBlock, 'UDN') ??
    extractXmlTag(xml, 'UDN') ??
    locationUrl;

  const cleanId = udn.replace(/^uuid:/i, '').trim() || locationUrl;

  return {
    id: `dlna:${cleanId}`,
    name: friendlyName,
    manufacturer: manufacturer || undefined,
    model: modelName || undefined,
    protocol: 'dlna',
    locationUrl,
    avTransportControlUrl,
    renderingControlUrl,
    supportsRemoteVolume: Boolean(renderingControlUrl),
  };
}

/**
 * Format duration in seconds as UPnP `HH:MM:SS`.
 */
export function formatUpnpDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse UPnP `H:MM:SS(.fff)` time strings into milliseconds.
 */
export function parseUpnpDurationToMs(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed === 'NOT_IMPLEMENTED' ||
    trimmed === 'UNKNOWN' ||
    trimmed === 'END_OF_MEDIA'
  ) {
    return 0;
  }

  const parts = trimmed.split(':');
  if (parts.length !== 3) return 0;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    seconds < 0
  ) {
    return 0;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Build DIDL-Lite metadata XML string for UPnP AVTransport (`SetAVTransportURI` / `SetNextAVTransportURI`).
 */
export function buildDidlLiteXml(track: CastTrackMetadata): string {
  const title = escapeXml(track.title || 'Unknown Title');
  const artist = escapeXml(track.artist || 'Unknown Artist');
  const album = track.album ? escapeXml(track.album) : '';
  const streamUrl = escapeXml(track.streamUrl);
  const mimeType = escapeXml(track.mimeType || 'audio/mpeg');
  const durationAttr =
    track.durationSec > 0 ? ` duration="${formatUpnpDuration(track.durationSec)}"` : '';
  const albumXml = album ? `<upnp:album>${album}</upnp:album>` : '';
  const artXml = track.coverArtUrl
    ? `<upnp:albumArtURI dlna:profileID="JPEG_TN" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${escapeXml(track.coverArtUrl)}</upnp:albumArtURI>`
    : '';

  return (
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="${escapeXml(track.id)}" parentID="0" restricted="1">` +
    `<dc:title>${title}</dc:title>` +
    `<dc:creator>${artist}</dc:creator>` +
    `<upnp:artist>${artist}</upnp:artist>` +
    albumXml +
    artXml +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<res protocolInfo="http-get:*:${mimeType}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"${durationAttr}>${streamUrl}</res>` +
    `</item>` +
    `</DIDL-Lite>`
  );
}

export function buildSoapEnvelope(
  serviceType: string,
  action: string,
  innerBodyXml: string,
): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>` +
    `<u:${action} xmlns:u="${serviceType}">` +
    innerBodyXml +
    `</u:${action}>` +
    `</s:Body>` +
    `</s:Envelope>`
  );
}

export function parseTransportState(xml: string): CastPlaybackStatus {
  const raw = (extractXmlTag(xml, 'CurrentTransportState') ?? '').toUpperCase();
  switch (raw) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED_PLAYBACK':
    case 'PAUSED_RECORDING':
      return 'paused';
    case 'TRANSITIONING':
      return 'buffering';
    case 'STOPPED':
    case 'NO_MEDIA_PRESENT':
      return 'stopped';
    default:
      return 'idle';
  }
}

export function parsePositionInfo(xml: string): {
  positionMs: number;
  durationMs: number;
  currentTrackUri?: string;
} {
  const relTime = extractXmlTag(xml, 'RelTime');
  const durationStr = extractXmlTag(xml, 'TrackDuration');
  const trackUri = extractXmlTag(xml, 'TrackURI');
  return {
    positionMs: parseUpnpDurationToMs(relTime),
    durationMs: parseUpnpDurationToMs(durationStr),
    currentTrackUri: trackUri || undefined,
  };
}

export function parseVolumeResponse(xml: string): number | null {
  const raw = extractXmlTag(xml, 'CurrentVolume');
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function parseSoapFault(xml: string): string | null {
  const errorDesc = extractXmlTag(xml, 'errorDescription');
  if (errorDesc) return errorDesc;
  const faultString = extractXmlTag(xml, 'faultstring');
  if (faultString) return faultString;
  const errorCode = extractXmlTag(xml, 'errorCode');
  if (errorCode) return `UPnP error ${errorCode}`;
  return null;
}

export function mergeCastPlaybackState(
  transportXml: string | null,
  positionXml: string | null,
  volumeXml: string | null,
  fallbackVolume: number,
): CastPlaybackState {
  const status = transportXml ? parseTransportState(transportXml) : 'idle';
  const pos = positionXml
    ? parsePositionInfo(positionXml)
    : { positionMs: 0, durationMs: 0, currentTrackUri: undefined };
  const vol = volumeXml ? parseVolumeResponse(volumeXml) : null;
  return {
    status,
    positionMs: pos.positionMs,
    durationMs: pos.durationMs,
    volume: vol ?? fallbackVolume,
    currentTrackUri: pos.currentTrackUri,
  };
}
