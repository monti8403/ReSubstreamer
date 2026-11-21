/**
 * Persisted settings store for Smart Radio, Infinite Autoplay, and the
 * optional BYOK Atrum AI Engine.
 *
 * Non-secret settings persist via `kvStorageSync` (`storage` table).
 * The BYOK `apiKey` is NEVER included in Zustand's `partialize` or KV storage;
 * it lives solely in-memory and encrypted on disk via `secureKeyVault`.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  clearApiKeySecret,
  loadApiKeySecret,
  saveApiKeySecret,
} from '../services/secureKeyVault';
import { kvStorageSync as kvStorage } from './persistence';

export type RadioMode = 'mood' | 'faithful' | 'balanced' | 'discovery';
export type AiProvider = 'disabled' | 'gemini' | 'groq' | 'openai' | 'custom';

export interface RadioSources {
  sonicSimilarity: boolean;
  server: boolean;
  localHistory: boolean;
  metadata: boolean;
  aiBoost: boolean;
}

export interface RadioAiSettingsSnapshot {
  infiniteAutoplay: boolean;
  radioMode: RadioMode;
  sources: RadioSources;
  sessionAntiRepeat: boolean;
  provider: AiProvider;
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

export interface RadioAiSettingsState extends RadioAiSettingsSnapshot {
  apiKeysByProvider: Partial<Record<Exclude<AiProvider, 'disabled'>, string>>;
  setInfiniteAutoplay: (enabled: boolean) => void;
  setRadioMode: (mode: RadioMode) => void;
  setSource: (source: keyof RadioSources, enabled: boolean) => void;
  setSources: (sources: Partial<RadioSources>) => void;
  setSessionAntiRepeat: (enabled: boolean) => void;
  setProvider: (provider: AiProvider) => void;
  setBaseUrl: (baseUrl: string) => void;
  setModelName: (modelName: string) => void;
  setApiKey: (apiKey: string) => void;
  hydrateApiKey: () => Promise<string>;
  resetRadioAiSettings: () => void;
}

export const AI_PROVIDER_DEFAULTS: Record<
  Exclude<AiProvider, 'disabled'>,
  { baseUrl: string; modelName: string }
> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelName: 'gemini-3.8-flash',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    modelName: 'openai/gpt-oss-20b',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-6-luna',
  },
  custom: {
    baseUrl: 'http://localhost:11434/v1',
    modelName: 'qwen3:4b',
  },
};

export const RADIO_MODES: readonly RadioMode[] = ['mood', 'faithful', 'balanced', 'discovery'] as const;
export const AI_PROVIDERS: readonly AiProvider[] = [
  'disabled',
  'gemini',
  'groq',
  'openai',
  'custom',
] as const;

const PERSIST_KEY = 'substreamer-radio-ai-settings';

const DEFAULT_SOURCES: RadioSources = {
  sonicSimilarity: true,
  server: true,
  localHistory: true,
  metadata: true,
  aiBoost: false,
};

const INITIAL_SETTINGS: RadioAiSettingsSnapshot = {
  infiniteAutoplay: true,
  radioMode: 'mood',
  sources: { ...DEFAULT_SOURCES },
  sessionAntiRepeat: true,
  provider: 'disabled',
  baseUrl: '',
  modelName: '',
  apiKey: '',
};

let apiKeyWriteSeq = 0;

export const radioAiSettingsStore = create<RadioAiSettingsState>()(
  persist(
    (set, get) => ({
      ...INITIAL_SETTINGS,
      apiKeysByProvider: {},

      setInfiniteAutoplay: (infiniteAutoplay) => set({ infiniteAutoplay }),

      setRadioMode: (radioMode) => set({ radioMode }),

      setSource: (source, enabled) =>
        set((state) => {
          if (source === 'aiBoost' && enabled && state.provider === 'disabled') {
            return {
              sources: { ...state.sources, aiBoost: false },
            };
          }
          return {
            sources: { ...state.sources, [source]: enabled },
          };
        }),

      setSources: (partial) =>
        set((state) => {
          const nextSources = { ...state.sources, ...partial };
          if (state.provider === 'disabled') {
            nextSources.aiBoost = false;
          }
          return { sources: nextSources };
        }),

      setSessionAntiRepeat: (sessionAntiRepeat) => set({ sessionAntiRepeat }),

      setProvider: (provider) =>
        set((state) => {
          if (provider === 'disabled') {
            return {
              provider: 'disabled',
              apiKey: '',
              sources: { ...state.sources, aiBoost: false },
            };
          }
          const defaults = AI_PROVIDER_DEFAULTS[provider];
          const cachedKey = state.apiKeysByProvider[provider] ?? '';
          return {
            provider,
            baseUrl: defaults.baseUrl,
            modelName: defaults.modelName,
            apiKey: cachedKey,
          };
        }),

      setBaseUrl: (baseUrl) => set({ baseUrl }),

      setModelName: (modelName) => set({ modelName }),

      setApiKey: (apiKey) => {
        const seq = ++apiKeyWriteSeq;
        const activeProvider = get().provider;
        set((state) => {
          if (state.provider === 'disabled') {
            return { apiKey };
          }
          return {
            apiKey,
            apiKeysByProvider: {
              ...state.apiKeysByProvider,
              [state.provider]: apiKey,
            },
          };
        });
        const scope = activeProvider === 'disabled' ? undefined : activeProvider;
        void saveApiKeySecret(apiKey, scope).catch(() => {
          // Best-effort secure storage write; never log secret values.
        }).finally(() => {
          // Ensure a stale clear cannot clobber a newer write sequence check if needed.
          void seq;
        });
      },

      hydrateApiKey: async () => {
        const activeProvider = get().provider;
        if (activeProvider === 'disabled') return '';
        if (get().apiKey) return get().apiKey;

        const writeSeqAtStart = apiKeyWriteSeq;
        const secret = await loadApiKeySecret(activeProvider);
        if (
          writeSeqAtStart === apiKeyWriteSeq &&
          get().provider === activeProvider &&
          secret &&
          !get().apiKey
        ) {
          set((state) => ({
            apiKey: secret,
            apiKeysByProvider: {
              ...state.apiKeysByProvider,
              [activeProvider]: secret,
            },
          }));
        }
        return get().provider === activeProvider ? get().apiKey || secret : '';
      },

      resetRadioAiSettings: () => {
        apiKeyWriteSeq += 1;
        set({
          ...INITIAL_SETTINGS,
          sources: { ...DEFAULT_SOURCES },
          apiKeysByProvider: {},
        });
        void clearApiKeySecret().catch(() => { /* best-effort */ });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.sources?.sonicSimilarity === undefined) {
          state.setSource('sonicSimilarity', true);
        }
        if (state.provider === 'disabled' && state.sources?.aiBoost) {
          state.setSource('aiBoost', false);
        }
        void state.hydrateApiKey().catch(() => { /* best-effort */ });
      },
      // Security invariant: apiKey is intentionally excluded from KV persistence.
      partialize: (state) => ({
        infiniteAutoplay: state.infiniteAutoplay,
        radioMode: state.radioMode,
        sources: state.sources,
        sessionAntiRepeat: state.sessionAntiRepeat,
        provider: state.provider,
        baseUrl: state.baseUrl,
        modelName: state.modelName,
      }),
    },
  ),
);
