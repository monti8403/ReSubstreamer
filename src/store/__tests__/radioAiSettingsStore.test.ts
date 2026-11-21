const mockFetch = jest.fn();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

const mockKvBacking = new Map<string, string>();
jest.mock('../persistence/kvStorage', () => ({
  kvStorageSync: {
    getItem: (k: string) => mockKvBacking.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mockKvBacking.set(k, v);
    },
    removeItem: (k: string) => {
      mockKvBacking.delete(k);
    },
  },
  kvStorage: {
    getItem: async (k: string) => mockKvBacking.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      mockKvBacking.set(k, v);
    },
    removeItem: async (k: string) => {
      mockKvBacking.delete(k);
    },
  },
  clearKvStorage: async () => {
    mockKvBacking.clear();
  },
}));

const mockLoadApiKeySecret = jest.fn<Promise<string>, [string?]>().mockResolvedValue('');
const mockSaveApiKeySecret = jest.fn<Promise<void>, [string, string?]>().mockResolvedValue(undefined);
const mockClearApiKeySecret = jest.fn<Promise<void>, [string?]>().mockResolvedValue(undefined);

jest.mock('../../services/secureKeyVault', () => ({
  loadApiKeySecret: (provider?: string) => mockLoadApiKeySecret(provider),
  saveApiKeySecret: (k: string, provider?: string) => mockSaveApiKeySecret(k, provider),
  clearApiKeySecret: (provider?: string) => mockClearApiKeySecret(provider),
}));

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { getSmartRadioTracks, registerSmartRadioAiBoostProvider } from '../../services/smartRadioService';
import {
  AI_PROVIDER_DEFAULTS,
  radioAiSettingsStore,
} from '../radioAiSettingsStore';

const db = () => getDb()!;

beforeAll(() => {
  ensureNormalizedSchema(db());
});

beforeEach(() => {
  mockKvBacking.clear();
  mockFetch.mockReset();
  mockLoadApiKeySecret.mockReset().mockResolvedValue('');
  mockSaveApiKeySecret.mockReset().mockResolvedValue(undefined);
  mockClearApiKeySecret.mockReset().mockResolvedValue(undefined);
  registerSmartRadioAiBoostProvider(null);
  radioAiSettingsStore.getState().resetRadioAiSettings();
  db().runSync('DELETE FROM song_genres');
  db().runSync('DELETE FROM songs');
});

describe('radioAiSettingsStore', () => {
  it('initializes with expected defaults and pre-fills provider endpoints', () => {
    const state = radioAiSettingsStore.getState();
    expect(state.infiniteAutoplay).toBe(true);
    expect(state.radioMode).toBe('mood');
    expect(state.sources).toEqual({
      sonicSimilarity: true,
      server: true,
      localHistory: true,
      metadata: true,
      aiBoost: false,
    });
    expect(state.sessionAntiRepeat).toBe(true);
    expect(state.provider).toBe('disabled');

    state.setProvider('gemini');
    expect(radioAiSettingsStore.getState().baseUrl).toBe(AI_PROVIDER_DEFAULTS.gemini.baseUrl);
    expect(radioAiSettingsStore.getState().modelName).toBe(AI_PROVIDER_DEFAULTS.gemini.modelName);

    state.setProvider('custom');
    expect(radioAiSettingsStore.getState().baseUrl).toBe(AI_PROVIDER_DEFAULTS.custom.baseUrl);
    expect(radioAiSettingsStore.getState().modelName).toBe(AI_PROVIDER_DEFAULTS.custom.modelName);
  });

  it('disables aiBoost when provider is disabled and keeps apiKey out of plain KV persistence', () => {
    const state = radioAiSettingsStore.getState();
    state.setSource('aiBoost', true);
    expect(radioAiSettingsStore.getState().sources.aiBoost).toBe(false);

    state.setProvider('openai');
    state.setSource('aiBoost', true);
    state.setApiKey('sk-super-secret-token-123');

    expect(radioAiSettingsStore.getState().sources.aiBoost).toBe(true);
    expect(mockSaveApiKeySecret).toHaveBeenCalledWith('sk-super-secret-token-123', 'openai');

    const persistedRaw = mockKvBacking.get('substreamer-radio-ai-settings') ?? '';
    expect(persistedRaw).not.toContain('sk-super-secret-token-123');
    expect(persistedRaw).not.toContain('apiKey');

    state.setProvider('disabled');
    expect(radioAiSettingsStore.getState().sources.aiBoost).toBe(false);
    expect(radioAiSettingsStore.getState().apiKey).toBe('');
  });

  it('keeps API keys isolated per provider when switching providers', async () => {
    const state = radioAiSettingsStore.getState();

    state.setProvider('groq');
    state.setApiKey('gsk-groq-secret');
    expect(radioAiSettingsStore.getState().apiKey).toBe('gsk-groq-secret');
    expect(mockSaveApiKeySecret).toHaveBeenCalledWith('gsk-groq-secret', 'groq');

    // Switching to Gemini must not show Groq's key
    state.setProvider('gemini');
    expect(radioAiSettingsStore.getState().apiKey).toBe('');

    mockLoadApiKeySecret.mockResolvedValueOnce('AIza-gemini-secret');
    await radioAiSettingsStore.getState().hydrateApiKey();
    expect(mockLoadApiKeySecret).toHaveBeenCalledWith('gemini');
    expect(radioAiSettingsStore.getState().apiKey).toBe('AIza-gemini-secret');

    // Switching back to Groq restores Groq's key, not Gemini's
    state.setProvider('groq');
    expect(radioAiSettingsStore.getState().apiKey).toBe('gsk-groq-secret');

    // Persisted KV storage never receives apiKey or apiKeysByProvider
    const persistedRaw = mockKvBacking.get('substreamer-radio-ai-settings') ?? '';
    expect(persistedRaw).not.toContain('gsk-groq-secret');
    expect(persistedRaw).not.toContain('AIza-gemini-secret');
    expect(persistedRaw).not.toContain('apiKeysByProvider');
  });

  it('wires SmartRadioService aiBoost directly to ByokAiService.boostRadioCandidates', async () => {
    await upsertSongs(db(), [
      { id: 'seed-1', title: 'Seed', artist: 'Artist A', genre: 'Electronic', duration: 200, isDir: false },
      { id: 'ai-cand-1', title: 'AI Pick', artist: 'Boards of Canada', genre: 'Electronic', duration: 220, isDir: false },
    ]);

    radioAiSettingsStore.setState({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      apiKey: 'sk-live-test',
      sources: { sonicSimilarity: false, server: false, localHistory: false, metadata: false, aiBoost: true },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"artists":["Boards of Canada"],"genres":["Electronic"],"keywords":[]}',
              },
            },
          ],
        }),
    });

    const tracks = await getSmartRadioTracks({
      seedSongs: [{ id: 'seed-1', title: 'Seed', artist: 'Artist A', genre: 'Electronic', isDir: false } as any],
      targetCount: 5,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(tracks.map((t) => t.id)).toContain('ai-cand-1');
  });
});
