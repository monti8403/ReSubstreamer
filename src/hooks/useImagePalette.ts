/**
 * Hook that extracts a two-colour palette from cover art and provides an
 * animated gradient opacity value. Supersedes `useColorExtraction`.
 *
 * The native module returns BOTH a dark-mode and a light-mode variant in
 * one call, so theme flips cost zero extra work — we re-pick from the
 * cached palette without calling native again.
 *
 * Each variant's primary is lightness-clamped to guarantee contrast
 * against the overlaid icons (white in dark mode, black in light mode).
 * Consumers use `primary` as the gradient start colour and `secondary`
 * (if non-null) as the gradient end — falling back to theme colours
 * when the cover art has no usable colour or the extraction fails.
 */

import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { useCachedCoverArt } from './useCachedCoverArt';
import { useTheme } from './useTheme';
import { getImagePaletteAsync, type Palette } from 'expo-image-colors';

/** Sentinel value: pass as coverArtId to explicitly skip extraction. */
export const SKIP_COLOR_EXTRACTION = '__SKIP_COLOR_EXTRACTION__';

interface ImagePaletteResult {
  /** Theme-appropriate primary colour, or null if no palette is available. */
  primary: string | null;
  /** Theme-appropriate secondary colour, or null (monochromatic image or no palette). */
  secondary: string | null;
  /** Animated opacity 0→1 on palette-set, 1→0 on palette-clear. Drive gradient visibility. */
  gradientOpacity: SharedValue<number>;
}

export function useImagePalette(coverArtId: string | undefined): ImagePaletteResult {
  const skip = coverArtId === SKIP_COLOR_EXTRACTION;
  const cachedUri = useCachedCoverArt(skip ? undefined : coverArtId, 300);
  const { theme } = useTheme();
  const [palette, setPalette] = useState<Palette | null>(null);
  const hadPaletteRef = useRef(false);
  const gradientOpacity = useSharedValue(0);

  useEffect(() => {
    // Clear only when there is genuinely nothing to extract from: no cover,
    // an explicit skip, or Expo Go (no native module). These are the only
    // cases where blanking the gradient is correct.
    if (skip || !coverArtId || Constants.appOwnership === 'expo') {
      setPalette(null);
      return;
    }
    // No resolved URI yet — the cache lookup is still in flight, or it's
    // transiently re-resolving because a cover-art cache update landed (e.g.
    // another player tab rendered the same album art). Keep the last-good
    // palette; the effect re-runs once a URI is available.
    if (!cachedUri) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await getImagePaletteAsync(cachedUri);
        if (!cancelled) setPalette(result);
      } catch {
        // Transient extraction failure (file mid-rewrite during a resize, a
        // remote blip, etc). Keep the last-good palette rather than blanking an
        // already-visible gradient — clearing it here is what made the player
        // hero gradient vanish on tab switches and stay gone until reopen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coverArtId, cachedUri, skip]);

  useEffect(() => {
    if (palette) {
      if (!hadPaletteRef.current) {
        // Initial transition from no palette to visible palette
        gradientOpacity.value = 0;
        gradientOpacity.value = withTiming(1, { duration: 400 });
      } else {
        // Keep visible at 1 so transitions between covers do not flash black
        gradientOpacity.value = 1;
      }
      hadPaletteRef.current = true;
    } else {
      gradientOpacity.value = withTiming(0, { duration: 300 });
      hadPaletteRef.current = false;
    }
  }, [palette, gradientOpacity]);

  const mode = palette ? palette[theme] : null;
  return {
    primary: mode?.primary ?? null,
    secondary: mode?.secondary ?? null,
    gradientOpacity,
  };
}
