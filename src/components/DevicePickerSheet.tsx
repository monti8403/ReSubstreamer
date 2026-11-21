import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import Slider from '@react-native-community/slider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAudioRoute } from 'react-native-queue-player';

import { BottomSheet } from './BottomSheet';
import { useRoutePickerStore } from './RoutePicker/useRoutePickerStore';
import { useTheme } from '../hooks/useTheme';
import { castController } from '../services/cast/castController';
import { openSystemOutputSwitcher } from '../services/cast/nativeCastBridge';
import type { CastDevice, CastPlaybackStatus, CastProtocolType } from '../services/cast/types';
import { castStore } from '../store/castStore';

// Atrum pure OLED palette
const OLED_BG = '#000000';
const OLED_SURFACE = '#0B0B0E';
const OLED_BORDER = '#1C1C24';
const OLED_TEXT_PRIMARY = '#F4F6FA';
const OLED_TEXT_SECONDARY = '#8E95A5';
const OLED_ERROR = '#FF453A';

const CLOSE_HOLD_MS = 450;

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

function iconForCastDevice(device: CastDevice, isActive: boolean): IconName {
  if (device.protocol === 'airplay') return 'cast-audio';
  if (device.protocol === 'chromecast') return isActive ? 'cast-connected' : 'cast';
  const haystack = `${device.name} ${device.model ?? ''} ${device.manufacturer ?? ''}`.toLowerCase();
  if (haystack.includes('tv') || haystack.includes('bravia') || haystack.includes('samsung') || haystack.includes('lg') || haystack.includes('kodi')) {
    return isActive ? 'television-play' : 'television';
  }
  return isActive ? 'cast-connected' : 'speaker';
}

function iconForLocalAudioRoute(kind: string): IconName {
  switch (kind) {
    case 'bluetoothA2DP':
    case 'bluetoothLE':
    case 'bluetoothHFP':
      return 'bluetooth';
    case 'wired':
      return 'headphones';
    case 'usb':
      return 'usb';
    case 'hdmi':
      return 'television';
    case 'carPlay':
    case 'androidAuto':
      return 'car';
    default:
      return 'cellphone';
  }
}

function protocolBadgeLabel(protocol: CastProtocolType, t: (k: string) => string): string {
  switch (protocol) {
    case 'dlna':
      return t('castProtocolDlna');
    case 'chromecast':
      return t('castProtocolChromecast');
    case 'airplay':
      return t('castProtocolAirplay');
  }
}

function playbackStatusLabel(status: CastPlaybackStatus, t: (k: string) => string): string {
  switch (status) {
    case 'playing':
      return t('castActiveStatusPlaying');
    case 'paused':
      return t('castActiveStatusPaused');
    case 'buffering':
      return t('castActiveStatusBuffering');
    default:
      return t('castActiveStatusIdle');
  }
}

export function DevicePickerSheet() {
  const isOpen = useRoutePickerStore((s) => s.isOpen);
  const close = useRoutePickerStore((s) => s.close);

  return (
    <BottomSheet
      visible={isOpen}
      onClose={close}
      maxHeight="82%"
      scrollable={false}
      backgroundColor={OLED_BG}
    >
      {isOpen && <DevicePickerContent onClose={close} />}
    </BottomSheet>
  );
}

function DevicePickerContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const accent = colors.primary;

  const connectedDevice = castStore((s) => s.connectedDevice);
  const connectingDeviceId = castStore((s) => s.connectingDeviceId);
  const discoveredDevices = castStore((s) => s.discoveredDevices);
  const isScanning = castStore((s) => s.isScanning);
  const playbackState = castStore((s) => s.playbackState);
  const lastError = castStore((s) => s.lastError);

  const audioRoute = useAudioRoute();

  const [localError, setLocalError] = useState<string | null>(null);
  const [sliderVolume, setSliderVolume] = useState<number>(playbackState.volume);
  const [isDraggingVolume, setIsDraggingVolume] = useState(false);
  const [pinTargetDeviceId, setPinTargetDeviceId] = useState<string | null>(null);
  const [pinValue, setPinValue] = useState('');

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDraggingVolume) {
      setSliderVolume(playbackState.volume);
    }
  }, [playbackState.volume, isDraggingVolume]);

  useEffect(() => {
    void castController.startDiscovery().catch(() => {});
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      void castController.stopDiscovery();
    };
  }, []);

  const handleRefresh = useCallback(() => {
    setLocalError(null);
    void castController.startDiscovery().catch(() => {});
  }, []);

  const handleOpenSystemSwitcher = useCallback(() => {
    setLocalError(null);
    void openSystemOutputSwitcher().catch(() => {
      setLocalError(t('castSystemOutputUnavailable'));
    });
  }, [t]);

  const handleDisconnect = useCallback(() => {
    setLocalError(null);
    void castController.disconnect();
  }, []);

  const handleConnect = useCallback(
    (device: CastDevice, password?: string) => {
      setLocalError(null);
      if (device.requiresPairing && !password && pinTargetDeviceId !== device.id) {
        setPinTargetDeviceId(device.id);
        setPinValue('');
        return;
      }

      void castController
        .connectToDevice(device, password ? { password } : undefined)
        .then(() => {
          setPinTargetDeviceId(null);
          setPinValue('');
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(onClose, CLOSE_HOLD_MS);
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string })?.code;
          if (code === 'cast_auth_required') {
            setPinTargetDeviceId(device.id);
            return;
          }
          const msg = err instanceof Error ? err.message : 'Connection failed';
          setLocalError(msg);
        });
    },
    [onClose, pinTargetDeviceId],
  );

  const handleVolumeChange = useCallback((value: number) => {
    setIsDraggingVolume(true);
    setSliderVolume(Math.round(value));
  }, []);

  const handleVolumeCommit = useCallback((value: number) => {
    const rounded = Math.round(value);
    setSliderVolume(rounded);
    setIsDraggingVolume(false);
    void castController.setVolume(rounded);
  }, []);

  const localRouteDisplay = useMemo(() => {
    if (
      audioRoute.name &&
      audioRoute.name.length > 0 &&
      audioRoute.kind !== 'speaker' &&
      audioRoute.kind !== 'unknown'
    ) {
      return audioRoute.name;
    }
    return t('castThisDeviceSubtitle');
  }, [audioRoute.kind, audioRoute.name, t]);

  const availableDevices = useMemo(() => {
    if (!connectedDevice) return discoveredDevices;
    return discoveredDevices.filter((d) => d.id !== connectedDevice.id);
  }, [discoveredDevices, connectedDevice]);

  const displayedError = localError || lastError;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('castConnectTitle')}</Text>
        <View style={styles.headerActions}>
          {isScanning && <ActivityIndicator size="small" color={accent} />}
          <Pressable
            onPress={handleRefresh}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('castRefresh')}
            testID="device-picker-refresh"
            style={({ pressed }) => [
              styles.refreshButton,
              pressed && styles.pressed,
            ]}
          >
            <MaterialCommunityIcons name="refresh" size={20} color={OLED_TEXT_PRIMARY} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        bounces={false}
      >
        {/* Current Active Output */}
        <Text style={styles.sectionLabel}>{t('castCurrentDevice')}</Text>
        {connectedDevice ? (
          <View style={[styles.card, { borderColor: accent }]}>
            <View style={styles.cardTopRow}>
              <View style={[styles.iconBox, { backgroundColor: OLED_BG, borderColor: accent }]}>
                <MaterialCommunityIcons
                  name={iconForCastDevice(connectedDevice, true)}
                  size={22}
                  color={accent}
                />
              </View>
              <View style={styles.labelStack}>
                <View style={styles.titleBadgeRow}>
                  <Text style={styles.deviceTitle} numberOfLines={1}>
                    {connectedDevice.name}
                  </Text>
                  <View style={[styles.protocolBadge, { borderColor: accent }]}>
                    <Text style={[styles.protocolBadgeText, { color: accent }]}>
                      {protocolBadgeLabel(connectedDevice.protocol, t)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.deviceSubtitle} numberOfLines={1}>
                  {playbackStatusLabel(playbackState.status, t)}
                  {connectedDevice.model ? ` • ${connectedDevice.model}` : ''}
                </Text>
              </View>
              <Pressable
                onPress={handleDisconnect}
                testID="device-picker-disconnect"
                accessibilityRole="button"
                accessibilityLabel={t('castDisconnect')}
                style={({ pressed }) => [
                  styles.disconnectButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.disconnectText}>{t('castDisconnect')}</Text>
              </Pressable>
            </View>

            {connectedDevice.supportsRemoteVolume !== false && (
              <View style={styles.volumeRow}>
                <MaterialCommunityIcons
                  name={sliderVolume === 0 ? 'volume-off' : 'volume-high'}
                  size={18}
                  color={OLED_TEXT_SECONDARY}
                />
                <Slider
                  style={styles.volumeSlider}
                  minimumValue={0}
                  maximumValue={100}
                  step={1}
                  value={sliderVolume}
                  onValueChange={handleVolumeChange}
                  onSlidingComplete={handleVolumeCommit}
                  minimumTrackTintColor={accent}
                  maximumTrackTintColor={OLED_BORDER}
                  thumbTintColor={accent}
                  accessibilityLabel={t('castVolume')}
                />
                <Text style={styles.volumeValue}>{sliderVolume}%</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={[styles.card, { borderColor: accent }]}>
            <View style={styles.cardTopRow}>
              <View style={[styles.iconBox, { backgroundColor: OLED_BG, borderColor: accent }]}>
                <MaterialCommunityIcons
                  name={iconForLocalAudioRoute(audioRoute.kind)}
                  size={22}
                  color={accent}
                />
              </View>
              <View style={styles.labelStack}>
                <Text style={styles.deviceTitle} numberOfLines={1}>
                  {t('thisDevice')}
                </Text>
                <Text style={styles.deviceSubtitle} numberOfLines={1}>
                  {localRouteDisplay}
                </Text>
              </View>
              <MaterialCommunityIcons name="check-circle" size={20} color={accent} />
            </View>
          </View>
        )}

        {/* Native System Output Switcher (Bluetooth / Alexa / Headphones / DAC) */}
        <Pressable
          onPress={handleOpenSystemSwitcher}
          testID="device-picker-system-output"
          accessibilityRole="button"
          accessibilityLabel={t('castSystemOutputTitle')}
          style={({ pressed }) => [
            styles.card,
            styles.systemOutputCard,
            pressed && styles.cardPressed,
          ]}
        >
          <View style={styles.cardTopRow}>
            <View style={styles.iconBox}>
              <MaterialCommunityIcons name="bluetooth-audio" size={22} color={OLED_TEXT_PRIMARY} />
            </View>
            <View style={styles.labelStack}>
              <Text style={styles.deviceTitle} numberOfLines={1}>
                {t('castSystemOutputTitle')}
              </Text>
              <Text style={styles.deviceSubtitle} numberOfLines={1}>
                {t('castSystemOutputSubtitle')}
              </Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={OLED_TEXT_SECONDARY} />
          </View>
        </Pressable>

        {/* Error banner */}
        {Boolean(displayedError) && (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle-outline" size={16} color={OLED_ERROR} />
            <Text style={styles.errorText}>{displayedError}</Text>
          </View>
        )}

        {/* Discovered Network Devices */}
        <View style={styles.networkHeaderRow}>
          <Text style={styles.sectionLabel}>{t('castNetworkDevices')}</Text>
          {isScanning && (
            <Text style={styles.scanningText}>{t('castScanning')}</Text>
          )}
        </View>

        {availableDevices.length === 0 ? (
          <View style={styles.emptyCard}>
            {isScanning ? (
              <View style={styles.emptyScanningRow}>
                <ActivityIndicator size="small" color={accent} />
                <Text style={styles.emptyTitle}>{t('castScanning')}</Text>
              </View>
            ) : (
              <>
                <MaterialCommunityIcons
                  name="cast-off"
                  size={28}
                  color={OLED_TEXT_SECONDARY}
                />
                <Text style={styles.emptyTitle}>{t('castNoDevicesFound')}</Text>
                <Text style={styles.emptyHint}>{t('castNoDevicesHint')}</Text>
              </>
            )}
          </View>
        ) : (
          <View style={styles.deviceList}>
            {availableDevices.map((device) => {
              const isConnecting = connectingDeviceId === device.id;
              const isPinOpen = pinTargetDeviceId === device.id;
              const metaParts = [
                protocolBadgeLabel(device.protocol, t),
                device.manufacturer,
                device.model,
              ].filter((p): p is string => Boolean(p && p.trim().length > 0));

              return (
                <View key={device.id} style={styles.card}>
                  <Pressable
                    onPress={() => handleConnect(device)}
                    disabled={isConnecting}
                    testID={`device-row-${device.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={device.name}
                    style={({ pressed }) => [
                      styles.cardTopRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.iconBox}>
                      <MaterialCommunityIcons
                        name={iconForCastDevice(device, false)}
                        size={22}
                        color={OLED_TEXT_PRIMARY}
                      />
                    </View>
                    <View style={styles.labelStack}>
                      <Text style={styles.deviceTitle} numberOfLines={1}>
                        {device.name}
                      </Text>
                      <Text style={styles.deviceSubtitle} numberOfLines={1}>
                        {metaParts.join(' • ')}
                      </Text>
                    </View>
                    <View style={styles.accessory}>
                      {isConnecting ? (
                        <ActivityIndicator size="small" color={accent} />
                      ) : (
                        <MaterialCommunityIcons
                          name="chevron-right"
                          size={22}
                          color={OLED_TEXT_SECONDARY}
                        />
                      )}
                    </View>
                  </Pressable>

                  {isPinOpen && (
                    <View style={styles.pinRow}>
                      <TextInput
                        value={pinValue}
                        onChangeText={setPinValue}
                        placeholder={t('castPinPlaceholder')}
                        placeholderTextColor={OLED_TEXT_SECONDARY}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.pinInput, { borderColor: OLED_BORDER }]}
                      />
                      <Pressable
                        onPress={() => handleConnect(device, pinValue)}
                        disabled={pinValue.length === 0}
                        style={({ pressed }) => [
                          styles.pinSubmit,
                          { backgroundColor: pinValue.length === 0 ? OLED_BORDER : accent },
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.pinSubmitText}>{t('castConnectAction')}</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 1,
    paddingBottom: Platform.OS === 'android' ? 8 : 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: OLED_BORDER,
    marginBottom: 12,
  },
  headerTitle: {
    color: OLED_TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  refreshButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: OLED_SURFACE,
    borderWidth: 1,
    borderColor: OLED_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    gap: 10,
    paddingBottom: 12,
  },
  sectionLabel: {
    color: OLED_TEXT_SECONDARY,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.9,
  },
  networkHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  scanningText: {
    color: OLED_TEXT_SECONDARY,
    fontSize: 11,
    fontWeight: '500',
  },
  card: {
    backgroundColor: OLED_SURFACE,
    borderWidth: 1,
    borderColor: OLED_BORDER,
    borderRadius: 12,
    padding: 12,
  },
  systemOutputCard: {
    marginTop: 2,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: OLED_BG,
    borderWidth: 1,
    borderColor: OLED_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelStack: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  titleBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceTitle: {
    color: OLED_TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  deviceSubtitle: {
    color: OLED_TEXT_SECONDARY,
    fontSize: 12,
  },
  protocolBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  protocolBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  disconnectButton: {
    borderWidth: 1,
    borderColor: OLED_BORDER,
    backgroundColor: OLED_BG,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  disconnectText: {
    color: OLED_TEXT_PRIMARY,
    fontSize: 12,
    fontWeight: '600',
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: OLED_BORDER,
  },
  volumeSlider: {
    flex: 1,
    height: 32,
  },
  volumeValue: {
    color: OLED_TEXT_SECONDARY,
    fontSize: 12,
    fontWeight: '600',
    width: 38,
    textAlign: 'right',
  },
  deviceList: {
    gap: 8,
  },
  accessory: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    backgroundColor: OLED_SURFACE,
    borderWidth: 1,
    borderColor: OLED_BORDER,
    borderRadius: 12,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
  },
  emptyScanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: {
    color: OLED_TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyHint: {
    color: OLED_TEXT_SECONDARY,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: OLED_SURFACE,
    borderWidth: 1,
    borderColor: OLED_ERROR,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    color: OLED_ERROR,
    fontSize: 12,
    flex: 1,
  },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: OLED_BORDER,
  },
  pinInput: {
    flex: 1,
    backgroundColor: OLED_BG,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: OLED_TEXT_PRIMARY,
    fontSize: 14,
  },
  pinSubmit: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pinSubmitText: {
    color: OLED_BG,
    fontSize: 13,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
