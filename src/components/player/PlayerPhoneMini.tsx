import Ionicons from "@react-native-vector-icons/ionicons/static";
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { CachedImage } from '@/components/CachedImage';
import { MarqueeText } from '@/components/MarqueeText';
import WaveformLogo from '@/components/WaveformLogo';
import { useImagePalette } from '@/hooks/useImagePalette';
import { useSongCoverArt } from '@/hooks/useSongCoverArt';
import { useTheme } from '@/hooks/useTheme';
import { skipToNext, skipToPrevious, togglePlayPause } from '@/services/playerService';
import { playbackSettingsStore } from '@/store/playbackSettingsStore';
import { playerStore } from '@/store/playerStore';

import { absoluteFill } from '@/utils/styles';
const MINI_PLAYER_HEIGHT = 56;
/** Matches the placeholder cover art background (rgb 150,150,150). */
const PLACEHOLDER_BG = '#969696';

// Magnetic snap parameters: smooth cubic-bezier deceleration that locks into place with zero bounce
const SNAP_EASING = Easing.bezier(0.25, 1, 0.5, 1);
const SNAP_DURATION = 190;
const SNAP_BACK_DURATION = 160;
const EXIT_DURATION = 130;

export function PlayerPhoneMini() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const currentTrack = playerStore((s) => s.currentTrack);
  const songCoverArtId = useSongCoverArt(currentTrack);
  const playbackState = playerStore((s) => s.playbackState);
  const position = playerStore((s) => s.position);
  const duration = playerStore((s) => s.duration);
  const queueLoading = playerStore((s) => s.queueLoading);
  const currentTrackIndex = playerStore((s) => s.currentTrackIndex);
  const queue = playerStore((s) => s.queue);
  const playbackHistory = playerStore((s) => s.playbackHistory);
  const repeatMode = playbackSettingsStore((s) => s.repeatMode);

  // Rendered synchronously from the store each re-render — same contract as
  // PlayerProgressBar so the two surfaces can never visually diverge.
  const progress = duration > 0 ? Math.max(0, Math.min(position / duration, 1)) : 0;

  const error = playerStore((s) => s.error);
  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';
  const canSkipNext =
    currentTrackIndex != null &&
    (currentTrackIndex < queue.length - 1 || repeatMode !== 'off');
  const canSkipPrevious =
    (currentTrackIndex != null && currentTrackIndex > 0) ||
    playbackHistory.length > 0 ||
    repeatMode !== 'off' ||
    position > 3;

  const handleSkipNext = useCallback(() => {
    if (canSkipNext) skipToNext();
  }, [canSkipNext]);

  const handleSkipPrevious = useCallback(() => {
    if (canSkipPrevious) skipToPrevious();
  }, [canSkipPrevious]);

  const marqueeStyle = useMemo(
    () => [styles.title, { color: queueLoading ? colors.textSecondary : colors.textPrimary }],
    [queueLoading, colors.textSecondary, colors.textPrimary],
  );

  // --- Colour extraction (palette is theme-aware; primary is lightness-clamped
  // for safe icon contrast). ---
  const { primary, gradientOpacity } = useImagePalette(songCoverArtId);

  const gradientAnimatedStyle = useAnimatedStyle(() => ({
    opacity: gradientOpacity.value,
  }));

  // --- Full player navigation ---
  const router = useRouter();
  const openPlayer = useCallback(() => router.push('/player'), [router]);

  // --- Horizontal swipe animation & gesture locking shared values ---
  const trackTranslateX = useSharedValue(0);
  const trackOpacity = useSharedValue(1);
  const gestureDirection = useSharedValue(0); // 0: undetermined, 1: horizontal, 2: vertical
  const isAnimatingChange = useSharedValue(false);
  const trackAreaWidth = useSharedValue(Dimensions.get('window').width);

  const handleLeftContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const w = event.nativeEvent.layout.width;
      if (w > 0) {
        trackAreaWidth.value = w;
      }
    },
    [trackAreaWidth],
  );

  const animatedTrackStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: trackTranslateX.value }],
      opacity: trackOpacity.value,
    };
  });

  // Gestures for mini player:
  // - Swipe up -> open full player
  // - Horizontal swipe -> 1:1 finger tracking with fade, threshold exit & spring entry
  // - Tap -> open full player
  const miniPanGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-10, 10])
      .activeOffsetY([-10, 10])
      .cancelsTouchesInView(true)
      .onBegin(() => {
        'worklet';
        if (isAnimatingChange.value) return;
        gestureDirection.value = 0;
      })
      .onStart(() => {
        'worklet';
        if (isAnimatingChange.value) return;
        gestureDirection.value = 0;
      })
      .onUpdate((event) => {
        'worklet';
        if (isAnimatingChange.value) return;

        const absX = Math.abs(event.translationX);
        const absY = Math.abs(event.translationY);

        // Direction locking: lock into horizontal or vertical on initial dominant movement
        if (gestureDirection.value === 0) {
          if (absX > 6 || absY > 6) {
            if (absX > absY) {
              gestureDirection.value = 1; // Locked to HORIZONTAL
            } else {
              gestureDirection.value = 2; // Locked to VERTICAL
            }
          }
        }

        // Horizontal tracking: 1:1 finger movement + proportional fade
        if (gestureDirection.value === 1) {
          trackTranslateX.value = event.translationX;
          const width = trackAreaWidth.value > 0 ? trackAreaWidth.value : 300;
          trackOpacity.value = interpolate(
            absX,
            [0, width * 0.5],
            [1, 0.4],
            Extrapolation.CLAMP,
          );
        }
      })
      .onEnd((event) => {
        'worklet';
        if (isAnimatingChange.value) return;

        const absX = Math.abs(event.translationX);
        const absY = Math.abs(event.translationY);

        // Vertical gesture: open full player
        if (gestureDirection.value === 2 || (gestureDirection.value === 0 && absY > absX)) {
          if (event.translationY < -25 || event.velocityY < -300) {
            runOnJS(openPlayer)();
          }
          gestureDirection.value = 0;
          return;
        }

        // Horizontal gesture: check threshold for track skip
        if (gestureDirection.value === 1 || (gestureDirection.value === 0 && absX > absY)) {
          const isSwipeLeft = event.translationX < -65 || event.velocityX < -500;
          const isSwipeRight = event.translationX > 65 || event.velocityX > 500;
          const width = trackAreaWidth.value > 0 ? trackAreaWidth.value : 300;
          const exitDistance = width + 20;

          // Swipe left (next track)
          if (isSwipeLeft && canSkipNext) {
            isAnimatingChange.value = true;
            trackOpacity.value = withTiming(0, { duration: EXIT_DURATION });
            trackTranslateX.value = withTiming(
              -exitDistance,
              { duration: EXIT_DURATION, easing: Easing.out(Easing.quad) },
              (finished) => {
                if (finished) {
                  trackTranslateX.value = exitDistance;
                  trackOpacity.value = 0.4;
                  runOnJS(skipToNext)();
                  trackTranslateX.value = withTiming(
                    0,
                    { duration: SNAP_DURATION, easing: SNAP_EASING },
                    (snapDone) => {
                      if (snapDone) {
                        isAnimatingChange.value = false;
                      }
                    },
                  );
                  trackOpacity.value = withTiming(1, {
                    duration: SNAP_DURATION,
                    easing: SNAP_EASING,
                  });
                } else {
                  isAnimatingChange.value = false;
                }
              },
            );
            gestureDirection.value = 0;
            return;
          }

          // Swipe right (previous track)
          if (isSwipeRight && canSkipPrevious) {
            isAnimatingChange.value = true;
            trackOpacity.value = withTiming(0, { duration: EXIT_DURATION });
            trackTranslateX.value = withTiming(
              exitDistance,
              { duration: EXIT_DURATION, easing: Easing.out(Easing.quad) },
              (finished) => {
                if (finished) {
                  trackTranslateX.value = -exitDistance;
                  trackOpacity.value = 0.4;
                  runOnJS(skipToPrevious)();
                  trackTranslateX.value = withTiming(
                    0,
                    { duration: SNAP_DURATION, easing: SNAP_EASING },
                    (snapDone) => {
                      if (snapDone) {
                        isAnimatingChange.value = false;
                      }
                    },
                  );
                  trackOpacity.value = withTiming(1, {
                    duration: SNAP_DURATION,
                    easing: SNAP_EASING,
                  });
                } else {
                  isAnimatingChange.value = false;
                }
              },
            );
            gestureDirection.value = 0;
            return;
          }

          // Threshold NOT reached or cannot skip: snap back magnetically with zero bounce
          trackTranslateX.value = withTiming(0, {
            duration: SNAP_BACK_DURATION,
            easing: SNAP_EASING,
          });
          trackOpacity.value = withTiming(1, {
            duration: SNAP_BACK_DURATION,
            easing: SNAP_EASING,
          });
          gestureDirection.value = 0;
          return;
        }

        trackTranslateX.value = withTiming(0, {
          duration: SNAP_BACK_DURATION,
          easing: SNAP_EASING,
        });
        trackOpacity.value = withTiming(1, {
          duration: SNAP_BACK_DURATION,
          easing: SNAP_EASING,
        });
        gestureDirection.value = 0;
      })
      .onFinalize(() => {
        'worklet';
        if (!isAnimatingChange.value && trackTranslateX.value !== 0) {
          trackTranslateX.value = withTiming(0, {
            duration: SNAP_BACK_DURATION,
            easing: SNAP_EASING,
          });
          trackOpacity.value = withTiming(1, {
            duration: SNAP_BACK_DURATION,
            easing: SNAP_EASING,
          });
          gestureDirection.value = 0;
        }
      });
  }, [
    isAnimatingChange,
    gestureDirection,
    trackTranslateX,
    trackOpacity,
    trackAreaWidth,
    openPlayer,
    canSkipNext,
    canSkipPrevious,
  ]);

  const miniTapGesture = useMemo(() => {
    return Gesture.Tap().onEnd(() => {
      'worklet';
      if (isAnimatingChange.value) return;
      runOnJS(openPlayer)();
    });
  }, [openPlayer, isAnimatingChange]);

  const miniGesture = useMemo(() => {
    return Gesture.Exclusive(miniPanGesture, miniTapGesture);
  }, [miniPanGesture, miniTapGesture]);

  if (!currentTrack) return null;

  /** Append alpha hex to a colour string (supports #RGB, #RRGGBB). */
  const withAlpha = (hex: string, alpha: number) => {
    const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
    return `${hex}${a}`;
  };

  // 2-stop vertical gradient: the extracted primary (the dominant/vibrant cover
  // colour, lightness-clamped) → theme background.
  const extractedTop = primary ?? colors.card;
  const topColor = queueLoading ? PLACEHOLDER_BG : extractedTop;
  const gradientColors: readonly [string, string, ...string[]] = [
    withAlpha(topColor, 0.65),
    withAlpha(colors.background, 0.65),
  ];
  const gradientLocations: readonly [number, number, ...number[]] = [0, 1];

  return (
    <View style={[styles.container, { backgroundColor: withAlpha(colors.card, 0.65) }]}>
      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: colors.primary,
              opacity: 0.65,
              width: `${progress * 100}%`,
            },
          ]}
        />
      </View>

      {/* Gradient overlay */}
      <Animated.View style={[absoluteFill, gradientAnimatedStyle]} pointerEvents="none">
        <LinearGradient
          colors={gradientColors}
          locations={gradientLocations}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={absoluteFill}
        />
      </Animated.View>

      {/* Zona Sinistra (flex: 1, overflow: 'hidden'): [Copertina, Titolo, Artista] */}
      <View testID="mini-left-zone" style={styles.leftContainer} onLayout={handleLeftContainerLayout}>
        <GestureDetector gesture={miniGesture}>
          <Animated.View testID="mini-track-content" style={[styles.trackContent, animatedTrackStyle]}>
            {/* Cover art (or placeholder while loading) */}
            {queueLoading ? (
              <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: 'rgba(150,150,150,0.25)' }]}>
                <WaveformLogo size={16} color="rgba(150,150,150,1)" />
              </View>
            ) : (
              <CachedImage
                coverArtId={songCoverArtId}
                size={300}
                style={styles.cover}
                resizeMode="cover"
              />
            )}

            {/* Track info */}
            <View style={styles.info}>
              <MarqueeText style={marqueeStyle}>
                {queueLoading ? t('loading') : currentTrack.title}
              </MarqueeText>
              {!queueLoading && (
                <Text style={[styles.artist, { color: colors.textSecondary }]} numberOfLines={1}>
                  {currentTrack.artist ?? t('unknownArtist')}
                </Text>
              )}
            </View>
          </Animated.View>
        </GestureDetector>
      </View>

      {/* Zona Destra (Fissa): Contiene i pulsanti ⏪ ▶ ⏩ */}
      <View style={styles.controls}>
        {/* Skip to previous */}
        <Pressable
          testID="mini-prev"
          onPress={handleSkipPrevious}
          hitSlop={8}
          disabled={!canSkipPrevious}
          style={({ pressed }) => [styles.skipButton, pressed && canSkipPrevious && styles.pressed]}
        >
          <Ionicons
            name="play-back"
            size={22}
            color={colors.textPrimary}
            style={!canSkipPrevious ? { opacity: 0.35 } : undefined}
          />
        </Pressable>

        {/* Play / Pause / Buffering */}
        <Pressable
          testID="mini-play-pause"
          onPress={togglePlayPause}
          hitSlop={8}
          style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
        >
          {(isBuffering || queueLoading) ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={28}
              color={error ? colors.red : colors.textPrimary}
            />
          )}
        </Pressable>

        {/* Skip to next */}
        <Pressable
          testID="mini-next"
          onPress={handleSkipNext}
          hitSlop={8}
          disabled={!canSkipNext}
          style={({ pressed }) => [styles.skipButton, pressed && canSkipNext && styles.pressed]}
        >
          <Ionicons
            name="play-forward"
            size={22}
            color={colors.textPrimary}
            style={!canSkipNext ? { opacity: 0.35 } : undefined}
          />
        </Pressable>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: MINI_PLAYER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    overflow: 'hidden',
  },
  progressTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 5,
    zIndex: 1,
  },
  progressFill: {
    height: '100%',
  },
  leftContainer: {
    flex: 1,
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
    minWidth: 0,
  },
  trackContent: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  cover: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  info: {
    flex: 1,
    marginLeft: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  artist: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    zIndex: 10,
    elevation: 4,
  },
  playButton: {
    padding: 4,
  },
  skipButton: {
    padding: 4,
  },
  pressed: {
    opacity: 0.6,
  },
});
