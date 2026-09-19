import React, { useEffect, useRef, useState } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useCoverGradient } from '@/hooks/useCoverGradient';
import { absoluteFill } from '@/utils/styles';

export interface PlayerCoverGradientProps {
  coverArtId: string | undefined;
  endColor: string;
  locations?: readonly [number, number, ...number[]];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  /** Optional container animated style (e.g. tablet landscape expand animation) */
  containerAnimatedStyle?: any;
}

/**
 * Dual-layer crossfading player gradient background.
 *
 * Keeps the previous track's gradient fully visible on a base layer while
 * crossfading the incoming track's gradient smoothly on top over 600ms.
 * Completely eliminates any black flash or jarring cut between songs.
 */
export function PlayerCoverGradient({
  coverArtId,
  endColor,
  locations,
  start,
  end,
  containerAnimatedStyle,
}: PlayerCoverGradientProps) {
  const { gradientColors, gradientLocations } = useCoverGradient(coverArtId, endColor);
  const effectiveLocations = locations ?? gradientLocations;

  const [baseColors, setBaseColors] = useState<readonly [string, string, ...string[]]>(gradientColors);
  const [topColors, setTopColors] = useState<readonly [string, string, ...string[]] | null>(null);

  const prevColorsRef = useRef<readonly [string, string, ...string[]]>(gradientColors);
  const crossfadeProgress = useSharedValue(1);

  const handleCrossfadeEnd = (settledColors: readonly [string, string, ...string[]]) => {
    setBaseColors(settledColors);
    setTopColors(null);
  };

  useEffect(() => {
    const currentTop = gradientColors[0];
    const prevTop = prevColorsRef.current[0];
    const currentBottom = gradientColors[1];
    const prevBottom = prevColorsRef.current[1];

    // If colors haven't changed, no crossfade is needed
    if (currentTop === prevTop && currentBottom === prevBottom) {
      return;
    }

    const previous = prevColorsRef.current;
    prevColorsRef.current = gradientColors;

    // Retain previous colors on the base layer
    setBaseColors(previous);
    // Render the new colors on the top layer to crossfade in
    setTopColors(gradientColors);

    crossfadeProgress.value = 0;
    crossfadeProgress.value = withTiming(
      1,
      { duration: 600, easing: Easing.out(Easing.quad) },
      (finished) => {
        if (finished) {
          runOnJS(handleCrossfadeEnd)(gradientColors);
        }
      },
    );
  }, [gradientColors, crossfadeProgress]);

  const topAnimatedStyle = useAnimatedStyle(() => ({
    opacity: crossfadeProgress.value,
  }));

  return (
    <Animated.View style={[absoluteFill, containerAnimatedStyle]} pointerEvents="none">
      {/* Base layer: solid previous/settled gradient */}
      <LinearGradient
        colors={baseColors}
        locations={effectiveLocations}
        start={start}
        end={end}
        style={absoluteFill}
      />

      {/* Top layer: smoothly crossfades new gradient from 0 -> 1 without exposing background */}
      {topColors && (
        <Animated.View style={[absoluteFill, topAnimatedStyle]}>
          <LinearGradient
            colors={topColors}
            locations={effectiveLocations}
            start={start}
            end={end}
            style={absoluteFill}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}
