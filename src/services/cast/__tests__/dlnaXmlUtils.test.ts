import {
  buildDidlLiteXml,
  buildSoapEnvelope,
  escapeXml,
  formatUpnpDuration,
  mergeCastPlaybackState,
  parseDeviceDescriptionXml,
  parsePositionInfo,
  parseSoapFault,
  parseTransportState,
  parseUpnpDurationToMs,
  parseVolumeResponse,
  resolveUpnpUrl,
  UPNP_AV_TRANSPORT_SERVICE,
} from '../dlnaXmlUtils';

describe('dlnaXmlUtils', () => {
  describe('resolveUpnpUrl', () => {
    it('resolves root-relative control URLs against location origin', () => {
      expect(
        resolveUpnpUrl('http://192.168.1.45:1699/description.xml', '/AVTransport/ctrl'),
      ).toBe('http://192.168.1.45:1699/AVTransport/ctrl');
    });

    it('resolves path-relative control URLs against location directory', () => {
      expect(
        resolveUpnpUrl('http://192.168.1.45:1400/xml/device_description.xml', 'MediaRenderer/AVTransport/Control'),
      ).toBe('http://192.168.1.45:1400/xml/MediaRenderer/AVTransport/Control');
    });

    it('preserves absolute control URLs', () => {
      expect(
        resolveUpnpUrl('http://192.168.1.45:1400/desc.xml', 'http://192.168.1.45:8080/ctrl'),
      ).toBe('http://192.168.1.45:8080/ctrl');
    });
  });

  describe('parseDeviceDescriptionXml', () => {
    const kodiXml = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Kodi (Living Room)</friendlyName>
    <manufacturer>XBMC Foundation</manufacturer>
    <modelName>Kodi</modelName>
    <UDN>uuid:abc-123-renderer</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/RenderingControl/abc-123/control.xml</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/AVTransport/abc-123/control.xml</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

    it('extracts renderer metadata and resolves absolute service URLs', () => {
      const device = parseDeviceDescriptionXml(kodiXml, 'http://192.168.1.20:1826/desc.xml');
      expect(device).toEqual({
        id: 'dlna:abc-123-renderer',
        name: 'Kodi (Living Room)',
        manufacturer: 'XBMC Foundation',
        model: 'Kodi',
        protocol: 'dlna',
        locationUrl: 'http://192.168.1.20:1826/desc.xml',
        avTransportControlUrl: 'http://192.168.1.20:1826/AVTransport/abc-123/control.xml',
        renderingControlUrl: 'http://192.168.1.20:1826/RenderingControl/abc-123/control.xml',
        supportsRemoteVolume: true,
      });
    });

    it('returns null for non-renderer UPnP devices (e.g. MediaServer or router)', () => {
      const routerXml = `<?xml version="1.0"?>
<root><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<friendlyName>Router</friendlyName></device></root>`;
      expect(parseDeviceDescriptionXml(routerXml, 'http://192.168.1.1:5000/root.xml')).toBeNull();
    });

    it('supports nested MediaRenderer device inside Sonos-style root device', () => {
      const sonosXml = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>Kitchen Sonos</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <modelName>Sonos One</modelName>
    <UDN>uuid:RINCON_ROOT</UDN>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <friendlyName>Kitchen - MediaRenderer</friendlyName>
        <UDN>uuid:RINCON_MR</UDN>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/MediaRenderer/AVTransport/Control</controlURL>
          </service>
        </serviceList>
      </device>
    </deviceList>
  </device>
</root>`;
      const device = parseDeviceDescriptionXml(sonosXml, 'http://192.168.1.50:1400/xml/device_description.xml');
      expect(device).not.toBeNull();
      expect(device?.id).toBe('dlna:RINCON_MR');
      expect(device?.avTransportControlUrl).toBe(
        'http://192.168.1.50:1400/MediaRenderer/AVTransport/Control',
      );
      expect(device?.supportsRemoteVolume).toBe(false);
    });
  });

  describe('duration formatting and parsing', () => {
    it('formats seconds to HH:MM:SS', () => {
      expect(formatUpnpDuration(0)).toBe('00:00:00');
      expect(formatUpnpDuration(65)).toBe('00:01:05');
      expect(formatUpnpDuration(3661.9)).toBe('01:01:01');
    });

    it('parses H:MM:SS(.mmm) strings into milliseconds', () => {
      expect(parseUpnpDurationToMs('00:03:45')).toBe(225000);
      expect(parseUpnpDurationToMs('1:02:03.500')).toBe(3723500);
      expect(parseUpnpDurationToMs('NOT_IMPLEMENTED')).toBe(0);
      expect(parseUpnpDurationToMs(undefined)).toBe(0);
    });
  });

  describe('DIDL-Lite and SOAP builders/parsers', () => {
    it('builds valid DIDL-Lite XML with escaped metadata and albumArtURI', () => {
      const didl = buildDidlLiteXml({
        id: 'song-1',
        title: 'Rock & Roll <Live>',
        artist: 'AC/DC & Friends',
        album: 'Greatest "Hits"',
        coverArtUrl: 'https://music.local/rest/getCoverArt.view?id=c1&u=me',
        durationSec: 215,
        streamUrl: 'https://music.local/rest/stream.view?id=song-1&format=mp3',
        mimeType: 'audio/mpeg',
      });

      expect(didl).toContain('<dc:title>Rock &amp; Roll &lt;Live&gt;</dc:title>');
      expect(didl).toContain('<upnp:artist>AC/DC &amp; Friends</upnp:artist>');
      expect(didl).toContain('<upnp:album>Greatest &quot;Hits&quot;</upnp:album>');
      expect(didl).toContain('<upnp:albumArtURI');
      expect(didl).toContain('getCoverArt.view?id=c1&amp;u=me');
      expect(didl).toContain('duration="00:03:35"');
      expect(didl).toContain('http-get:*:audio/mpeg:');
    });

    it('wraps actions in SOAP envelope', () => {
      const env = buildSoapEnvelope(
        UPNP_AV_TRANSPORT_SERVICE,
        'Play',
        '<InstanceID>0</InstanceID><Speed>1</Speed>',
      );
      expect(env).toContain('<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">');
      expect(escapeXml('a&b"c<d>e\'f')).toBe('a&amp;b&quot;c&lt;d&gt;e&apos;f');
    });

    it('parses TransportInfo, PositionInfo, Volume, and SOAP Faults', () => {
      const transportXml = `<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>`;
      const positionXml = `<s:Envelope><s:Body><u:GetPositionInfoResponse><TrackDuration>00:04:00</TrackDuration><TrackURI>https://srv/rest/stream.view?id=1&amp;format=mp3</TrackURI><RelTime>00:01:30</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>`;
      const volumeXml = `<s:Envelope><s:Body><u:GetVolumeResponse><CurrentVolume>72</CurrentVolume></u:GetVolumeResponse></s:Body></s:Envelope>`;

      expect(parseTransportState(transportXml)).toBe('playing');
      expect(parsePositionInfo(positionXml)).toEqual({
        positionMs: 90000,
        durationMs: 240000,
        currentTrackUri: 'https://srv/rest/stream.view?id=1&format=mp3',
      });
      expect(parseVolumeResponse(volumeXml)).toBe(72);

      const merged = mergeCastPlaybackState(transportXml, positionXml, volumeXml, 50);
      expect(merged).toEqual({
        status: 'playing',
        positionMs: 90000,
        durationMs: 240000,
        volume: 72,
        currentTrackUri: 'https://srv/rest/stream.view?id=1&format=mp3',
      });

      const faultXml = `<s:Fault><detail><UPnPError><errorCode>716</errorCode><errorDescription>Resource not found</errorDescription></UPnPError></detail></s:Fault>`;
      expect(parseSoapFault(faultXml)).toBe('Resource not found');
    });
  });
});
