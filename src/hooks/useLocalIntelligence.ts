import { useCallback, useEffect, useRef, useState } from 'react';
import type { Child } from 'subsonic-api';

import {
  getDynamicMixSummaries,
  getForgottenGems,
  getHourlyDaylist,
  getJumpBackIn,
  getOnRepeat,
  getQuickMoodChips,
  resolveDynamicMix as resolveDynamicMixService,
  type DynamicMixSummary,
  type HourlyDaylist,
  type JumpBackInItem,
  type QuickMoodChip,
  type ResolveDynamicMixOptions,
  type ResolvedDynamicMix,
} from '../services/localIntelligenceService';
import { completedScrobbleStore } from '../store/completedScrobbleStore';
import { offlineModeStore } from '../store/offlineModeStore';

export interface UseLocalIntelligenceResult {
  jumpBackIn: JumpBackInItem[];
  daylist: HourlyDaylist | null;
  onRepeat: Child[];
  forgottenGems: Child[];
  quickMoodChips: QuickMoodChip[];
  dynamicMixes: DynamicMixSummary[];
  resolveDynamicMix: (
    mixKey: string,
    options?: ResolveDynamicMixOptions,
  ) => Promise<ResolvedDynamicMix | null>;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads all local SQLite intelligence feeds (including 0ms dynamic mix
 * summaries) in parallel and refreshes reactively when scrobble history length
 * or offline mode changes.
 */
export function useLocalIntelligence(): UseLocalIntelligenceResult {
  const scrobbleCount = completedScrobbleStore((s) => s.recentScrobbles.length);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const [jumpBackIn, setJumpBackIn] = useState<JumpBackInItem[]>([]);
  const [daylist, setDaylist] = useState<HourlyDaylist | null>(null);
  const [onRepeat, setOnRepeat] = useState<Child[]>([]);
  const [forgottenGems, setForgottenGems] = useState<Child[]>([]);
  const [quickMoodChips, setQuickMoodChips] = useState<QuickMoodChip[]>([]);
  const [dynamicMixes, setDynamicMixes] = useState<DynamicMixSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAll = useCallback(async (isCancelled?: () => boolean): Promise<void> => {
    const reqId = ++requestIdRef.current;
    if (mountedRef.current && !isCancelled?.()) {
      setLoading(true);
    }

    try {
      const [
        nextJumpBackIn,
        nextDaylist,
        nextOnRepeat,
        nextForgottenGems,
        nextQuickMoodChips,
        nextDynamicMixes,
      ] = await Promise.all([
        getJumpBackIn(),
        getHourlyDaylist(),
        getOnRepeat(),
        getForgottenGems(),
        getQuickMoodChips(),
        typeof getDynamicMixSummaries === 'function'
          ? getDynamicMixSummaries()
          : Promise.resolve([]),
      ]);

      if (!mountedRef.current || isCancelled?.() || reqId !== requestIdRef.current) {
        return;
      }

      setJumpBackIn(nextJumpBackIn);
      setDaylist(nextDaylist);
      setOnRepeat(nextOnRepeat);
      setForgottenGems(nextForgottenGems);
      setQuickMoodChips(nextQuickMoodChips);
      setDynamicMixes(nextDynamicMixes);
    } catch {
      // Service functions already degrade safely to empty results.
    } finally {
      if (mountedRef.current && !isCancelled?.() && reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const resolveDynamicMix = useCallback(
    async (
      mixKey: string,
      options?: ResolveDynamicMixOptions,
    ): Promise<ResolvedDynamicMix | null> => {
      const resolved = await resolveDynamicMixService(mixKey, options);
      if (resolved && mountedRef.current) {
        const nextSummaries = await getDynamicMixSummaries();
        if (mountedRef.current) {
          setDynamicMixes(nextSummaries);
        }
      }
      return resolved;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void loadAll(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadAll, scrobbleCount, offlineMode]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadAll();
  }, [loadAll]);

  return {
    jumpBackIn,
    daylist,
    onRepeat,
    forgottenGems,
    quickMoodChips,
    dynamicMixes,
    resolveDynamicMix,
    loading,
    refresh,
  };
}
