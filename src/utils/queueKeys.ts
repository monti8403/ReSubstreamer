let _queueKeySeq = 0;
const _fallbackQueueKeys = new WeakMap<object, string>();

interface KeyedItem {
  id?: string;
  _queueKey?: string;
}

/**
 * Return a stable per-entry key for a queue item object.
 * Preserves an existing `_queueKey` when present; otherwise lazily assigns and
 * remembers a monotonic key in a WeakMap so frozen/immutable objects work safely.
 */
export function ensureQueueKey(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const obj = item as KeyedItem;
  if (typeof obj._queueKey === 'string' && obj._queueKey.length > 0) {
    return obj._queueKey;
  }
  const existing = _fallbackQueueKeys.get(obj);
  if (existing) return existing;
  const key = `${obj.id ?? 'track'}_${++_queueKeySeq}`;
  _fallbackQueueKeys.set(obj, key);
  return key;
}

/** Clone an item with a guaranteed-fresh unique `_queueKey`. */
export function cloneWithFreshQueueKey<T extends KeyedItem>(item: T): T {
  const newKey = `${item.id ?? 'track'}_${++_queueKeySeq}`;
  return { ...item, _queueKey: newKey };
}

/**
 * Ensure every element in `queue` has a distinct object identity and unique
 * queue key. Returns the original array reference unchanged when all entries
 * are already distinct.
 */
export function withUniqueQueueKeys<T extends KeyedItem>(queue: T[]): T[] {
  if (queue.length === 0) return queue;
  const seenKeys = new Set<string>();
  const seenRefs = new WeakSet<object>();
  let cloned: T[] | null = null;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object') continue;

    const ownKey =
      typeof item._queueKey === 'string' && item._queueKey.length > 0
        ? item._queueKey
        : undefined;
    const candidateKey = ownKey ?? _fallbackQueueKeys.get(item);
    const isDuplicateRef = seenRefs.has(item);
    const isDuplicateKey = candidateKey !== undefined && seenKeys.has(candidateKey);

    if (!isDuplicateRef && !isDuplicateKey) {
      seenRefs.add(item);
      if (candidateKey) {
        seenKeys.add(candidateKey);
      }
      continue;
    }

    if (!cloned) {
      cloned = queue.slice();
    }
    let newKey: string;
    do {
      newKey = `${item.id ?? 'track'}_${++_queueKeySeq}`;
    } while (seenKeys.has(newKey));
    seenKeys.add(newKey);
    const copy = { ...item, _queueKey: newKey };
    seenRefs.add(copy);
    cloned[i] = copy;
  }

  return cloned ?? queue;
}
