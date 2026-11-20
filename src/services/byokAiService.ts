/**
 * Bring-Your-Own-Key (BYOK) AI curation service.
 *
 * Supports Gemini, Groq, OpenAI, and custom OpenAI-compatible endpoints (e.g. Ollama).
 * All network calls enforce a strict 5000 ms timeout with AbortSignal propagation,
 * sanitize errors to prevent API key leakage, never dump the user's full song list
 * in prompts, and degrade silently to local fallbacks on any failure or offline state.
 */
import {
  SONG_LIST_COLS_S,
  hydrateSongRows,
  songListRowToChild,
  type SongListRow,
} from '../db/repository/songs';
import type { InternalDb } from '../db/client';
import { offlineModeStore } from '../store/offlineModeStore';
import { getDb } from '../store/persistence/db';
import {
  radioAiSettingsStore,
  type AiProvider,
  type RadioAiSettingsSnapshot,
} from '../store/radioAiSettingsStore';
import { errMessage } from '../utils/errorMessage';
import { withTimeout } from '../utils/withTimeout';
import type { Child } from './subsonicService';

const AI_REQUEST_TIMEOUT_MS = 5000;

const CATALOG_GENRE_LIMIT = 40;
const CATALOG_ARTIST_LIMIT = 60;
const CATALOG_MOOD_LIMIT = 20;

const MAX_CRITERIA_ARTISTS = 10;
const MAX_CRITERIA_GENRES = 10;
const MAX_CRITERIA_KEYWORDS = 12;
const MAX_PROMPT_LENGTH = 500;
const MAX_SEED_SONGS = 10;
const MAX_ERROR_MESSAGE_LEN = 220;
const SPARSE_RESULT_FLOOR = 3;

const PROMPT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'at', 'best', 'by', 'create', 'for', 'from',
  'give', 'good', 'great', 'in', 'into', 'like', 'make', 'me', 'mix', 'music',
  'my', 'of', 'on', 'or', 'play', 'playlist', 'some', 'song', 'songs', 'that',
  'the', 'this', 'to', 'track', 'tracks', 'vibe', 'vibes', 'with',
]);

/* ------------------------------------------------------------------ */
/*  Exported types                                                     */
/* ------------------------------------------------------------------ */

export interface AiConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface AiCuratedCriteria {
  artists: string[];
  genres: string[];
  fromYear?: number | null;
  toYear?: number | null;
  keywords: string[];
  minBpm?: number | null;
  maxBpm?: number | null;
}

export interface CompactLibraryCatalog {
  genres: string[];
  topArtists: string[];
  moods: string[];
  minYear: number | null;
  maxYear: number | null;
}

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

type ActiveAiProvider = Exclude<AiProvider, 'disabled'>;

interface ResolvedAiSettings {
  provider: AiProvider;
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

interface ValidatedAiSettings {
  provider: ActiveAiProvider;
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

interface NormalizedCriteria {
  artists: string[];
  genres: string[];
  keywords: string[];
  fromYear: number | null;
  toYear: number | null;
  minBpm: number | null;
  maxBpm: number | null;
}

interface SqlFragment {
  sql: string;
  params: (string | number)[];
}

/* ------------------------------------------------------------------ */
/*  Security & settings helpers                                        */
/* ------------------------------------------------------------------ */

/** Redact query-param keys, bearer tokens, and raw/encoded secret occurrences. */
function sanitizeErrorMessage(raw: string, apiKey?: string): string {
  let sanitized = raw
    .replace(/([?&]key=)[^&\s"'`<>]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s"'`<>]+/gi, '$1[REDACTED]');

  const trimmedKey = (apiKey ?? '').trim();
  if (trimmedKey.length >= 4) {
    sanitized = sanitized.split(trimmedKey).join('[REDACTED]');
    const encodedKey = encodeURIComponent(trimmedKey);
    if (encodedKey.length >= 4 && encodedKey !== trimmedKey) {
      sanitized = sanitized.split(encodedKey).join('[REDACTED]');
    }
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  if (sanitized.length > MAX_ERROR_MESSAGE_LEN) {
    return `${sanitized.slice(0, MAX_ERROR_MESSAGE_LEN - 3)}...`;
  }
  return sanitized;
}

async function resolveAiSettings(
  override?: Partial<RadioAiSettingsSnapshot>,
): Promise<ResolvedAiSettings> {
  const state = radioAiSettingsStore.getState();
  const provider = override?.provider ?? state.provider;
  const baseUrl = (override?.baseUrl ?? state.baseUrl ?? '').trim();
  const modelName = (override?.modelName ?? state.modelName ?? '').trim();

  const hasExplicitKey = override !== undefined && override.apiKey !== undefined;
  let apiKey = (hasExplicitKey ? override.apiKey ?? '' : state.apiKey ?? '').trim();

  if (!hasExplicitKey && !apiKey && provider !== 'disabled') {
    try {
      apiKey = (await state.hydrateApiKey()).trim();
    } catch {
      // Best-effort vault hydration; missing/unreadable key fails validation cleanly.
      apiKey = '';
    }
  }

  return { provider, baseUrl, modelName, apiKey };
}

function validateAiSettings(
  settings: ResolvedAiSettings,
): { ok: true; settings: ValidatedAiSettings } | { ok: false; message: string } {
  if (settings.provider === 'disabled') {
    return { ok: false, message: 'AI provider is disabled.' };
  }
  if (!settings.baseUrl) {
    return { ok: false, message: 'Provider base URL is required.' };
  }
  if (!settings.modelName) {
    return { ok: false, message: 'Model name is required.' };
  }
  if (settings.provider !== 'custom' && !settings.apiKey) {
    return { ok: false, message: 'API key is required for this provider.' };
  }
  return {
    ok: true,
    settings: {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      modelName: settings.modelName,
      apiKey: settings.apiKey,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP transport & provider payload handling                         */
/* ------------------------------------------------------------------ */

interface EndpointCompatOptions {
  omitResponseFormat?: boolean;
  omitTemperature?: boolean;
}

function buildEndpointRequest(
  settings: ValidatedAiSettings,
  systemPrompt: string,
  userPrompt: string,
  isPing: boolean,
  compat: EndpointCompatOptions = {},
): { url: string; headers: Record<string, string>; body: string; usedResponseFormat: boolean } {
  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');

  if (settings.provider === 'gemini') {
    const cleanModel = settings.modelName.replace(/^models\//i, '');
    const url =
      `${cleanBaseUrl}/models/${encodeURIComponent(cleanModel)}:generateContent` +
      `?key=${encodeURIComponent(settings.apiKey)}`;
    return {
      url,
      headers: { 'Content-Type': 'application/json' },
      usedResponseFormat: false,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          temperature: isPing ? 0 : 0.2,
          // Keep generous headroom on thinking-capable Gemini models (e.g. 3.8 Flash)
          // so reasoning tokens do not exhaust output before the JSON arrives.
          maxOutputTokens: isPing ? 512 : 1536,
          responseMimeType: 'application/json',
        },
      }),
    };
  }

  const url = /\/chat\/completions$/i.test(cleanBaseUrl)
    ? cleanBaseUrl
    : `${cleanBaseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  const useJsonMode =
    !compat.omitResponseFormat &&
    (settings.provider === 'openai' || settings.provider === 'groq');
  const tokenLimit = isPing ? 512 : 1536;
  const usesMaxCompletionTokens = settings.provider === 'openai' || settings.provider === 'groq';

  return {
    url,
    headers,
    usedResponseFormat: useJsonMode,
    body: JSON.stringify({
      model: settings.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(compat.omitTemperature ? {} : { temperature: isPing ? 0 : 0.2 }),
      // OpenAI (e.g. gpt-6-luna) and Groq (e.g. openai/gpt-oss-20b) use
      // max_completion_tokens so reasoning tokens do not trigger 400 errors or truncate JSON;
      // custom servers (Ollama/LocalAI/vLLM) retain widely supported max_tokens.
      ...(usesMaxCompletionTokens
        ? { max_completion_tokens: tokenLimit }
        : { max_tokens: tokenLimit }),
      ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  };
}

async function readResponseText(response: Response): Promise<string> {
  if (typeof response.text === 'function') {
    return response.text();
  }
  if (typeof response.json === 'function') {
    const data: unknown = await response.json();
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
  return '';
}

function extractHttpErrorDetail(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (record.error && typeof record.error === 'object') {
        const errMsg = (record.error as { message?: unknown }).message;
        if (typeof errMsg === 'string' && errMsg.trim()) return errMsg.trim();
      }
      if (typeof record.error === 'string' && record.error.trim()) {
        return record.error.trim();
      }
      if (typeof record.message === 'string' && record.message.trim()) {
        return record.message.trim();
      }
    }
  } catch {
    // Plain-text / HTML error bodies fall back to the raw text.
  }
  return trimmed;
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0] as { content?: { parts?: unknown[] } } | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return '';

  const nonThoughtTexts = parts
    .filter(
      (p): p is { text: string; thought?: boolean } =>
        Boolean(p) &&
        typeof p === 'object' &&
        typeof (p as { text?: unknown }).text === 'string' &&
        !(p as { thought?: unknown }).thought,
    )
    .map((p) => p.text);
  if (nonThoughtTexts.length > 0) {
    return nonThoughtTexts.join('\n').trim();
  }

  const anyTexts = parts
    .filter(
      (p): p is { text: string } =>
        Boolean(p) && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text);
  return anyTexts.join('\n').trim();
}

function extractOpenAiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { text: string } =>
          Boolean(part) &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

type ProviderCallResult =
  | { ok: true; text: string; latencyMs: number }
  | { ok: false; message: string };

function getCompatRetryOptions(
  status: number,
  detail: string,
  usedResponseFormat: boolean,
  alreadyCompat: EndpointCompatOptions,
): EndpointCompatOptions | null {
  if (status !== 400) return null;
  const jsonRejected =
    usedResponseFormat && /json|response_format|json_validate_failed|failed_generation/i.test(detail);
  const tempRejected = !alreadyCompat.omitTemperature && /temperature/i.test(detail);
  if (!jsonRejected && !tempRejected) return null;
  return {
    omitResponseFormat: alreadyCompat.omitResponseFormat || jsonRejected,
    omitTemperature: alreadyCompat.omitTemperature || tempRejected,
  };
}

async function sendProviderRequest(
  settings: ValidatedAiSettings,
  systemPrompt: string,
  userPrompt: string,
  isPing: boolean,
  compat: EndpointCompatOptions,
  timeoutMs: number,
): Promise<ProviderCallResult & { compatRetry?: EndpointCompatOptions }> {
  const { url, headers, body, usedResponseFormat } = buildEndpointRequest(
    settings,
    systemPrompt,
    userPrompt,
    isPing,
    compat,
  );
  const startedAt = Date.now();

  try {
    const networkResult = await withTimeout(async (signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal,
      });
      const status = typeof response.status === 'number' ? response.status : response.ok ? 200 : 500;
      const rawText = await readResponseText(response);
      return { ok: response.ok, status, rawText };
    }, timeoutMs);

    const latencyMs = Math.max(0, Date.now() - startedAt);

    if (networkResult === 'timeout') {
      return { ok: false, message: 'Connection timed out after 5 seconds.' };
    }

    if (!networkResult.ok) {
      const detail = sanitizeErrorMessage(
        extractHttpErrorDetail(networkResult.rawText),
        settings.apiKey,
      );
      const compatRetry = getCompatRetryOptions(
        networkResult.status,
        detail,
        usedResponseFormat,
        compat,
      );
      if (compatRetry) {
        return {
          ok: false,
          compatRetry,
          message: detail ? `HTTP ${networkResult.status}: ${detail}` : `HTTP ${networkResult.status}`,
        };
      }
      return {
        ok: false,
        message: detail ? `HTTP ${networkResult.status}: ${detail}` : `HTTP ${networkResult.status}`,
      };
    }

    let parsedOuter: unknown;
    try {
      parsedOuter = JSON.parse(networkResult.rawText);
    } catch {
      return { ok: false, message: 'Provider returned a non-JSON response.' };
    }

    const text =
      settings.provider === 'gemini'
        ? extractGeminiText(parsedOuter)
        : extractOpenAiText(parsedOuter);

    if (!text) {
      return { ok: false, message: 'Provider returned an empty response.' };
    }

    return { ok: true, text, latencyMs };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'Connection timed out after 5 seconds.' };
    }
    const sanitized = sanitizeErrorMessage(errMessage(err), settings.apiKey);
    return { ok: false, message: sanitized || 'Connection failed.' };
  }
}

async function callAiProvider(
  settings: ValidatedAiSettings,
  systemPrompt: string,
  userPrompt: string,
  isPing: boolean,
): Promise<ProviderCallResult> {
  const startedAt = Date.now();
  const firstAttempt = await sendProviderRequest(
    settings,
    systemPrompt,
    userPrompt,
    isPing,
    {},
    AI_REQUEST_TIMEOUT_MS,
  );
  if (firstAttempt.ok || !firstAttempt.compatRetry) {
    return firstAttempt;
  }

  const remainingMs = AI_REQUEST_TIMEOUT_MS - (Date.now() - startedAt);
  if (remainingMs <= 100) {
    return { ok: false, message: 'Connection timed out after 5 seconds.' };
  }

  const retryAttempt = await sendProviderRequest(
    settings,
    systemPrompt,
    userPrompt,
    isPing,
    firstAttempt.compatRetry,
    remainingMs,
  );
  if (retryAttempt.ok) {
    return {
      ok: true,
      text: retryAttempt.text,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }
  return retryAttempt;
}

/* ------------------------------------------------------------------ */
/*  JSON extraction & criteria validation                              */
/* ------------------------------------------------------------------ */

function findBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  const candidates = [cleaned];
  const balanced = findBalancedJsonObject(cleaned);
  if (balanced && balanced !== cleaned) {
    candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function normalizeStringList(value: unknown, maxItems: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }

  return out;
}

function normalizeYear(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int < 1000 || int > 2200) return null;
  return int;
}

function normalizeBpm(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int <= 0 || int > 500) return null;
  return int;
}

function normalizeCriteria(criteria: AiCuratedCriteria): NormalizedCriteria {
  const artists = normalizeStringList(criteria.artists, MAX_CRITERIA_ARTISTS);
  const genres = normalizeStringList(criteria.genres, MAX_CRITERIA_GENRES);
  const keywords = normalizeStringList(criteria.keywords, MAX_CRITERIA_KEYWORDS);
  let fromYear = normalizeYear(criteria.fromYear);
  let toYear = normalizeYear(criteria.toYear);
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    [fromYear, toYear] = [toYear, fromYear];
  }
  let minBpm = normalizeBpm(criteria.minBpm);
  let maxBpm = normalizeBpm(criteria.maxBpm);
  if (minBpm !== null && maxBpm !== null && minBpm > maxBpm) {
    [minBpm, maxBpm] = [maxBpm, minBpm];
  }
  return { artists, genres, keywords, fromYear, toYear, minBpm, maxBpm };
}

function hasAnyCriteria(criteria: NormalizedCriteria): boolean {
  return (
    criteria.artists.length > 0 ||
    criteria.genres.length > 0 ||
    criteria.keywords.length > 0 ||
    criteria.fromYear !== null ||
    criteria.toYear !== null ||
    criteria.minBpm !== null ||
    criteria.maxBpm !== null
  );
}

function parseAiCuratedCriteria(rawText: string): AiCuratedCriteria | null {
  const obj = parseJsonObject(rawText);
  if (!obj) return null;

  const recognizedKeys = [
    'artists',
    'genres',
    'keywords',
    'moods',
    'fromYear',
    'toYear',
    'minBpm',
    'maxBpm',
  ];
  const hasRecognizedKey = recognizedKeys.some((key) => key in obj);
  if (!hasRecognizedKey) return null;

  const mergedKeywords = normalizeStringList(
    [
      ...normalizeStringList(obj.keywords, MAX_CRITERIA_KEYWORDS),
      ...normalizeStringList(obj.moods, MAX_CRITERIA_KEYWORDS),
    ],
    MAX_CRITERIA_KEYWORDS,
  );

  return normalizeCriteria({
    artists: normalizeStringList(obj.artists, MAX_CRITERIA_ARTISTS),
    genres: normalizeStringList(obj.genres, MAX_CRITERIA_GENRES),
    fromYear: normalizeYear(obj.fromYear),
    toYear: normalizeYear(obj.toYear),
    keywords: mergedKeywords,
    minBpm: normalizeBpm(obj.minBpm),
    maxBpm: normalizeBpm(obj.maxBpm),
  });
}

/* ------------------------------------------------------------------ */
/*  SQL query builders & candidate scoring                             */
/* ------------------------------------------------------------------ */

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function likePattern(term: string): string {
  return `%${escapeLike(term.toLowerCase())}%`;
}

function buildArtistCondition(artist: string): SqlFragment {
  const pat = likePattern(artist);
  return {
    sql:
      "(LOWER(COALESCE(s.artist, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.display_artist, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.display_album_artist, '')) LIKE ? ESCAPE '\\' " +
      "OR EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = s.id AND LOWER(COALESCE(sa.artist_name, '')) LIKE ? ESCAPE '\\'))",
    params: [pat, pat, pat, pat],
  };
}

function buildGenreCondition(genre: string): SqlFragment {
  const pat = likePattern(genre);
  return {
    sql:
      "(LOWER(COALESCE(s.genre, '')) LIKE ? ESCAPE '\\' " +
      "OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(sg.name) LIKE ? ESCAPE '\\'))",
    params: [pat, pat],
  };
}

function buildKeywordCondition(keyword: string, metadataOnly = false): SqlFragment {
  const pat = likePattern(keyword);
  if (metadataOnly) {
    return {
      sql:
        "(LOWER(COALESCE(s.artist, '')) LIKE ? ESCAPE '\\' " +
        "OR LOWER(COALESCE(s.genre, '')) LIKE ? ESCAPE '\\' " +
        "OR LOWER(COALESCE(s.comment, '')) LIKE ? ESCAPE '\\' " +
        "OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(sg.name) LIKE ? ESCAPE '\\') " +
        "OR EXISTS (SELECT 1 FROM song_moods sm WHERE sm.song_id = s.id AND LOWER(sm.mood) LIKE ? ESCAPE '\\'))",
      params: [pat, pat, pat, pat, pat],
    };
  }
  return {
    sql:
      "(LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.album, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.artist, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.genre, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(s.comment, '')) LIKE ? ESCAPE '\\' " +
      "OR EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id AND LOWER(sg.name) LIKE ? ESCAPE '\\') " +
      "OR EXISTS (SELECT 1 FROM song_moods sm WHERE sm.song_id = s.id AND LOWER(sm.mood) LIKE ? ESCAPE '\\'))",
    params: [pat, pat, pat, pat, pat, pat, pat],
  };
}

function buildYearCondition(fromYear: number | null, toYear: number | null): SqlFragment | null {
  if (fromYear === null && toYear === null) return null;
  const parts: string[] = ['s.year IS NOT NULL'];
  const params: number[] = [];
  if (fromYear !== null) {
    parts.push('s.year >= ?');
    params.push(fromYear);
  }
  if (toYear !== null) {
    parts.push('s.year <= ?');
    params.push(toYear);
  }
  return { sql: `(${parts.join(' AND ')})`, params };
}

function buildBpmCondition(minBpm: number | null, maxBpm: number | null): SqlFragment | null {
  if (minBpm === null && maxBpm === null) return null;
  const parts: string[] = ['s.bpm IS NOT NULL', 's.bpm > 0'];
  const params: number[] = [];
  if (minBpm !== null) {
    parts.push('s.bpm >= ?');
    params.push(minBpm);
  }
  if (maxBpm !== null) {
    parts.push('s.bpm <= ?');
    params.push(maxBpm);
  }
  return { sql: `(${parts.join(' AND ')})`, params };
}

function bestMatchWeight(
  targets: string[],
  candidates: string[],
  exactWeight: number,
  partialWeight: number,
): number {
  if (targets.length === 0 || candidates.length === 0) return 0;
  let total = 0;
  for (const target of targets) {
    const t = target.toLowerCase();
    let best = 0;
    for (const candidate of candidates) {
      const c = candidate.toLowerCase();
      if (c === t) {
        best = exactWeight;
        break;
      }
      if (c.includes(t) || t.includes(c)) {
        best = Math.max(best, partialWeight);
      }
    }
    total += best;
  }
  return total;
}

function scoreSongRow(
  row: SongListRow,
  criteria: NormalizedCriteria,
  metadataKeywordsOnly = false,
): number {
  let score = 0;

  const artistFields = [
    row.artist,
    row.display_artist,
    row.display_album_artist,
    ...(row.artists?.map((a) => a.name) ?? []),
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  score += bestMatchWeight(criteria.artists, artistFields, 45, 30);

  const genreFields = [
    row.genre,
    ...(row.genres ?? []),
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  score += bestMatchWeight(criteria.genres, genreFields, 35, 20);

  if (criteria.keywords.length > 0) {
    const moodAndGenreFields = [
      ...(row.moods ?? []),
      ...genreFields,
    ];
    const textFields = metadataKeywordsOnly
      ? [row.artist, row.comment].filter(
          (v): v is string => typeof v === 'string' && v.trim().length > 0,
        )
      : [row.title, row.album, row.artist, row.comment].filter(
          (v): v is string => typeof v === 'string' && v.trim().length > 0,
        );

    for (const keyword of criteria.keywords) {
      const k = keyword.toLowerCase();
      let best = 0;
      for (const mg of moodAndGenreFields) {
        const val = mg.toLowerCase();
        if (val === k) {
          best = 25;
          break;
        }
        if (val.includes(k)) {
          best = Math.max(best, 18);
        }
      }
      if (best < 15) {
        for (const tf of textFields) {
          if (tf.toLowerCase().includes(k)) {
            best = Math.max(best, 15);
            break;
          }
        }
      }
      score += best;
    }
  }

  if (criteria.fromYear !== null || criteria.toYear !== null) {
    if (
      row.year != null &&
      row.year > 0 &&
      (criteria.fromYear === null || row.year >= criteria.fromYear) &&
      (criteria.toYear === null || row.year <= criteria.toYear)
    ) {
      score += 30;
    }
  }

  if (criteria.minBpm !== null || criteria.maxBpm !== null) {
    if (
      row.bpm != null &&
      row.bpm > 0 &&
      (criteria.minBpm === null || row.bpm >= criteria.minBpm) &&
      (criteria.maxBpm === null || row.bpm <= criteria.maxBpm)
    ) {
      score += 30;
    }
  }

  if (row.starred != null) score += 3;
  score += Math.min(row.play_count ?? 0, 20) * 0.2;
  if ((row.user_rating ?? 0) >= 4) score += 1;

  return score;
}

/* ------------------------------------------------------------------ */
/*  Local fallbacks (offline / disabled / timeout / empty AI)          */
/* ------------------------------------------------------------------ */

function extractPromptTokens(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !PROMPT_STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 8);
}

async function queryLocalFallbackSongs(prompt: string, limit: number): Promise<Child[]> {
  const db = getDb();
  if (!db || limit <= 0) return [];

  const restrictToCached = offlineModeStore.getState().offlineMode;
  const baseClauses = ['COALESCE(s.is_dir, 0) = 0', 'COALESCE(s.is_video, 0) = 0'];
  if (restrictToCached) {
    baseClauses.push('s.id IN (SELECT song_id FROM cached_songs)');
  }
  const baseWhere = baseClauses.join(' AND ');

  try {
    const tokens = extractPromptTokens(prompt);
    const collected: SongListRow[] = [];
    const seen = new Set<string>();

    if (tokens.length > 0) {
      const keywordConds = tokens.map((token) => buildKeywordCondition(token));
      const tokenWhere = keywordConds.map((c) => c.sql).join(' OR ');
      const tokenParams = keywordConds.flatMap((c) => c.params);
      const scoreExpr = keywordConds
        .map((c) => `CASE WHEN ${c.sql} THEN 20 ELSE 0 END`)
        .join(' + ');

      const matched = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S} FROM songs s ` +
          `WHERE ${baseWhere} AND (${tokenWhere}) ` +
          `ORDER BY (${scoreExpr}) DESC, (CASE WHEN s.starred IS NOT NULL THEN 1 ELSE 0 END) DESC, COALESCE(s.play_count, 0) DESC, s.id ASC ` +
          'LIMIT ?',
        [...tokenParams, ...tokenParams, limit],
      );
      for (const row of matched) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          collected.push(row);
        }
      }
    }

    if (collected.length < limit) {
      const remaining = limit - collected.length;
      const params: (string | number)[] = [];
      let excludeSql = '';
      if (seen.size > 0) {
        excludeSql = ' AND s.id NOT IN (SELECT value FROM json_each(?))';
        params.push(JSON.stringify([...seen]));
      }
      params.push(remaining);

      const extras = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S} FROM songs s ` +
          `WHERE ${baseWhere}${excludeSql} ` +
          'ORDER BY (CASE WHEN s.starred IS NOT NULL THEN 1 ELSE 0 END) DESC, COALESCE(s.play_count, 0) DESC, RANDOM() ' +
          'LIMIT ?',
        params,
      );
      for (const row of extras) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          collected.push(row);
        }
      }
    }

    await hydrateSongRows(db, collected);
    return collected.slice(0, limit).map(songListRowToChild);
  } catch {
    return [];
  }
}

async function runFallbackPlaylist(
  prompt: string,
  targetCount: number,
  fallbackFn?: () => Promise<Child[]>,
): Promise<Child[]> {
  if (fallbackFn) {
    try {
      const fallbackSongs = await fallbackFn();
      if (Array.isArray(fallbackSongs) && fallbackSongs.length > 0) {
        return deduplicateChildren(fallbackSongs, targetCount);
      }
    } catch {
      // Caller fallback failed; fall through to local intelligence / smart radio fallbacks.
    }
  }

  const localMatches = await queryLocalFallbackSongs(prompt, targetCount);
  if (localMatches.length >= targetCount) {
    return localMatches;
  }

  const combined: Child[] = [...localMatches];

  // Degrade gracefully to LocalIntelligenceService (daylist) if still below target.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getHourlyDaylist } = require('./localIntelligenceService') as {
      getHourlyDaylist?: (limit?: number) => Promise<{ songs: Child[] }>;
    };
    if (typeof getHourlyDaylist === 'function') {
      const daylist = await getHourlyDaylist(targetCount);
      if (Array.isArray(daylist?.songs) && daylist.songs.length > 0) {
        combined.push(...daylist.songs);
      }
    }
  } catch {
    // Ignore fallback errors
  }

  // If we have at least one seed and still need more tracks, expand via SmartRadioService.
  if (combined.length > 0 && deduplicateChildren(combined, targetCount).length < targetCount) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getSmartRadioTracks } = require('./smartRadioService') as {
        getSmartRadioTracks?: (req: {
          seedSongs: Child[];
          targetCount: number;
          excludeIds?: Set<string>;
          downloadedOnly?: boolean;
        }) => Promise<Child[]>;
      };
      if (typeof getSmartRadioTracks === 'function') {
        const excludeIds = new Set(combined.map((s) => s.id).filter(Boolean));
        const radioTracks = await getSmartRadioTracks({
          seedSongs: combined.slice(0, 3),
          targetCount: targetCount - excludeIds.size,
          excludeIds,
          downloadedOnly: offlineModeStore.getState().offlineMode,
        });
        if (Array.isArray(radioTracks) && radioTracks.length > 0) {
          combined.push(...radioTracks);
        }
      }
    } catch {
      // Ignore fallback errors
    }
  }

  return deduplicateChildren(combined, targetCount);
}

function deduplicateChildren(songs: Child[], limit: number): Child[] {
  const seen = new Set<string>();
  const out: Child[] = [];
  for (const song of songs) {
    if (!song || !song.id || seen.has(song.id)) continue;
    seen.add(song.id);
    out.push(song);
    if (out.length >= limit) break;
  }
  return out;
}

async function countLibrarySongs(db: InternalDb, restrictToCached: boolean): Promise<number> {
  const sql = restrictToCached
    ? 'SELECT COUNT(*) AS n FROM songs s WHERE s.id IN (SELECT song_id FROM cached_songs)'
    : 'SELECT COUNT(*) AS n FROM songs';
  const row = await db.getFirstAsync<{ n: number }>(sql);
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

function buildPlaylistPrompts(
  userPrompt: string,
  targetCount: number,
  catalog: CompactLibraryCatalog,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    'You are a music curation assistant. Given a playlist request and a compact summary of the ' +
    'available library catalog, return ONLY a valid JSON object matching this schema:\n' +
    '{"artists": string[], "genres": string[], "fromYear": number|null, "toYear": number|null, ' +
    '"keywords": string[], "minBpm": number|null, "maxBpm": number|null}\n' +
    'Prefer exact artist names, genre names, and mood words from the catalog when relevant. ' +
    'Put moods or descriptive themes in "keywords". Use null when year or BPM bounds are not implied. ' +
    'Respond ONLY with raw JSON.';

  const clippedPrompt = userPrompt.slice(0, MAX_PROMPT_LENGTH);
  const userMessage =
    `Playlist request: ${clippedPrompt}\n` +
    `Target track count: ${targetCount}\n` +
    `Library catalog: ${JSON.stringify(catalog)}`;

  return { systemPrompt, userMessage };
}

function buildRadioBoostPrompts(
  seedSongs: Child[],
  targetCount: number,
  catalog: CompactLibraryCatalog,
): { systemPrompt: string; userMessage: string } {
  const compactSeeds = seedSongs.slice(0, MAX_SEED_SONGS).map((song) => {
    const entry: Record<string, string | number | string[]> = {};
    if (song.title) entry.title = song.title;
    if (song.artist) entry.artist = song.artist;
    if (song.album) entry.album = song.album;
    const genre = song.genre ?? song.genres?.[0];
    if (genre) entry.genre = genre;
    if (Array.isArray(song.moods) && song.moods.length > 0) {
      entry.moods = song.moods.slice(0, 4);
    }
    if (song.year) entry.year = song.year;
    if (song.bpm) entry.bpm = song.bpm;
    return entry;
  });

  const systemPrompt =
    'You are a smart radio DJ assistant. Given seed tracks and a compact library catalog, ' +
    'return ONLY a valid JSON object of matching criteria for adjacent, cohesive radio tracks ' +
    'sharing the exact sonic mood, energy/tempo, vocal feel, and sub-genre of the seed track(s):\n' +
    '{"artists": string[], "genres": string[], "fromYear": number|null, "toYear": number|null, ' +
    '"keywords": string[], "minBpm": number|null, "maxBpm": number|null}\n' +
    'CRITICAL RULES:\n' +
    '- Stay strictly true to the mood and genre of the seed tracks. Include the seed artist plus sonically similar artists.\n' +
    '- Only pick artists/genres from the library catalog if they genuinely match the seed mood/style; NEVER pad with unrelated popular catalog artists.\n' +
    '- Only put concise mood/subgenre tags in "keywords" (avoid song-title words or vague words like "song", "love", "night").\n' +
    'Respond ONLY with raw JSON.';

  const userMessage =
    `Seed tracks: ${JSON.stringify(compactSeeds)}\n` +
    `Target track count: ${targetCount}\n` +
    `Library catalog: ${JSON.stringify(catalog)}`;

  return { systemPrompt, userMessage };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Summarize library metadata (top 40 genres, top 60 artists, top 20 moods,
 * year span) without ever reading or dumping individual song rows.
 */
export async function buildCompactLibraryCatalog(): Promise<CompactLibraryCatalog> {
  const empty: CompactLibraryCatalog = {
    genres: [],
    topArtists: [],
    moods: [],
    minYear: null,
    maxYear: null,
  };

  const db = getDb();
  if (!db) return empty;

  try {
    const [genreRows, artistRows, moodRows, yearRow] = await Promise.all([
      db.getAllAsync<{ name: string }>(
        'SELECT MIN(name) AS name, COUNT(*) AS cnt FROM (' +
          "SELECT TRIM(name) AS name FROM song_genres WHERE name IS NOT NULL AND TRIM(name) != '' " +
          'UNION ALL ' +
          "SELECT TRIM(genre) AS name FROM songs WHERE genre IS NOT NULL AND TRIM(genre) != '' " +
          'AND NOT EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = songs.id)' +
          ') GROUP BY LOWER(name) ORDER BY cnt DESC, name ASC LIMIT ?',
        [CATALOG_GENRE_LIMIT],
      ),
      db.getAllAsync<{ artist_name: string }>(
        'SELECT MIN(COALESCE(NULLIF(TRIM(artist), \'\'), TRIM(display_artist))) AS artist_name, ' +
          'COUNT(*) AS song_count, ' +
          'COALESCE(SUM(COALESCE(play_count, 0)), 0) AS total_plays ' +
          'FROM songs ' +
          "WHERE COALESCE(NULLIF(TRIM(artist), ''), TRIM(display_artist)) IS NOT NULL " +
          "AND COALESCE(NULLIF(TRIM(artist), ''), TRIM(display_artist)) != '' " +
          "GROUP BY LOWER(COALESCE(NULLIF(TRIM(artist), ''), TRIM(display_artist))) " +
          'ORDER BY (COUNT(*) + COALESCE(SUM(COALESCE(play_count, 0)), 0)) DESC, COUNT(*) DESC, artist_name ASC ' +
          'LIMIT ?',
        [CATALOG_ARTIST_LIMIT],
      ),
      db.getAllAsync<{ mood: string }>(
        'SELECT MIN(TRIM(mood)) AS mood, COUNT(*) AS cnt FROM song_moods ' +
          "WHERE mood IS NOT NULL AND TRIM(mood) != '' " +
          'GROUP BY LOWER(TRIM(mood)) ORDER BY cnt DESC, mood ASC LIMIT ?',
        [CATALOG_MOOD_LIMIT],
      ),
      db.getFirstAsync<{ min_year: number | null; max_year: number | null }>(
        'SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM songs WHERE year IS NOT NULL AND year > 0',
      ),
    ]);

    return {
      genres: genreRows.map((r) => r.name).filter((n) => n.length > 0),
      topArtists: artistRows.map((r) => r.artist_name).filter((n) => n.length > 0),
      moods: moodRows.map((r) => r.mood).filter((m) => m.length > 0),
      minYear: yearRow?.min_year ?? null,
      maxYear: yearRow?.max_year ?? null,
    };
  } catch {
    return empty;
  }
}

/**
 * Validate provider settings and verify connectivity with a minimal JSON ping
 * under a strict 5000 ms timeout.
 */
export async function testConnection(
  override?: Partial<RadioAiSettingsSnapshot>,
): Promise<AiConnectionTestResult> {
  const resolved = await resolveAiSettings(override);
  const validation = validateAiSettings(resolved);
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  if (offlineModeStore.getState().offlineMode) {
    return {
      ok: false,
      message: 'Offline mode is enabled. Disable offline mode to test the AI connection.',
    };
  }

  const callResult = await callAiProvider(
    validation.settings,
    'You are a connectivity probe. Respond only with valid JSON: {"status":"ok"}',
    'Respond only with {"status":"ok"}',
    true,
  );

  if (!callResult.ok) {
    return { ok: false, message: callResult.message };
  }

  const parsed = parseJsonObject(callResult.text);
  if (!parsed) {
    return {
      ok: false,
      message: 'Provider did not return valid JSON for the connectivity test.',
    };
  }

  return {
    ok: true,
    message: `Connected (${callResult.latencyMs} ms)`,
    latencyMs: callResult.latencyMs,
  };
}

export interface AiCriteriaQueryOptions {
  skipRangeTopUp?: boolean;
  metadataKeywordsOnly?: boolean;
}

/**
 * Translate structured AI criteria into parameterized SQLite queries over `songs`
 * (and `song_genres` / `song_moods`), score candidates by matched criteria,
 * hydrate rows via `hydrateSongRows`, and return deduplicated `Child[]`.
 */
export async function querySongsByAiCriteria(
  criteria: AiCuratedCriteria,
  limit: number,
  excludeIds?: Set<string>,
  downloadedOnly?: boolean,
  options?: AiCriteriaQueryOptions,
): Promise<Child[]> {
  const db = getDb();
  if (!db) return [];

  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const norm = normalizeCriteria(criteria);
  if (!hasAnyCriteria(norm)) return [];

  const restrictToCached = Boolean(downloadedOnly) || offlineModeStore.getState().offlineMode;
  const candidateCap = Math.min(Math.max(safeLimit * 6, 100), 300);

  try {
    const baseClauses = ['COALESCE(s.is_dir, 0) = 0', 'COALESCE(s.is_video, 0) = 0'];
    const baseParams: (string | number)[] = [];

    if (restrictToCached) {
      baseClauses.push('s.id IN (SELECT song_id FROM cached_songs)');
    }
    if (excludeIds && excludeIds.size > 0) {
      baseClauses.push('s.id NOT IN (SELECT value FROM json_each(?))');
      baseParams.push(JSON.stringify([...excludeIds]));
    }
    const baseWhere = baseClauses.join(' AND ');

    const weightedClauses: Array<{ frag: SqlFragment; weight: number }> = [];
    const semanticFrags: SqlFragment[] = [];

    for (const artist of norm.artists) {
      const frag = buildArtistCondition(artist);
      semanticFrags.push(frag);
      weightedClauses.push({ frag, weight: 40 });
    }
    for (const genre of norm.genres) {
      const frag = buildGenreCondition(genre);
      semanticFrags.push(frag);
      weightedClauses.push({ frag, weight: 30 });
    }
    for (const keyword of norm.keywords) {
      const frag = buildKeywordCondition(keyword, options?.metadataKeywordsOnly);
      semanticFrags.push(frag);
      weightedClauses.push({ frag, weight: 20 });
    }

    const yearFrag = buildYearCondition(norm.fromYear, norm.toYear);
    if (yearFrag) weightedClauses.push({ frag: yearFrag, weight: 25 });

    const bpmFrag = buildBpmCondition(norm.minBpm, norm.maxBpm);
    if (bpmFrag) weightedClauses.push({ frag: bpmFrag, weight: 25 });

    const scoreParts = weightedClauses.map(
      ({ frag, weight }) => `CASE WHEN ${frag.sql} THEN ${weight} ELSE 0 END`,
    );
    scoreParts.push('CASE WHEN s.starred IS NOT NULL THEN 4 ELSE 0 END');
    const scoreSql = scoreParts.join(' + ');
    const scoreParams = weightedClauses.flatMap((w) => w.frag.params);

    const rangeFrags = [yearFrag, bpmFrag].filter((f): f is SqlFragment => f !== null);
    const primaryFrags = semanticFrags.length > 0 ? semanticFrags : rangeFrags;
    const primaryWhere = primaryFrags.map((f) => f.sql).join(' OR ');
    const primaryParams = primaryFrags.flatMap((f) => f.params);

    const primaryRows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S} FROM songs s ` +
        `WHERE ${baseWhere} AND (${primaryWhere}) ` +
        `ORDER BY (${scoreSql}) DESC, COALESCE(s.play_count, 0) DESC, s.id ASC ` +
        'LIMIT ?',
      [...baseParams, ...primaryParams, ...scoreParams, candidateCap],
    );

    const candidateRows: SongListRow[] = [];
    const seen = new Set<string>(excludeIds ?? []);

    for (const row of primaryRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      candidateRows.push(row);
    }

    // If semantic filters were too sparse and year/BPM bounds were also supplied,
    // top up candidates matching the range criteria unless strict mood mode (`skipRangeTopUp`) is requested.
    if (
      !options?.skipRangeTopUp &&
      semanticFrags.length > 0 &&
      rangeFrags.length > 0 &&
      candidateRows.length < safeLimit
    ) {
      const rangeWhere = rangeFrags.map((f) => f.sql).join(' OR ');
      const rangeParams = rangeFrags.flatMap((f) => f.params);
      const topUpRows = await db.getAllAsync<SongListRow>(
        `SELECT ${SONG_LIST_COLS_S} FROM songs s ` +
          `WHERE ${baseWhere} AND (${rangeWhere}) ` +
          `ORDER BY (${scoreSql}) DESC, COALESCE(s.play_count, 0) DESC, s.id ASC ` +
          'LIMIT ?',
        [...baseParams, ...rangeParams, ...scoreParams, candidateCap],
      );
      for (const row of topUpRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        candidateRows.push(row);
      }
    }

    if (candidateRows.length === 0) return [];

    await hydrateSongRows(db, candidateRows);

    const scored = candidateRows
      .map((row) => ({
        row,
        score: scoreSongRow(row, norm, Boolean(options?.metadataKeywordsOnly)),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const playDiff = (b.row.play_count ?? 0) - (a.row.play_count ?? 0);
        if (playDiff !== 0) return playDiff;
        return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
      });

    return scored.slice(0, safeLimit).map((entry) => songListRowToChild(entry.row));
  } catch {
    return [];
  }
}

/**
 * Generate a playlist from a natural-language prompt using the configured BYOK AI
 * provider, degrading silently to `fallbackFn` or local SQLite queries on any
 * error, timeout, offline state, disabled provider, or empty/sparse result.
 */
export async function generatePlaylistFromPrompt(
  prompt: string,
  targetCount = 25,
  fallbackFn?: () => Promise<Child[]>,
): Promise<Child[]> {
  const safeTarget = Math.max(1, Math.min(Math.floor(targetCount) || 25, 200));
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt || offlineModeStore.getState().offlineMode) {
    return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
  }

  const resolved = await resolveAiSettings();
  const validation = validateAiSettings(resolved);
  if (!validation.ok) {
    return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
  }

  try {
    const catalog = await buildCompactLibraryCatalog();
    const { systemPrompt, userMessage } = buildPlaylistPrompts(
      trimmedPrompt,
      safeTarget,
      catalog,
    );
    const callResult = await callAiProvider(validation.settings, systemPrompt, userMessage, false);
    if (!callResult.ok) {
      return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
    }

    const criteria = parseAiCuratedCriteria(callResult.text);
    if (!criteria) {
      return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
    }

    const aiSongs = await querySongsByAiCriteria(criteria, safeTarget);
    if (aiSongs.length === 0) {
      return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
    }

    if (aiSongs.length < Math.min(safeTarget, SPARSE_RESULT_FLOOR)) {
      const db = getDb();
      const totalLibrarySongs = db
        ? await countLibrarySongs(db, offlineModeStore.getState().offlineMode).catch(() => 0)
        : 0;
      if (fallbackFn || totalLibrarySongs >= 10) {
        const supplement = await runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
        return deduplicateChildren([...aiSongs, ...supplement], safeTarget);
      }
    }

    return deduplicateChildren(aiSongs, safeTarget);
  } catch {
    return runFallbackPlaylist(trimmedPrompt, safeTarget, fallbackFn);
  }
}

async function hydrateSeedsForPrompt(seedSongs: Child[]): Promise<Child[]> {
  const db = getDb();
  if (!db || seedSongs.length === 0) return seedSongs;
  const ids = Array.from(new Set(seedSongs.map((s) => s?.id).filter(Boolean)));
  if (ids.length === 0) return seedSongs;

  try {
    const marks = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS_S} FROM songs s WHERE s.id IN (${marks})`,
      ids,
    );
    if (!rows || rows.length === 0) return seedSongs;
    await hydrateSongRows(db, rows);
    const byId = new Map<string, Child>();
    for (const r of rows) {
      const child = songListRowToChild(r) as Child;
      if (child.id) byId.set(child.id, child);
    }
    return seedSongs.map((s) => {
      const dbChild = s.id ? byId.get(s.id) : undefined;
      if (!dbChild) return s;
      return {
        ...dbChild,
        ...s,
        genre: s.genre ?? dbChild.genre,
        genres: s.genres?.length ? s.genres : dbChild.genres,
        moods: s.moods?.length ? s.moods : dbChild.moods,
        year: s.year ?? dbChild.year,
        bpm: s.bpm ?? dbChild.bpm,
        album: s.album ?? dbChild.album,
        artistId: s.artistId ?? dbChild.artistId,
      };
    });
  } catch {
    return seedSongs;
  }
}

/**
 * Request complementary radio candidate tracks from the configured BYOK AI provider
 * using compact metadata of the seed tracks plus the library catalog.
 * Returns `[]` silently on any error, timeout, disabled provider, or offline state.
 */
export async function boostRadioCandidates(
  seedSongs: Child[],
  targetCount = 15,
  excludeIds?: Set<string>,
): Promise<Child[]> {
  if (!Array.isArray(seedSongs) || seedSongs.length === 0) return [];
  const safeTarget = Math.max(1, Math.min(Math.floor(targetCount) || 15, 100));

  if (offlineModeStore.getState().offlineMode) return [];

  const resolved = await resolveAiSettings();
  const validation = validateAiSettings(resolved);
  if (!validation.ok) return [];

  try {
    const [catalog, enrichedSeeds] = await Promise.all([
      buildCompactLibraryCatalog(),
      hydrateSeedsForPrompt(seedSongs),
    ]);
    const { systemPrompt, userMessage } = buildRadioBoostPrompts(
      enrichedSeeds,
      safeTarget,
      catalog,
    );
    const callResult = await callAiProvider(validation.settings, systemPrompt, userMessage, false);
    if (!callResult.ok) return [];

    const criteria = parseAiCuratedCriteria(callResult.text);
    if (!criteria) return [];

    const effectiveExcludeIds = new Set<string>(excludeIds ?? []);
    for (const seed of seedSongs) {
      if (seed.id) effectiveExcludeIds.add(seed.id);
    }

    return await querySongsByAiCriteria(criteria, safeTarget, effectiveExcludeIds, undefined, {
      skipRangeTopUp: true,
      metadataKeywordsOnly: true,
    });
  } catch {
    return [];
  }
}
