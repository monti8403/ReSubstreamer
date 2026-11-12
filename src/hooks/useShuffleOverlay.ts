import { useCallback } from 'react';
import { type ViewStyle } from 'react-native';
import { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { shuffleQueue } from '../services/playerService';

/**
 * Owns the shuffle action with the Play-First, Fetch-Later pattern:
 * Instant non-blocking queue shuffle with zero full-screen spinner delay.
 */
export function useShuffleOverlay() {
  const overlayOpacity = useSharedValue(0);
  const spinAnim = useSharedValue(0);

  const overlayStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: 0,
  }));

  const spinStyle = useAnimatedStyle<ViewStyle>(() => ({
    transform: [{ rotate: '0deg' }],
  }));

  const handleShuffle = useCallback(async () => {
    try {
      await shuffleQueue();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[useShuffleOverlay] shuffleQueue failed:', e);
    }
  }, []);

  return { shuffling: false, handleShuffle, overlayStyle, spinStyle };
}
