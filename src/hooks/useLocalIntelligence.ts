import { useCallback, useEffect, useRef, useState } from 'react';
import type { Child } from 'subsonic-api';

import {
  getForgottenGems,
  getHourlyDaylist,
  getJumpBackIn,
  getOnRepeat,
  getQuickMoodChips,
  type HourlyDaylist,
  type JumpBackInItem,
  type QuickMoodChip,
} from '../services/localIntelligenceService';
import { completedScrobbleStore } from '../store/completedScrobbleStore';
import { offlineModeStore } from '../store/offlineModeStore';

export interface UseLocalIntelligenceResult {
  jumpBackIn: JumpBackInItem[];
  daylist: HourlyDaylist | null;
  onRepeat: Child[];
  forgottenGems: Child[];
  quickMoodChips: QuickMoodChip[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads all five local SQLite intelligence feeds in parallel and refreshes
 * reactively when scrobble history length or offline mode changes.
 */
export function useLocalIntelligence(): UseLocalIntelligenceResult {
  const scrobbleCount = completedScrobbleStore((s) => s.recentScrobbles.length);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const [jumpBackIn, setJumpBackIn] = useState<JumpBackInItem[]>([]);
  const [daylist, setDaylist] = useState<HourlyDaylist | null>(null);
  const [onRepeat, setOnRepeat] = useState<Child[]>([]);
  const [forgottenGems, setForgottenGems] = useState<Child[]>([]);
  const [quickMoodChips, setQuickMoodChips] = useState<QuickMoodChip[]>([]);
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
      ] = await Promise.all([
        getJumpBackIn(),
        getHourlyDaylist(),
        getOnRepeat(),
        getForgottenGems(),
        getQuickMoodChips(),
      ]);

      if (!mountedRef.current || isCancelled?.() || reqId !== requestIdRef.current) {
        return;
      }

      setJumpBackIn(nextJumpBackIn);
      setDaylist(nextDaylist);
      setOnRepeat(nextOnRepeat);
      setForgottenGems(nextForgottenGems);
      setQuickMoodChips(nextQuickMoodChips);
    } catch {
      // Service functions already degrade safely to empty results.
    } finally {
      if (mountedRef.current && !isCancelled?.() && reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

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
    loading,
    refresh,
  };
}
