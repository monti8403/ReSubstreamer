import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useAudioRoute, useCast } from 'react-native-queue-player';

import { castStore } from '../../store/castStore';
import { CAST_BUTTON_PREPOSITION, castButtonLabel, localRouteDisplayName } from './copy';
import { iconForAudioRoute, iconForCastProtocol } from './iconForRoute';
import { type RoutePickerTheme } from './types';
import { useRoutePickerTheme } from './useRoutePickerTheme';
import { useRoutePickerStore } from './useRoutePickerStore';

export interface CastButtonProps {
  /** Optional theme override; falls back to the app theme. */
  theme?: Partial<RoutePickerTheme>;
}

/**
 * Player-screen cast affordance — an inline pill showing the current audio
 * route ("Listening on X"). Tap opens the DevicePickerSheet. Reads the active
 * unified castStore session (DLNA / Chromecast / AirPlay), RNQP useCast(), and
 * the system audio route (useAudioRoute).
 */
export function CastButton({ theme }: CastButtonProps) {
  const { t: translate } = useTranslation();
  const t = useRoutePickerTheme(theme);
  const snapshot = useCast();
  const audioRoute = useAudioRoute();
  const connectedDevice = castStore((s) => s.connectedDevice);
  const openPicker = useRoutePickerStore((s) => s.open);

  const rnqpCastName =
    snapshot.route.castProtocol !== 'local' && snapshot.route.name.length > 0
      ? snapshot.route.name
      : null;
  const activeCastName = connectedDevice?.name || rnqpCastName;
  const activeProtocol = connectedDevice?.protocol ?? snapshot.route.castProtocol;
  const isCasting = activeCastName != null;

  const rawLabel = castButtonLabel(audioRoute, activeCastName);
  const label =
    !isCasting && rawLabel === localRouteDisplayName() && rawLabel === 'This device'
      ? translate('thisDevice', { defaultValue: rawLabel })
      : rawLabel;

  const preposition = translate('castListeningOn', {
    defaultValue: CAST_BUTTON_PREPOSITION,
  });

  const iconName = isCasting
    ? iconForCastProtocol(activeProtocol)
    : iconForAudioRoute(audioRoute);
  const lineColor = isCasting ? t.accent : t.textSubtle;

  return (
    <Pressable
      onPress={openPicker}
      accessibilityRole="button"
      accessibilityLabel={translate('castListeningOnA11y', {
        device: label,
        defaultValue: `${preposition} ${label}. Tap to change.`,
      })}
      testID="cast-button"
      hitSlop={8}
      style={({ pressed }) => [
        styles.row,
        isCasting && [styles.activePill, { borderColor: t.accent }],
        pressed && { opacity: 0.6 },
      ]}
    >
      <MaterialCommunityIcons name={iconName} size={16} color={lineColor} />
      <Text numberOfLines={1} style={[styles.line, { color: lineColor }]}>
        {preposition}{' '}
        <Text style={styles.deviceName}>{label}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 3,
  },
  activePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 2,
  },
  line: {
    fontSize: 13,
    flexShrink: 1,
  },
  deviceName: {
    fontWeight: '700',
  },
});
