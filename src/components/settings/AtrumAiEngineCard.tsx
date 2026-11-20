import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { testConnection } from '../../services/byokAiService';
import {
  AI_PROVIDERS,
  AI_PROVIDER_DEFAULTS,
  radioAiSettingsStore,
  type AiProvider,
} from '../../store/radioAiSettingsStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const PROVIDER_LABEL_KEY: Record<AiProvider, string> = {
  disabled: 'atrumAiProviderDisabled',
  gemini: 'atrumAiProviderGemini',
  groq: 'atrumAiProviderGroq',
  openai: 'atrumAiProviderOpenai',
  custom: 'atrumAiProviderCustom',
};

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success'; message: string; latencyMs?: number }
  | { kind: 'error'; message: string };

/**
 * Optional BYOK (Bring Your Own Key) Atrum AI Engine configuration card.
 *
 * Lets the user select an AI provider, configure endpoint/model/API key
 * (hydrated from and persisted to `secureKeyVault`), and run an inline
 * connectivity check without storing secrets in plain KV storage.
 */
export function AtrumAiEngineCard() {
  const { t } = useTranslation();
  const { theme, colors } = useTheme();

  const provider = radioAiSettingsStore((s) => s.provider);
  const baseUrl = radioAiSettingsStore((s) => s.baseUrl);
  const apiKey = radioAiSettingsStore((s) => s.apiKey);
  const modelName = radioAiSettingsStore((s) => s.modelName);

  const setProvider = radioAiSettingsStore((s) => s.setProvider);
  const setBaseUrl = radioAiSettingsStore((s) => s.setBaseUrl);
  const setApiKey = radioAiSettingsStore((s) => s.setApiKey);
  const setModelName = radioAiSettingsStore((s) => s.setModelName);
  const hydrateApiKey = radioAiSettingsStore((s) => s.hydrateApiKey);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const testSeqRef = useRef(0);

  useEffect(() => {
    void hydrateApiKey();
  }, [hydrateApiKey, provider]);

  // Clear stale test feedback and invalidate any in-flight check when inputs change.
  useEffect(() => {
    testSeqRef.current += 1;
    setTestState((prev) => (prev.kind === 'idle' ? prev : { kind: 'idle' }));
  }, [provider, baseUrl, apiKey, modelName]);

  useEffect(() => {
    return () => {
      testSeqRef.current += 1;
    };
  }, []);

  const providerOptions: DropdownOption<AiProvider>[] = useMemo(
    () => AI_PROVIDERS.map((p) => ({ value: p, label: t(PROVIDER_LABEL_KEY[p]) })),
    [t],
  );

  const handleTestConnection = useCallback(async () => {
    const seq = ++testSeqRef.current;
    setTestState({ kind: 'testing' });
    try {
      const result = await testConnection();
      if (seq !== testSeqRef.current) return;
      if (result.ok) {
        setTestState({
          kind: 'success',
          message: result.message,
          latencyMs: result.latencyMs,
        });
      } else {
        setTestState({
          kind: 'error',
          message: result.message || t('atrumAiTestUnexpectedError'),
        });
      }
    } catch (err) {
      if (seq !== testSeqRef.current) return;
      setTestState({
        kind: 'error',
        message:
          err instanceof Error && err.message
            ? err.message
            : t('atrumAiTestUnexpectedError'),
      });
    }
  }, [t]);

  const isDark = theme === 'dark';
  const cardBg = isDark ? '#0B0B0E' : colors.card;
  const deepBg = isDark ? '#000000' : colors.inputBg;
  const borderColor = isDark ? '#1E1E24' : colors.border;
  const textPrimary = isDark ? '#F4F6FA' : colors.textPrimary;
  const greenColor = colors.green ?? '#30D158';
  const redColor = colors.red ?? '#e91429';

  const isEnabled = provider !== 'disabled';
  const isTesting = testState.kind === 'testing';
  const defaults = provider !== 'disabled' ? AI_PROVIDER_DEFAULTS[provider] : null;

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('atrumAiEngine')}</SettingsSectionTitle>
      <View
        style={[
          settingsStyles.card,
          styles.cardBorder,
          { backgroundColor: cardBg, borderColor },
        ]}
      >
        <DropdownRow
          label={t('atrumAiProvider')}
          value={provider}
          options={providerOptions}
          onChange={setProvider}
          isLast={!isEnabled}
        />

        {isEnabled && (
          <View style={[styles.form, { borderTopColor: borderColor }]}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: textPrimary }]}>
                {t('atrumAiBaseUrl')}
              </Text>
              <TextInput
                testID="atrum-ai-base-url-input"
                style={[
                  styles.input,
                  { backgroundColor: deepBg, color: textPrimary, borderColor },
                ]}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder={defaults?.baseUrl ?? t('atrumAiBaseUrlPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                selectionColor={colors.primary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!isTesting}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: textPrimary }]}>
                {t('atrumAiApiKey')}
              </Text>
              <View
                style={[
                  styles.passwordRow,
                  { backgroundColor: deepBg, borderColor },
                ]}
              >
                <TextInput
                  testID="atrum-ai-api-key-input"
                  style={[styles.passwordInput, { color: textPrimary }]}
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={t('atrumAiApiKeyPlaceholder')}
                  placeholderTextColor={colors.textSecondary}
                  selectionColor={colors.primary}
                  secureTextEntry={!showApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isTesting}
                />
                <Pressable
                  testID="atrum-ai-toggle-key-visibility"
                  onPress={() => setShowApiKey((prev) => !prev)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showApiKey ? t('atrumAiHideApiKey') : t('atrumAiShowApiKey')
                  }
                  style={({ pressed }) => [
                    styles.eyeButton,
                    pressed && settingsStyles.pressed,
                  ]}
                >
                  <Ionicons
                    name={showApiKey ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={colors.textSecondary}
                  />
                </Pressable>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: textPrimary }]}>
                {t('atrumAiModelName')}
              </Text>
              <TextInput
                testID="atrum-ai-model-name-input"
                style={[
                  styles.input,
                  { backgroundColor: deepBg, color: textPrimary, borderColor },
                ]}
                value={modelName}
                onChangeText={setModelName}
                placeholder={defaults?.modelName ?? t('atrumAiModelNamePlaceholder')}
                placeholderTextColor={colors.textSecondary}
                selectionColor={colors.primary}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isTesting}
              />
            </View>

            <Pressable
              testID="atrum-ai-test-button"
              onPress={handleTestConnection}
              disabled={isTesting}
              style={({ pressed }) => [
                styles.testButton,
                { backgroundColor: deepBg, borderColor: colors.primary },
                pressed && !isTesting && settingsStyles.pressed,
                isTesting && settingsStyles.disabled,
              ]}
            >
              {isTesting ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Ionicons name="flash-outline" size={18} color={colors.primary} />
              )}
              <Text style={[styles.testButtonText, { color: colors.primary }]}>
                {isTesting ? t('atrumAiTesting') : t('atrumAiTestConnection')}
              </Text>
            </Pressable>

            {(testState.kind === 'success' || testState.kind === 'error') && (
              <View
                testID="atrum-ai-test-status"
                style={[
                  styles.statusBox,
                  {
                    backgroundColor: deepBg,
                    borderColor: testState.kind === 'success' ? greenColor : redColor,
                  },
                ]}
              >
                <Ionicons
                  name={
                    testState.kind === 'success'
                      ? 'checkmark-circle'
                      : 'alert-circle'
                  }
                  size={18}
                  color={testState.kind === 'success' ? greenColor : redColor}
                />
                <Text
                  style={[
                    styles.statusText,
                    { color: testState.kind === 'success' ? textPrimary : redColor },
                  ]}
                >
                  {testState.kind === 'success' && testState.latencyMs != null
                    ? t('atrumAiTestSuccessLatency', {
                        message: testState.message,
                        ms: Math.round(testState.latencyMs),
                      })
                    : testState.message}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      <Text style={[settingsStyles.sectionHint, { color: colors.textSecondary }]}>
        {t('atrumAiEngineHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cardBorder: {
    borderWidth: 1,
  },
  form: {
    padding: 16,
    borderTopWidth: 1,
    gap: 14,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 10,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
  },
  eyeButton: {
    paddingLeft: 8,
    paddingVertical: 4,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 11,
    marginTop: 2,
  },
  testButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statusText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
});
