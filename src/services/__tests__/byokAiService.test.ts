const mockFetch = jest.fn();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

const mockLoadApiKeySecret = jest.fn<Promise<string>, []>().mockResolvedValue('');
const mockSaveApiKeySecret = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
const mockClearApiKeySecret = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

jest.mock('../secureKeyVault', () => ({
  loadApiKeySecret: () => mockLoadApiKeySecret(),
  saveApiKeySecret: (k: string) => mockSaveApiKeySecret(k),
  clearApiKeySecret: () => mockClearApiKeySecret(),
}));

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertSongs } from '../../db/repository/songs';
import { offlineModeStore } from '../../store/offlineModeStore';
import { __setDbForTests, getDb } from '../../store/persistence/db';
import { radioAiSettingsStore } from '../../store/radioAiSettingsStore';
import {
  boostRadioCandidates,
  buildCompactLibraryCatalog,
  generatePlaylistFromPrompt,
  querySongsByAiCriteria,
  rerankSonicCandidates,
  testConnection,
  type AiCuratedCriteria,
} from '../byokAiService';
import type { Child } from '../subsonicService';

const db = () => getDb()!;

const TABLES_TO_CLEAR = [
  'song_genres',
  'song_artists',
  'song_album_artists',
  'song_contributors',
  'song_moods',
  'cached_item_songs',
  'cached_items',
  'cached_songs',
  'songs',
];

function makeChild(overrides: Partial<Child> & { id: string }): Child {
  return {
    title: `Song ${overrides.id}`,
    artist: 'Default Artist',
    album: 'Default Album',
    duration: 210,
    isDir: false,
    ...overrides,
  } as Child;
}

async function seedLibrary(songs: Child[]): Promise<void> {
  await upsertSongs(db(), songs);
}

function seedCachedSong(songId: string): void {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, downloaded_at, title, duration) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [songId, 'alb-1', 'mp3', 1024, 0, 0, `Cached ${songId}`, 200],
  );
}

function mockHangingFetch(): Promise<void> {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  mockFetch.mockImplementation(() => {
    markStarted();
    return new Promise(() => {
      // Intentionally never settles so the 5000 ms timeout fires.
    });
  });
  return started;
}

beforeAll(() => {
  ensureNormalizedSchema(db());
});

beforeEach(() => {
  mockFetch.mockReset();
  mockLoadApiKeySecret.mockReset().mockResolvedValue('');
  mockSaveApiKeySecret.mockReset().mockResolvedValue(undefined);
  mockClearApiKeySecret.mockReset().mockResolvedValue(undefined);

  for (const table of TABLES_TO_CLEAR) {
    db().runSync(`DELETE FROM ${table}`);
  }

  offlineModeStore.setState({ offlineMode: false });
  radioAiSettingsStore.setState({
    provider: 'disabled',
    baseUrl: '',
    modelName: '',
    apiKey: '',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ */
/*  buildCompactLibraryCatalog                                         */
/* ------------------------------------------------------------------ */

describe('buildCompactLibraryCatalog', () => {
  it('returns empty catalog when DB is unavailable or errors', async () => {
    const realDb = getDb();
    __setDbForTests(null);
    try {
      expect(await buildCompactLibraryCatalog()).toEqual({
        genres: [],
        topArtists: [],
        moods: [],
        minYear: null,
        maxYear: null,
      });
    } finally {
      __setDbForTests(realDb);
    }

    __setDbForTests({
      getAllAsync: () => Promise.reject(new Error('db fail')),
      getFirstAsync: () => Promise.reject(new Error('db fail')),
    } as never);
    try {
      expect(await buildCompactLibraryCatalog()).toEqual({
        genres: [],
        topArtists: [],
        moods: [],
        minYear: null,
        maxYear: null,
      });
    } finally {
      __setDbForTests(realDb);
    }
  });

  it('aggregates genres, top artists, moods, and year span with strict caps', async () => {
    const songs: Child[] = [];
    for (let i = 1; i <= 65; i++) {
      songs.push(
        makeChild({
          id: `s-${i}`,
          title: `Secret Track Title ${i}`,
          artist: `Artist ${String(i).padStart(2, '0')}`,
          genre: i <= 45 ? `Genre ${i}` : undefined,
          genres: i <= 45 ? [`Genre ${i}`] : undefined,
          moods: i <= 25 ? [`Mood ${i}`] : undefined,
          year: i === 1 ? 1978 : i === 2 ? 2024 : 2000,
          playCount: i === 65 ? 500 : 1,
        }),
      );
    }
    songs.push(
      makeChild({ id: 's-extra-1', artist: 'Artist 01', genre: 'Genre 1', year: 1995, playCount: 100 }),
      makeChild({ id: 's-extra-2', artist: 'Artist 01', genre: 'Genre 1', year: 0, playCount: 100 }),
      makeChild({ id: 's-singular-genre', artist: 'Artist 02', genre: 'Genre 1', genres: [], year: 2010 }),
    );

    await seedLibrary(songs);
    const catalog = await buildCompactLibraryCatalog();

    expect(catalog.genres.length).toBeLessThanOrEqual(40);
    expect(catalog.genres[0]).toBe('Genre 1');
    expect(catalog.topArtists.length).toBe(60);
    expect(catalog.topArtists.slice(0, 2)).toEqual(expect.arrayContaining(['Artist 65', 'Artist 01']));
    expect(catalog.moods.length).toBe(20);
    expect(catalog.minYear).toBe(1978);
    expect(catalog.maxYear).toBe(2024);

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('Secret Track Title');
  });
});

/* ------------------------------------------------------------------ */
/*  testConnection                                                     */
/* ------------------------------------------------------------------ */

describe('testConnection', () => {
  it('validates provider, baseUrl, modelName, and apiKey requirements', async () => {
    expect(await testConnection()).toEqual({
      ok: false,
      message: 'AI provider is disabled.',
    });

    expect(
      await testConnection({ provider: 'openai', baseUrl: '', modelName: 'gpt-4o-mini', apiKey: 'k' }),
    ).toEqual({
      ok: false,
      message: 'Provider base URL is required.',
    });

    expect(
      await testConnection({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelName: '',
        apiKey: 'k',
      }),
    ).toEqual({
      ok: false,
      message: 'Model name is required.',
    });

    expect(
      await testConnection({
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelName: 'gemini-2.5-flash',
        apiKey: '',
      }),
    ).toEqual({
      ok: false,
      message: 'API key is required for this provider.',
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails cleanly when offline mode is enabled', async () => {
    offlineModeStore.setState({ offlineMode: true });
    const res = await testConnection({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      apiKey: 'sk-test-secret',
    });
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain('offline');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('hydrates API key when store apiKey is empty and handles hydration rejection', async () => {
    radioAiSettingsStore.setState({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelName: 'llama-3.3-70b-versatile',
      apiKey: '',
    });
    mockLoadApiKeySecret.mockResolvedValueOnce('gsk_hydrated_secret');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: [{ text: '{"status":"ok"}' }] } }],
      }),
    });

    const res = await testConnection();
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe('number');
    expect(mockLoadApiKeySecret).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer gsk_hydrated_secret',
    );

    // If vault hydration throws, validation still fails cleanly without crashing.
    radioAiSettingsStore.setState({ apiKey: '' });
    mockLoadApiKeySecret.mockRejectedValueOnce(new Error('vault broken'));
    const failedHydrate = await testConnection();
    expect(failedHydrate.ok).toBe(false);
    expect(failedHydrate.message).toContain('API key is required');
  });

  it('builds Gemini URL with encoded key, skips thought parts, and handles thought-only fallback', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Internal thinking...' },
                  { text: '{"status":"ok"}' },
                ],
              },
            },
          ],
        }),
    });

    const res = await testConnection({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      modelName: 'models/gemini-2.5-flash',
      apiKey: 'AIza+Secret/Key',
    });

    expect(res.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIza%2BSecret%2FKey',
    );
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // Empty parts -> empty response failure.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
    });
    const emptyParts = await testConnection({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-2.5-flash',
      apiKey: 'AIzaKey1234',
    });
    expect(emptyParts.ok).toBe(false);
  });

  it('supports custom provider without API key and avoids doubling /chat/completions', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"status":"ok"}\n```' } }],
        }),
    });

    const res = await testConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1/chat/completions/',
      modelName: 'llama3.2',
      apiKey: '',
    });

    expect(res.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('retries without response_format when Groq/OpenAI returns HTTP 400 JSON validation error', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message:
                "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
              code: 'json_validate_failed',
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"status":"ok"}\n```' } }],
          }),
      });

    const res = await testConnection({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelName: 'openai/gpt-oss-20b',
      apiKey: 'gsk-test-secret',
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.max_completion_tokens).toBe(512);
    expect(firstBody.max_tokens).toBeUndefined();
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(secondBody.response_format).toBeUndefined();
  });

  it('retries without temperature when OpenAI returns HTTP 400 unsupported temperature', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message: "Unsupported value: 'temperature' does not support 0 with this model.",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '{"status":"ok"}' } }],
          }),
      });

    const res = await testConnection({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-6-luna',
      apiKey: 'sk-test-secret',
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.max_completion_tokens).toBe(512);
    expect(firstBody.temperature).toBe(0);
    expect(secondBody.temperature).toBeUndefined();
  });

  it('sanitizes raw and URL-encoded API keys and truncates overly long error messages', async () => {
    const secret = 'AIza+Secret/Key_99';
    const encoded = encodeURIComponent(secret);
    mockFetch.mockRejectedValueOnce(
      new Error(
        `Network failed for https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encoded} and raw ${secret} ${'x'.repeat(250)}`,
      ),
    );

    const errRes = await testConnection({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-2.5-flash',
      apiKey: secret,
    });
    expect(errRes.ok).toBe(false);
    expect(errRes.message).not.toContain(secret);
    expect(errRes.message).not.toContain(encoded);
    expect(errRes.message).toContain('[REDACTED]');
    expect(errRes.message.endsWith('...')).toBe(true);

    // Error body shapes: { error: { message } }, { error: "..." }, { message: "..." }, plain text
    const openaiSecret = 'sk-proj-verysecret-999';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: { message: `Incorrect API key provided: ${openaiSecret}` },
        }),
    });
    const httpErr1 = await testConnection({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      apiKey: openaiSecret,
    });
    expect(httpErr1.ok).toBe(false);
    expect(httpErr1.message).toContain('HTTP 401');
    expect(httpErr1.message).not.toContain(openaiSecret);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: 'Rate limit exceeded' }),
    });
    const httpErr2 = await testConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      modelName: 'llama3.2',
    });
    expect(httpErr2.message).toBe('HTTP 429: Rate limit exceeded');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ message: 'Bad gateway' }),
    });
    const httpErr3 = await testConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      modelName: 'llama3.2',
    });
    expect(httpErr3.message).toBe('HTTP 502: Bad gateway');
  });

  it('enforces strict 5000 ms timeout and handles AbortError rejection', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise(() => {});
    });

    const pending = testConnection({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      apiKey: 'sk-timeout-test',
    });

    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    const res = await pending;

    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain('timed out');
    expect(capturedSignal?.aborted).toBe(true);

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortErr);
    const abortedRes = await testConnection({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      modelName: 'llama3.2',
    });
    expect(abortedRes.ok).toBe(false);
    expect(abortedRes.message.toLowerCase()).toContain('timed out');
  });

  it('rejects non-JSON outer responses, empty choices, and invalid inner JSON payloads', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html>Portal Login</html>',
    });
    expect(
      (
        await testConnection({
          provider: 'custom',
          baseUrl: 'http://localhost:11434/v1',
          modelName: 'llama3.2',
        })
      ).ok,
    ).toBe(false);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [] }),
    });
    expect(
      (
        await testConnection({
          provider: 'custom',
          baseUrl: 'http://localhost:11434/v1',
          modelName: 'llama3.2',
        })
      ).ok,
    ).toBe(false);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: 'Not JSON at all' } }] }),
    });
    expect(
      (
        await testConnection({
          provider: 'custom',
          baseUrl: 'http://localhost:11434/v1',
          modelName: 'llama3.2',
        })
      ).ok,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  querySongsByAiCriteria                                             */
/* ------------------------------------------------------------------ */

describe('querySongsByAiCriteria', () => {
  it('scores candidates by matched criteria, hydrates rows, excludes IDs, and deduplicates', async () => {
    await seedLibrary([
      makeChild({
        id: 'best',
        title: 'Midnight Rain',
        artist: 'Radiohead',
        artists: [{ id: 'ar-1', name: 'Radiohead', albumCount: 0 }],
        genre: 'Alternative Rock',
        genres: ['Alternative Rock'],
        moods: ['melancholic'],
        year: 1997,
        bpm: 92,
        starred: new Date(),
        playCount: 10,
        userRating: 5,
      }),
      makeChild({
        id: 'partial',
        title: 'Sunny Day',
        artist: 'Radiohead',
        genre: 'Electronic',
        genres: ['Electronic'],
        year: 2007,
        bpm: 130,
      }),
      makeChild({
        id: 'mood-and-subgenre',
        title: 'Ambient Drift',
        artist: 'Radiohead Tribute',
        genre: 'Alternative',
        genres: ['Alternative'],
        moods: ['melancholic dream'],
        year: 1998,
        bpm: 90,
      }),
      makeChild({
        id: 'excluded',
        title: 'Excluded Track',
        artist: 'Radiohead',
        genre: 'Alternative Rock',
        genres: ['Alternative Rock'],
        moods: ['melancholic'],
        year: 1997,
        bpm: 92,
      }),
      makeChild({
        id: 'unrelated',
        title: 'Party Anthem',
        artist: 'Pop Star',
        genre: 'Dance Pop',
        genres: ['Dance Pop'],
        year: 2022,
        bpm: 128,
      }),
    ]);

    const criteria: AiCuratedCriteria = {
      artists: ['Radiohead'],
      genres: ['Alternative Rock'],
      fromYear: 1995,
      toYear: 2000,
      keywords: ['melancholic'],
      minBpm: 80,
      maxBpm: 100,
    };

    const results = await querySongsByAiCriteria(criteria, 10, new Set(['excluded']));
    expect(results.map((r) => r.id)).toEqual(['best', 'mood-and-subgenre', 'partial']);
    expect(results[0].genres).toEqual(['Alternative Rock']);
    expect(results[0].moods).toEqual(['melancholic']);
    expect(results[0].artists?.[0].name).toBe('Radiohead');
  });

  it('tops up sparse semantic matches with matching year/BPM tracks and deduplicates overlaps', async () => {
    await seedLibrary([
      makeChild({ id: 'sem-1', artist: 'Rare Artist', genre: 'Ambient', year: 1996, bpm: 95 }),
      makeChild({ id: 'era-2', artist: 'Other Band', genre: 'Rock', year: 1997, bpm: 94 }),
      makeChild({ id: 'era-3', artist: 'Third Band', genre: 'Pop', year: 2022, bpm: 140 }),
    ]);

    const results = await querySongsByAiCriteria(
      { artists: ['Rare Artist'], genres: [], keywords: [], fromYear: 1995, toYear: 1999 },
      5,
    );
    expect(results.map((r) => r.id)).toEqual(['sem-1', 'era-2']);
  });

  it('restricts to cached_songs when downloadedOnly or offlineMode is true', async () => {
    await seedLibrary([
      makeChild({ id: 'online-only', artist: 'Daft Punk', genre: 'Electronic', genres: ['Electronic'] }),
      makeChild({ id: 'cached-1', artist: 'Daft Punk', genre: 'Electronic', genres: ['Electronic'] }),
    ]);
    seedCachedSong('cached-1');

    const criteria: AiCuratedCriteria = {
      artists: ['Daft Punk'],
      genres: ['Electronic'],
      keywords: [],
    };

    const downloaded = await querySongsByAiCriteria(criteria, 10, undefined, true);
    expect(downloaded.map((s) => s.id)).toEqual(['cached-1']);

    offlineModeStore.setState({ offlineMode: true });
    const offline = await querySongsByAiCriteria(criteria, 10);
    expect(offline.map((s) => s.id)).toEqual(['cached-1']);
  });

  it('handles range-only criteria, inverted ranges, and LIKE special characters safely', async () => {
    await seedLibrary([
      makeChild({ id: '100pct', artist: '100% Pure_Sound', genre: 'House', year: 1994, bpm: 124 }),
      makeChild({ id: 'other', artist: '9000 Pure Sound', genre: 'House', year: 2015, bpm: 124 }),
    ]);

    const likeRes = await querySongsByAiCriteria(
      { artists: ['100% Pure_Sound'], genres: [], keywords: [] },
      10,
    );
    expect(likeRes.map((s) => s.id)).toEqual(['100pct']);

    const rangeRes = await querySongsByAiCriteria(
      { artists: [], genres: [], keywords: [], fromYear: 1999, toYear: 1990, minBpm: 130, maxBpm: 120 },
      10,
    );
    expect(rangeRes.map((s) => s.id)).toEqual(['100pct', 'other']);
  });

  it('returns [] for empty criteria, zero limit, null DB, or SQL errors', async () => {
    expect(await querySongsByAiCriteria({ artists: [], genres: [], keywords: [] }, 10)).toEqual([]);
    expect(await querySongsByAiCriteria({ artists: ['A'], genres: [], keywords: [] }, 0)).toEqual([]);

    const realDb = getDb();
    __setDbForTests(null);
    try {
      expect(await querySongsByAiCriteria({ artists: ['A'], genres: [], keywords: [] }, 10)).toEqual([]);
    } finally {
      __setDbForTests(realDb);
    }

    __setDbForTests({
      getAllAsync: () => Promise.reject(new Error('sql error')),
    } as never);
    try {
      expect(await querySongsByAiCriteria({ artists: ['A'], genres: [], keywords: [] }, 10)).toEqual([]);
    } finally {
      __setDbForTests(realDb);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  generatePlaylistFromPrompt                                         */
/* ------------------------------------------------------------------ */

describe('generatePlaylistFromPrompt', () => {
  beforeEach(() => {
    radioAiSettingsStore.setState({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      apiKey: 'sk-playlist-secret',
    });
  });

  it('parses prose/escaped-quote JSON and returns curated tracks without dumping song list', async () => {
    await seedLibrary([
      makeChild({ id: 'j1', title: 'Blue in Green', artist: 'Miles Davis', genre: 'Jazz', genres: ['Jazz'], year: 1959 }),
      makeChild({ id: 'j2', title: 'So What', artist: 'Miles Davis', genre: 'Jazz', genres: ['Jazz'], year: 1959 }),
      makeChild({ id: 'j3', title: 'Take Five', artist: 'Dave Brubeck', genre: 'Jazz', genres: ['Jazz'], year: 1959 }),
      makeChild({ id: 'r1', title: 'Back in Black', artist: 'AC/DC', genre: 'Hard Rock', genres: ['Hard Rock'], year: 1980 }),
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<think>Choosing classic jazz</think>Here is your JSON: ' +
                  '{"artists":["Miles Davis","Dave Brubeck"],"genres":["Jazz"],"fromYear":1955,"toYear":1965,"keywords":["note \\"blue\\""],"moods":["cool"],"minBpm":null,"maxBpm":null}' +
                  ' — enjoy!',
              },
            },
          ],
        }),
    });

    const fallbackFn = jest.fn().mockResolvedValue([makeChild({ id: 'fb' })]);
    const songs = await generatePlaylistFromPrompt('late night 50s jazz', 10, fallbackFn);

    expect(songs.map((s) => s.id)).toEqual(['j1', 'j2', 'j3']);
    expect(fallbackFn).not.toHaveBeenCalled();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = String(init.body);
    expect(sentBody).not.toContain('Blue in Green');
    expect(sentBody).not.toContain('Back in Black');
  });

  it('degrades silently to fallbackFn or local SQLite fallback on disabled, offline, timeout, HTTP error, or invalid JSON', async () => {
    await seedLibrary([
      makeChild({ id: 'local-1', title: 'Night Jazz', artist: 'Bill Evans', genre: 'Jazz', starred: new Date() }),
      makeChild({ id: 'local-2', title: 'Other Track', artist: 'Other', genre: 'Pop' }),
    ]);

    const fallbackTrack = makeChild({ id: 'custom-fb', title: 'Fallback Song' });
    const fallbackFn = jest.fn().mockResolvedValue([fallbackTrack]);

    // 1. Disabled provider -> fallbackFn
    radioAiSettingsStore.setState({ provider: 'disabled' });
    expect((await generatePlaylistFromPrompt('jazz', 10, fallbackFn)).map((s) => s.id)).toEqual(['custom-fb']);
    expect(mockFetch).not.toHaveBeenCalled();

    // 2. Offline mode -> local SQLite fallback (restricted to cached_songs) when no fallbackFn
    seedCachedSong('local-1');
    offlineModeStore.setState({ offlineMode: true });
    radioAiSettingsStore.setState({ provider: 'openai' });
    const offlineLocal = await generatePlaylistFromPrompt('jazz', 10);
    expect(offlineLocal.map((s) => s.id)).toEqual(['local-1']);
    expect(mockFetch).not.toHaveBeenCalled();

    // 3. HTTP error -> fallback
    offlineModeStore.setState({ offlineMode: false });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });
    expect((await generatePlaylistFromPrompt('jazz', 10, fallbackFn)).map((s) => s.id)).toEqual(['custom-fb']);

    // 4. Unrecognized JSON shape -> fallback even if fallbackFn throws -> local SQLite
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"unrelated":"ok"}' } }] }),
    });
    const throwingFallback = jest.fn().mockRejectedValue(new Error('fallback exploded'));
    const rescued = await generatePlaylistFromPrompt('jazz', 10, throwingFallback);
    expect(rescued.map((s) => s.id)).toContain('local-1');

    // 5. Timeout (5000 ms) -> fallback
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const fetchStarted = mockHangingFetch();
    const timedPromise = generatePlaylistFromPrompt('jazz', 10, fallbackFn);
    await fetchStarted;
    jest.advanceTimersByTime(5000);
    expect((await timedPromise).map((s) => s.id)).toEqual(['custom-fb']);
  });

  it('supplements empty and sparse AI results with fallbackFn or local SQLite library tracks', async () => {
    const library: Child[] = [
      makeChild({ id: 'ai-hit', artist: 'Rare Artist', genre: 'Shoegaze', genres: ['Shoegaze'] }),
    ];
    for (let i = 1; i <= 10; i++) {
      library.push(
        makeChild({ id: `lib-${i}`, title: `Dreamy Song ${i}`, artist: `Band ${i}`, genre: 'Dream Pop', starred: new Date() }),
      );
    }
    await seedLibrary(library);

    // Sparse with fallbackFn
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"artists":["Rare Artist"],"genres":["Shoegaze"],"keywords":[]}',
              },
            },
          ],
        }),
    });

    const fallbackFn = jest.fn().mockResolvedValue([
      makeChild({ id: 'ai-hit', artist: 'Rare Artist' }),
      makeChild({ id: 'fb-2', artist: 'Similar Artist' }),
      makeChild({ id: 'fb-3', artist: 'Another Artist' }),
    ]);

    const result = await generatePlaylistFromPrompt('shoegaze', 10, fallbackFn);
    expect(result.map((s) => s.id)).toEqual(['ai-hit', 'fb-2', 'fb-3']);
    expect(fallbackFn).toHaveBeenCalledTimes(1);

    // Sparse without fallbackFn (DB >= 10 songs) -> supplements via local SQLite query
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"artists":["Rare Artist"],"genres":[],"keywords":[]}' } }],
        }),
    });
    const localSupplemented = await generatePlaylistFromPrompt('dreamy', 6);
    expect(localSupplemented[0].id).toBe('ai-hit');
    expect(localSupplemented.length).toBe(6);

    // Empty criteria match without fallbackFn -> falls back to local SQLite
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"artists":["Nonexistent Artist"],"genres":[],"keywords":[]}' } }],
        }),
    });
    const emptyFallback = await generatePlaylistFromPrompt('dreamy', 5);
    expect(emptyFallback.length).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/*  boostRadioCandidates                                               */
/* ------------------------------------------------------------------ */

describe('boostRadioCandidates', () => {
  const seed = makeChild({
    id: 'seed-1',
    title: 'Teardrop',
    artist: 'Massive Attack',
    genre: 'Trip-Hop',
    year: 1998,
    bpm: 77,
  });

  beforeEach(() => {
    radioAiSettingsStore.setState({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelName: 'llama-3.3-70b-versatile',
      apiKey: 'gsk-radio-secret',
    });
  });

  it('returns matching radio candidates excluding seed and excludeIds', async () => {
    await seedLibrary([
      seed,
      makeChild({ id: 'cand-1', artist: 'Portishead', genre: 'Trip-Hop', genres: ['Trip-Hop'], year: 1994 }),
      makeChild({ id: 'already-queued', artist: 'Portishead', genre: 'Trip-Hop', genres: ['Trip-Hop'], year: 1994 }),
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"artists":["Portishead","Massive Attack"],"genres":["Trip-Hop"],"keywords":[]}',
              },
            },
          ],
        }),
    });

    const candidates = await boostRadioCandidates([seed], 15, new Set(['already-queued']));
    expect(candidates.map((c) => c.id)).toEqual(['cand-1']);
  });

  it('returns [] silently on empty seeds, disabled, offline, invalid JSON, errors, or timeout', async () => {
    expect(await boostRadioCandidates([])).toEqual([]);

    radioAiSettingsStore.setState({ provider: 'disabled' });
    expect(await boostRadioCandidates([seed])).toEqual([]);

    radioAiSettingsStore.setState({ provider: 'groq' });
    offlineModeStore.setState({ offlineMode: true });
    expect(await boostRadioCandidates([seed])).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();

    offlineModeStore.setState({ offlineMode: false });
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    expect(await boostRadioCandidates([seed])).toEqual([]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'bad json' } }] }),
    });
    expect(await boostRadioCandidates([seed])).toEqual([]);

    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const fetchStarted = mockHangingFetch();
    const pending = boostRadioCandidates([seed]);
    await fetchStarted;
    jest.advanceTimersByTime(5000);
    expect(await pending).toEqual([]);
  });
});

describe('rerankSonicCandidates', () => {
  const seed = makeChild({ id: 'seed-1', artist: 'Massive Attack', genre: 'Trip-Hop' });
  const c1 = makeChild({ id: 'c1', title: 'Track 1', artist: 'Artist A' });
  const c2 = makeChild({ id: 'c2', title: 'Track 2', artist: 'Artist B' });
  const c3 = makeChild({ id: 'c3', title: 'Track 3', artist: 'Artist C' });

  it('reorders sonic candidates per rankedIds while preserving remaining candidates and degrades safely on error', async () => {
    radioAiSettingsStore.setState({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelName: 'llama-3.3-70b-versatile',
      apiKey: 'gsk-radio-secret',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"rankedIds":["c3","c1","unknown-id"]}',
              },
            },
          ],
        }),
    });

    const reranked = await rerankSonicCandidates([seed], [c1, c2, c3]);
    expect(reranked.map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);

    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const fallback = await rerankSonicCandidates([seed], [c1, c2, c3]);
    expect(fallback.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
});
