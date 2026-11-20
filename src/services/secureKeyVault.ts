/**
 * Encrypted local key vault for sensitive user credentials (e.g. BYOK AI API keys).
 *
 * Keeps secrets out of Zustand's plain JSON KV persistence (`storage` table) and logs,
 * without adding extra native dependencies requiring an Android rebuild.
 * Uses a per-install 256-bit key stored in app-private document storage and encrypts
 * payloads with a random 16-byte IV + SHA-256 CTR keystream via `expo-crypto`.
 */
import * as ExpoCrypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

const KEY_FILE_NAME = '.atrum_sec_k';
const VAULT_FILE_NAME = '.atrum_sec_v';
const ENVELOPE_PREFIX = 'enc:v1:';
const KNOWN_SCOPES = ['gemini', 'groq', 'openai', 'custom'] as const;

let cachedKeyHex: string | null = null;
const memoryCiphertextByScope = new Map<string, string>();

function normalizeVaultScope(provider?: string): string {
  const clean = (provider ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean || clean === 'disabled') return '';
  return clean;
}

function getVaultFileName(scope: string): string {
  return scope ? `${VAULT_FILE_NAME}_${scope}` : VAULT_FILE_NAME;
}

function getMemorySlot(scope: string): string {
  return scope || '__legacy__';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const len = Math.floor(hex.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function utf8ToBytes(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const encoded = unescape(encodeURIComponent(str));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    out[i] = encoded.charCodeAt(i);
  }
  return out;
}

function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  let raw = '';
  for (let i = 0; i < bytes.length; i++) {
    raw += String.fromCharCode(bytes[i]);
  }
  return decodeURIComponent(escape(raw));
}

function generateRandomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  try {
    ExpoCrypto.getRandomValues(buf);
  } catch {
    for (let i = 0; i < byteCount; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(buf);
}

async function getOrCreateVaultKey(): Promise<string> {
  if (cachedKeyHex) return cachedKeyHex;
  try {
    const keyFile = new File(Paths.document, KEY_FILE_NAME);
    if (keyFile.exists) {
      const stored = (await keyFile.text()).trim();
      if (/^[0-9a-f]{64}$/i.test(stored)) {
        cachedKeyHex = stored;
        return stored;
      }
    }
    const freshKey = generateRandomHex(32);
    keyFile.write(freshKey);
    cachedKeyHex = freshKey;
    return freshKey;
  } catch {
    cachedKeyHex = generateRandomHex(32);
    return cachedKeyHex;
  }
}

async function deriveKeystream(
  keyHex: string,
  ivHex: string,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    // eslint-disable-next-line no-await-in-loop
    const blockHex = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      `${keyHex}:${ivHex}:${counter}`,
      { encoding: ExpoCrypto.CryptoEncoding.HEX },
    );
    const blockBytes = hexToBytes(blockHex);
    const take = Math.min(blockBytes.length, length - offset);
    out.set(blockBytes.subarray(0, take), offset);
    offset += take;
    counter += 1;
  }
  return out;
}

async function encryptSecret(plaintext: string): Promise<string> {
  const keyHex = await getOrCreateVaultKey();
  const ivHex = generateRandomHex(16);
  const plainBytes = utf8ToBytes(plaintext);
  const stream = await deriveKeystream(keyHex, ivHex, plainBytes.length);
  const cipherBytes = new Uint8Array(plainBytes.length);
  for (let i = 0; i < plainBytes.length; i++) {
    cipherBytes[i] = plainBytes[i] ^ stream[i];
  }
  return `${ENVELOPE_PREFIX}${ivHex}:${bytesToHex(cipherBytes)}`;
}

async function decryptSecret(envelope: string): Promise<string> {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return '';
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const sep = body.indexOf(':');
  if (sep <= 0) return '';
  const ivHex = body.slice(0, sep);
  const cipherHex = body.slice(sep + 1);
  if (!ivHex) return '';
  if (!cipherHex) return '';
  const keyHex = await getOrCreateVaultKey();
  const cipherBytes = hexToBytes(cipherHex);
  const stream = await deriveKeystream(keyHex, ivHex, cipherBytes.length);
  const plainBytes = new Uint8Array(cipherBytes.length);
  for (let i = 0; i < cipherBytes.length; i++) {
    plainBytes[i] = cipherBytes[i] ^ stream[i];
  }
  return bytesToUtf8(plainBytes);
}

async function readEnvelopeFromFile(fileName: string): Promise<string> {
  try {
    const vaultFile = new File(Paths.document, fileName);
    if (vaultFile.exists) {
      const raw = (await vaultFile.text()).trim();
      if (raw.startsWith(ENVELOPE_PREFIX)) {
        return raw;
      }
    }
  } catch {
    /* ignore unreadable file */
  }
  return '';
}

function writeEnvelopeToFile(fileName: string, encrypted: string): void {
  try {
    const vaultFile = new File(Paths.document, fileName);
    vaultFile.write(encrypted);
  } catch {
    /* fallback stays in memoryCiphertextByScope */
  }
}

function deleteVaultFile(fileName: string): void {
  try {
    const vaultFile = new File(Paths.document, fileName);
    if (vaultFile.exists) {
      vaultFile.delete();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Persist an API key encrypted inside the app-private vault file, scoped per provider.
 * Passing an empty string removes the stored secret for that provider (or all if omitted).
 */
export async function saveApiKeySecret(apiKey: string, provider?: string): Promise<void> {
  const scope = normalizeVaultScope(provider);
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearApiKeySecret(provider);
    return;
  }
  const encrypted = await encryptSecret(trimmed);
  memoryCiphertextByScope.set(getMemorySlot(scope), encrypted);
  writeEnvelopeToFile(getVaultFileName(scope), encrypted);
}

/** Load and decrypt the stored API key for `provider`, or return `''` if absent/unreadable. */
export async function loadApiKeySecret(provider?: string): Promise<string> {
  const scope = normalizeVaultScope(provider);
  const slot = getMemorySlot(scope);
  const fileName = getVaultFileName(scope);

  const fileEnvelope = await readEnvelopeFromFile(fileName);
  if (fileEnvelope) {
    memoryCiphertextByScope.set(slot, fileEnvelope);
    try {
      return await decryptSecret(fileEnvelope);
    } catch {
      return '';
    }
  }

  const memEnvelope = memoryCiphertextByScope.get(slot);
  if (memEnvelope) {
    try {
      return await decryptSecret(memEnvelope);
    } catch {
      return '';
    }
  }

  // One-time migration from pre-scoped legacy single vault file: claim it for the
  // currently active provider so it is never leaked to other providers later.
  if (scope) {
    const legacyEnvelope =
      (await readEnvelopeFromFile(VAULT_FILE_NAME)) ||
      memoryCiphertextByScope.get('__legacy__') ||
      '';
    if (legacyEnvelope) {
      try {
        const legacyPlain = await decryptSecret(legacyEnvelope);
        memoryCiphertextByScope.delete('__legacy__');
        deleteVaultFile(VAULT_FILE_NAME);
        if (legacyPlain.trim()) {
          await saveApiKeySecret(legacyPlain, scope);
          return legacyPlain;
        }
      } catch {
        return '';
      }
    }
  }

  return '';
}

/**
 * Delete persisted secret(s) from disk and memory.
 * When `provider` is omitted, removes both legacy and all per-provider secrets.
 */
export async function clearApiKeySecret(provider?: string): Promise<void> {
  const scope = normalizeVaultScope(provider);
  if (scope) {
    memoryCiphertextByScope.delete(getMemorySlot(scope));
    deleteVaultFile(getVaultFileName(scope));
    return;
  }

  memoryCiphertextByScope.clear();
  deleteVaultFile(VAULT_FILE_NAME);
  for (const knownScope of KNOWN_SCOPES) {
    deleteVaultFile(getVaultFileName(knownScope));
  }
}
