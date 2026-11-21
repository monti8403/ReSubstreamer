import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import {
  RADIO_MODES,
  radioAiSettingsStore,
  type RadioMode,
  type RadioSources,
} from '../../store/radioAiSettingsStore';
import { serverInfoStore } from '../../store/serverInfoStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { SettingsRow } from './SettingsRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const MODE_LABEL_KEY: Record<RadioMode, string> = {
  mood: 'radioModeMood',
  faithful: 'radioModeFaithful',
  balanced: 'radioModeBalanced',
  discovery: 'radioModeDiscovery',
};

const MODE_HINT_KEY: Record<RadioMode, string> = {
  mood: 'radioModeMoodHint',
  faithful: 'radioModeFaithfulHint',
  balanced: 'radioModeBalancedHint',
  discovery: 'radioModeDiscoveryHint',
};

const SOURCE_ITEMS: readonly {
  key: keyof RadioSources;
  labelKey: string;
  hintKey: string;
}[] = [
  {
    key: 'sonicSimilarity',
    labelKey: 'radioSourceSonicSimilarity',
    hintKey: 'radioSourceSonicSimilarityHint',
  },
  {
    key: 'server',
    labelKey: 'radioSourceServer',
    hintKey: 'radioSourceServerHint',
  },
  {
    key: 'localHistory',
    labelKey: 'radioSourceLocalHistory',
    hintKey: 'radioSourceLocalHistoryHint',
  },
  {
    key: 'metadata',
    labelKey: 'radioSourceMetadata',
    hintKey: 'radioSourceMetadataHint',
  },
  {
    key: 'aiBoost',
    labelKey: 'radioSourceAiBoost',
    hintKey: 'radioSourceAiBoostHint',
  },
];

/**
 * Smart Radio & Infinite Autoplay configuration card.
 *
 * Controls continuous queue continuation, exploration preset, candidate
 * sources (gating AI Boost on an active BYOK provider), and session-level
 * repeat suppression.
 */
export function RadioAutoplayCard() {
  const { t } = useTranslation();
  const { theme, colors } = useTheme();

  const infiniteAutoplay = radioAiSettingsStore((s) => s.infiniteAutoplay);
  const radioMode = radioAiSettingsStore((s) => s.radioMode);
  const sources = radioAiSettingsStore((s) => s.sources);
  const provider = radioAiSettingsStore((s) => s.provider);
  const supportsSonicSimilarity = serverInfoStore((s) => s.supportsSonicSimilarity);
  const sonicSimilarityVersion = serverInfoStore((s) => s.sonicSimilarityVersion);

  const setInfiniteAutoplay = radioAiSettingsStore((s) => s.setInfiniteAutoplay);
  const setRadioMode = radioAiSettingsStore((s) => s.setRadioMode);
  const setSource = radioAiSettingsStore((s) => s.setSource);

  const isDark = theme === 'dark';
  const cardBg = isDark ? '#0B0B0E' : colors.card;
  const deepBg = isDark ? '#000000' : colors.inputBg;
  const borderColor = isDark ? '#1E1E24' : colors.border;
  const textPrimary = isDark ? '#F4F6FA' : colors.textPrimary;

  const isProviderDisabled = provider === 'disabled';
  const visibleSources = supportsSonicSimilarity
    ? SOURCE_ITEMS
    : SOURCE_ITEMS.filter((item) => item.key !== 'sonicSimilarity');

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('radioAndAutoplay')}</SettingsSectionTitle>
      <View
        style={[
          settingsStyles.card,
          settingsStyles.cardPadded,
          styles.cardBorder,
          { backgroundColor: cardBg, borderColor },
        ]}
      >
        <SettingsRow
          label={t('radioInfiniteAutoplay')}
          hint={t('radioInfiniteAutoplayHint')}
          right={
            <Switch
              testID="radio-infinite-autoplay-switch"
              value={infiniteAutoplay}
              onValueChange={setInfiniteAutoplay}
              trackColor={{ false: borderColor, true: colors.primary }}
            />
          }
        />

        <View style={[styles.modeBlock, { borderBottomColor: colors.border }]}>
          <Text style={[styles.blockLabel, { color: textPrimary }]}>
            {t('radioMode')}
          </Text>
          <View
            style={[
              styles.segmentedTrack,
              { backgroundColor: deepBg, borderColor },
            ]}
          >
            {RADIO_MODES.map((mode) => {
              const active = radioMode === mode;
              return (
                <Pressable
                  key={mode}
                  testID={`radio-mode-${mode}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setRadioMode(mode)}
                  style={({ pressed }) => [
                    styles.segment,
                    {
                      backgroundColor: active ? colors.primary : deepBg,
                      borderColor: active ? colors.primary : borderColor,
                    },
                    pressed && !active && settingsStyles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? '#F4F6FA' : colors.textSecondary },
                      active && styles.segmentTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.85}
                  >
                    {t(MODE_LABEL_KEY[mode])}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.modeHint, { color: colors.textSecondary }]}>
            {t(MODE_HINT_KEY[radioMode])}
          </Text>
        </View>

        <View style={styles.subHeaderRow}>
          <Text style={[styles.subHeader, { color: colors.label }]}>
            {t('radioActiveSources')}
          </Text>
          {supportsSonicSimilarity && (
            <View
              testID="radio-sonic-similarity-badge"
              style={[
                styles.sonicBadge,
                { backgroundColor: deepBg, borderColor },
              ]}
            >
              <Text style={[styles.sonicBadgeText, { color: colors.primary }]}>
                {t('radioSonicSimilarityBadge', {
                  version: sonicSimilarityVersion ?? 1,
                })}
              </Text>
            </View>
          )}
        </View>

        {visibleSources.map((item, idx) => {
          const isAiBoost = item.key === 'aiBoost';
          const isDisabled = isAiBoost && isProviderDisabled;
          const isLastSource =
            supportsSonicSimilarity && idx === visibleSources.length - 1;
          return (
            <View
              key={item.key}
              style={isDisabled ? settingsStyles.disabled : undefined}
            >
              <SettingsRow
                label={t(item.labelKey)}
                hint={
                  isDisabled
                    ? t('radioSourceAiBoostDisabledHint')
                    : t(item.hintKey)
                }
                isLast={isLastSource}
                right={
                  <Switch
                    testID={`radio-source-${item.key}-switch`}
                    value={isDisabled ? false : sources[item.key]}
                    onValueChange={(next) => setSource(item.key, next)}
                    disabled={isDisabled}
                    trackColor={{ false: borderColor, true: colors.primary }}
                  />
                }
              />
            </View>
          );
        })}

        {!supportsSonicSimilarity && (
          <View
            testID="radio-sonic-similarity-unavailable"
            style={styles.sonicUnavailableRow}
          >
            <Text style={[styles.sonicUnavailableText, { color: colors.textSecondary }]}>
              {t('radioSonicSimilarityNotDetected')}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardBorder: {
    borderWidth: 1,
  },
  modeBlock: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  blockLabel: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 10,
  },
  segmentedTrack: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    padding: 3,
    gap: 4,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 7,
    borderWidth: 1,
  },
  segmentText: {
    fontSize: 12,
    fontWeight: '500',
  },
  segmentTextActive: {
    fontWeight: '600',
  },
  modeHint: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 8,
  },
  subHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 2,
    gap: 8,
  },
  subHeader: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sonicBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  sonicBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  sonicUnavailableRow: {
    paddingTop: 10,
    paddingBottom: 4,
  },
  sonicUnavailableText: {
    fontSize: 12,
    lineHeight: 16,
  },
});
