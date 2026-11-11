import { useCallback, useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  playbackSettingsStore,
  type WidgetShuffleMode,
  type WidgetTheme,
} from '../../store/playbackSettingsStore';
import { scheduleWidgetSync } from '../../services/widgetSyncService';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const THEME_OPTIONS: { value: WidgetTheme; labelKey: string }[] = [
  { value: 'dynamic', labelKey: 'widgetThemeDynamic' },
  { value: 'oled', labelKey: 'widgetThemeOled' },
];

const SHUFFLE_OPTIONS: { value: WidgetShuffleMode; labelKey: string }[] = [
  { value: 'toggle_queue', labelKey: 'widgetShuffleModeToggleQueue' },
  { value: 'all_songs', labelKey: 'widgetShuffleModeAllSongs' },
  { value: 'starred', labelKey: 'widgetShuffleModeStarred' },
  { value: 'downloaded', labelKey: 'widgetShuffleModeDownloaded' },
];

export function WidgetSettingsCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const theme = playbackSettingsStore((s) => s.widgetTheme);
  const setTheme = playbackSettingsStore((s) => s.setWidgetTheme);
  const shuffleMode = playbackSettingsStore((s) => s.widgetShuffleMode);
  const setShuffleMode = playbackSettingsStore((s) => s.setWidgetShuffleMode);

  const themeDropdownOptions: DropdownOption<WidgetTheme>[] = useMemo(
    () => THEME_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t],
  );

  const shuffleDropdownOptions: DropdownOption<WidgetShuffleMode>[] = useMemo(
    () => SHUFFLE_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t],
  );

  const handleThemeChange = useCallback(
    (value: WidgetTheme) => {
      setTheme(value);
      scheduleWidgetSync();
    },
    [setTheme],
  );

  const handleShuffleChange = useCallback(
    (value: WidgetShuffleMode) => {
      setShuffleMode(value);
      scheduleWidgetSync();
    },
    [setShuffleMode],
  );

  if (Platform.OS !== 'android') return null;

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('widgetHomeScreen')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <DropdownRow
          label={t('widgetThemeLabel')}
          value={theme}
          options={themeDropdownOptions}
          onChange={handleThemeChange}
        />
        <DropdownRow
          label={t('widgetShuffleModeLabel')}
          value={shuffleMode}
          options={shuffleDropdownOptions}
          onChange={handleShuffleChange}
          isLast
        />
      </View>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        {t('widgetSettingsHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
    marginHorizontal: 4,
  },
});
