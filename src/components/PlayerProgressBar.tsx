/**
 * PlayerProgressBar – seekable progress bar for the full player view.
 *
 * Displays a horizontal track with a filled portion, a draggable thumb,
 * and elapsed / remaining time labels below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { type ThemeColors } from '../constants/theme';
import { formatTrackDuration } from '../utils/formatters';

const TRACK_HEIGHT = 4;
const TRACK_HIT_SLOP = 14;
const THUMB_SIZE = 14;
const ACTIVE_THUMB_SIZE = 18;

const clamp = (val: number, min: number, max: number) =>
  Math.max(min, Math.min(max, val));

export interface PlayerProgressBarProps {
  /** Current playback position in seconds. */
  position: number;
  /** Total duration of the current track in seconds. */
  duration: number;
  /** Absolute buffered edge from the start of the track, in seconds. */
  bufferedPosition?: number;
  /** Theme colors. */
  colors: ThemeColors;
  /** Called when the user finishes seeking (finger released). */
  onSeek: (seconds: number) => void;
  /** Whether the player is currently buffering. */
  isBuffering?: boolean;
  /** Playback error message to display, or null when healthy. */
  error?: string | null;
  /** Whether the player is currently auto-retrying after an error. */
  retrying?: boolean;
  /** Called when the user taps the manual retry button. */
  onRetry?: () => void;
}

export function PlayerProgressBar({
  position,
  duration,
  bufferedPosition = 0,
  colors,
  onSeek,
  isBuffering = false,
  error = null,
  retrying = false,
  onRetry,
}: PlayerProgressBarProps) {
  const { t } = useTranslation();
  const trackRef = useRef<View>(null);
  const [throttledDragFraction, setThrottledDragFraction] = useState<number | null>(
    null,
  );
  const [pendingSeekFraction, setPendingSeekFraction] = useState<number | null>(
    null,
  );

  const initialFraction =
    duration > 0 ? clamp(position / duration, 0, 1) : 0;
  const initialBufferedFraction =
    duration > 0 ? clamp(bufferedPosition / duration, 0, 1) : 0;

  const trackWidthSV = useSharedValue(0);
  const trackPageXSV = useSharedValue(0);
  const isDraggingSV = useSharedValue(false);
  const dragFractionSV = useSharedValue(0);
  const playbackFractionSV = useSharedValue(initialFraction);
  const bufferedFractionSV = useSharedValue(initialBufferedFraction);
  const lastLabelUpdateAtSV = useSharedValue(0);
  const thumbScale = useSharedValue(1);

  const fillAnimStyle = useAnimatedStyle(() => {
    const f = isDraggingSV.value ? dragFractionSV.value : playbackFractionSV.value;
    return { width: `${f * 100}%` };
  });

  const thumbAnimStyle = useAnimatedStyle(() => {
    const f = isDraggingSV.value ? dragFractionSV.value : playbackFractionSV.value;
    return {
      left: `${f * 100}%`,
      transform: [{ scale: thumbScale.value }],
    };
  });

  const bufferedAnimStyle = useAnimatedStyle(() => ({
    width: `${bufferedFractionSV.value * 100}%`,
  }));

  const durationRef = useRef(duration);
  durationRef.current = duration;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const handleTapSeek = useCallback((frac: number) => {
    setPendingSeekFraction(frac);
    onSeekRef.current(frac * durationRef.current);
  }, []);

  const handleDragLabelUpdate = useCallback((frac: number) => {
    setThrottledDragFraction(frac);
  }, []);

  const handlePanEnd = useCallback((finalFrac: number) => {
    setThrottledDragFraction(null);
    setPendingSeekFraction(finalFrac);
    onSeekRef.current(finalFrac * durationRef.current);
  }, []);

  const handlePanCancel = useCallback(() => {
    setThrottledDragFraction(null);
  }, []);

  const tapGesture = useMemo(
    () =>
      Gesture.Tap().onEnd((e) => {
        'worklet';
        const w = trackWidthSV.value || 1;
        const frac = Math.max(0, Math.min(1, (e.absoluteX - trackPageXSV.value) / w));
        playbackFractionSV.value = frac;
        runOnJS(handleTapSeek)(frac);
      }),
    [handleTapSeek, playbackFractionSV, trackPageXSV, trackWidthSV],
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-6, 6])
        .failOffsetY([-10, 10])
        .onStart((e) => {
          'worklet';
          const w = trackWidthSV.value || 1;
          const frac = Math.max(0, Math.min(1, (e.absoluteX - trackPageXSV.value) / w));
          isDraggingSV.value = true;
          dragFractionSV.value = frac;
          lastLabelUpdateAtSV.value = Date.now();
          thumbScale.value = withSpring(ACTIVE_THUMB_SIZE / THUMB_SIZE);
          runOnJS(handleDragLabelUpdate)(frac);
        })
        .onUpdate((e) => {
          'worklet';
          const w = trackWidthSV.value || 1;
          const frac = Math.max(0, Math.min(1, (e.absoluteX - trackPageXSV.value) / w));
          dragFractionSV.value = frac;
          const now = Date.now();
          if (now - lastLabelUpdateAtSV.value >= 80) {
            lastLabelUpdateAtSV.value = now;
            runOnJS(handleDragLabelUpdate)(frac);
          }
        })
        .onEnd(() => {
          'worklet';
          const finalFrac = dragFractionSV.value;
          playbackFractionSV.value = finalFrac;
          isDraggingSV.value = false;
          thumbScale.value = withSpring(1);
          runOnJS(handlePanEnd)(finalFrac);
        })
        .onFinalize((_, success) => {
          'worklet';
          if (!success) {
            isDraggingSV.value = false;
            thumbScale.value = withSpring(1);
            runOnJS(handlePanCancel)();
          }
        }),
    [
      dragFractionSV,
      handleDragLabelUpdate,
      handlePanCancel,
      handlePanEnd,
      isDraggingSV,
      lastLabelUpdateAtSV,
      playbackFractionSV,
      thumbScale,
      trackPageXSV,
      trackWidthSV,
    ],
  );

  const seekGesture = useMemo(
    () => Gesture.Race(panGesture, tapGesture),
    [panGesture, tapGesture],
  );

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) => {
      trackWidthSV.value = e.nativeEvent.layout.width;
      trackRef.current?.measureInWindow((x) => {
        if (x != null) trackPageXSV.value = x;
      });
    },
    [trackPageXSV, trackWidthSV],
  );

  // Clear the pending seek fraction once the store position catches up.
  useEffect(() => {
    if (pendingSeekFraction != null && duration > 0) {
      const seekPos = pendingSeekFraction * duration;
      if (Math.abs(position - seekPos) < 2) {
        setPendingSeekFraction(null);
      }
    }
  }, [position, duration, pendingSeekFraction]);

  // Fallback timeout: if the seek didn't take effect (e.g. the native player
  // silently ignored it because the target was beyond the buffer), clear the
  // pending state after 1 s so the progress bar resumes normal updates.
  useEffect(() => {
    if (pendingSeekFraction != null) {
      const timer = setTimeout(() => {
        setPendingSeekFraction(null);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [pendingSeekFraction]);

  const effectivePlaybackFraction =
    pendingSeekFraction != null
      ? pendingSeekFraction
      : duration > 0
        ? clamp(position / duration, 0, 1)
        : 0;

  const bufferedFraction =
    duration > 0 ? clamp(bufferedPosition / duration, 0, 1) : 0;

  useEffect(() => {
    playbackFractionSV.value = effectivePlaybackFraction;
    bufferedFractionSV.value = bufferedFraction;
  }, [
    bufferedFraction,
    bufferedFractionSV,
    effectivePlaybackFraction,
    playbackFractionSV,
  ]);

  const displayPosition =
    throttledDragFraction != null
      ? throttledDragFraction * duration
      : pendingSeekFraction != null
        ? pendingSeekFraction * duration
        : position;
  const remaining = Math.max(0, duration - displayPosition);

  return (
    <View style={styles.container}>
      {/* Track + thumb */}
      <GestureDetector gesture={seekGesture}>
        <View
          ref={trackRef}
          style={[styles.trackHitArea, { paddingVertical: TRACK_HIT_SLOP }]}
          onLayout={handleLayout}
        >
          <View
            style={[styles.track, { backgroundColor: colors.border }]}
            pointerEvents="none"
          >
            {/* Buffered range (behind played fill) */}
            <Animated.View
              style={[
                styles.bufferedFill,
                { backgroundColor: colors.primary },
                bufferedAnimStyle,
              ]}
            />
            {/* Played range */}
            <Animated.View
              style={[
                styles.fill,
                { backgroundColor: colors.primary },
                fillAnimStyle,
              ]}
            />
          </View>
          {/* Thumb */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              { backgroundColor: colors.textPrimary },
              thumbAnimStyle,
            ]}
          />
        </View>
      </GestureDetector>
      {/* Time labels */}
      <View style={styles.times}>
        <Text style={[styles.timeText, { color: colors.textSecondary }]}>
          {formatTrackDuration(displayPosition)}
        </Text>
        {error != null && !retrying ? (
          <View style={styles.centerStatus}>
            <Text
              style={[styles.statusLabel, { color: colors.red }]}
              numberOfLines={1}
            >
              {error}
            </Text>
            {onRetry != null && (
              <Pressable
                onPress={onRetry}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.retryButton,
                  { borderColor: colors.red },
                  pressed && styles.retryPressed,
                ]}
              >
                <Text style={[styles.retryText, { color: colors.red }]}>
                  {t('retry')}
                </Text>
              </Pressable>
            )}
          </View>
        ) : retrying ? (
          <Text style={[styles.statusLabel, { color: colors.red }]}>
            Retrying…
          </Text>
        ) : (
          <Text
            style={[
              styles.statusLabel,
              { color: colors.textSecondary, opacity: isBuffering ? 1 : 0 },
            ]}
          >
            {t('buffering')}
          </Text>
        )}
        <Text style={[styles.timeText, { color: colors.textSecondary }]}>
          {formatTrackDuration(remaining)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  trackHitArea: {
    width: '100%',
    justifyContent: 'center',
    position: 'relative',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
  },
  bufferedFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    opacity: 0.25,
    borderRadius: TRACK_HEIGHT / 2,
  },
  fill: {
    height: '100%',
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    marginLeft: -(THUMB_SIZE / 2),
    top: TRACK_HIT_SLOP - THUMB_SIZE / 2 + TRACK_HEIGHT / 2,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  centerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  statusLabel: {
    fontSize: 12,
    flexShrink: 1,
  },
  retryButton: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  retryPressed: {
    opacity: 0.6,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
