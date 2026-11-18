import Ionicons from "@react-native-vector-icons/ionicons/static";
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
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
  cancelAnimation,
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
import { AtrumLogo } from '@/components/AtrumLogo';
import { useCanSkip } from '@/hooks/useCanSkip';
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

/**
 * Isolated thin top progress strip so 2Hz `position` / `duration` updates only
 * re-render this 5px bar rather than the entire `PlayerPhoneMini` tree.
 */
const MiniProgressStrip = memo(function MiniProgressStrip({
  primaryColor,
}: {
  primaryColor: string;
}) {
  const position = playerStore((s) => s.position);
  const duration = playerStore((s) => s.duration);
  const progress = duration > 0 ? Math.max(0, Math.min(position / duration, 1)) : 0;

  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          {
            backgroundColor: primaryColor,
            opacity: 0.65,
            width: `${progress * 100}%`,
          },
        ]}
      />
    </View>
  );
});

/**
 * Isolated skip-previous control subscribing only to the boolean `position > 3`
 * threshold so crossings happen once per track instead of on every tick.
 */
const MiniPrevButton = memo(function MiniPrevButton({
  canSkipPrevious,
  iconColor,
  onSkipPrevious,
}: {
  canSkipPrevious: boolean;
  iconColor: string;
  onSkipPrevious: () => void;
}) {
  return (
    <Pressable
      testID="mini-prev"
      onPress={onSkipPrevious}
      hitSlop={8}
      disabled={!canSkipPrevious}
      style={({ pressed }) => [styles.skipButton, pressed && canSkipPrevious && styles.pressed]}
    >
      <Ionicons
        name="play-back"
        size={22}
        color={iconColor}
        style={!canSkipPrevious ? { opacity: 0.35 } : undefined}
      />
    </Pressable>
  );
});

export function PlayerPhoneMini() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const currentTrack = playerStore((s) => s.currentTrack);
  const songCoverArtId = useSongCoverArt(currentTrack);
  const playbackState = playerStore((s) => s.playbackState);
  const queueLoading = playerStore((s) => s.queueLoading);
  const { canSkipNext, canSkipPrevious } = useCanSkip();

  const error = playerStore((s) => s.error);
  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';

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

  // --- Horizontal swipe / skip transition shared values ---
  const trackTranslateX = useSharedValue(0);
  const trackOpacity = useSharedValue(1);
  const gestureDirection = useSharedValue(0); // 0: undetermined, 1: horizontal, 2: vertical
  const isAnimatingChange = useSharedValue(false);
  const activeAnimId = useSharedValue(0);
  const trackAreaWidth = useSharedValue(Dimensions.get('window').width);

  // Refs for rapid tap queuing, preventing double animations on internal skips,
  // and determining slide direction on external/automatic track changes.
  const buttonAnimTokenRef = useRef(0);
  const pendingMidpointRef = useRef<{ token: number; action: () => void } | null>(null);
  const internalSkipExpectedRef = useRef({ remaining: 0, expiresAt: 0 });
  const prevTrackSnapshotRef = useRef<{
    id: string;
    index: number | null;
    queueLength: number;
    queue: unknown[];
  } | null>(null);

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

  const markInternalSkipExpected = useCallback(() => {
    const prev = internalSkipExpectedRef.current;
    const activeRemaining = Date.now() <= prev.expiresAt ? prev.remaining : 0;
    internalSkipExpectedRef.current = {
      remaining: activeRemaining + 1,
      expiresAt: Date.now() + 1200,
    };
  }, []);

  const executeMidpointSkip = useCallback(
    (token: number) => {
      const pending = pendingMidpointRef.current;
      if (!pending || pending.token !== token) return;
      pendingMidpointRef.current = null;
      markInternalSkipExpected();
      pending.action();
    },
    [markInternalSkipExpected],
  );

  const snapBackToRest = useCallback(() => {
    trackTranslateX.value = withTiming(0, {
      duration: SNAP_BACK_DURATION,
      easing: SNAP_EASING,
    });
    trackOpacity.value = withTiming(1, {
      duration: SNAP_BACK_DURATION,
      easing: SNAP_EASING,
    });
  }, [trackOpacity, trackTranslateX]);

  /**
   * Run the two-phase slide transition (130ms exit fade -> midpoint skip -> 190ms magnetic snap in).
   * If a previous exit transition has not yet reached its midpoint (rapid multi-tap),
   * flush that pending skip immediately so zero taps are ever dropped.
   */
  const runSlideTransition = useCallback(
    (direction: 'next' | 'prev', action: () => void, customExitDistance?: number) => {
      if (pendingMidpointRef.current) {
        const prev = pendingMidpointRef.current;
        pendingMidpointRef.current = null;
        markInternalSkipExpected();
        prev.action();
      }

      cancelAnimation(trackTranslateX);
      cancelAnimation(trackOpacity);

      const token = ++buttonAnimTokenRef.current;
      pendingMidpointRef.current = { token, action };

      const width = trackAreaWidth.value > 0 ? trackAreaWidth.value : 300;
      const exitDistance = customExitDistance ?? width + 20;
      const exitTarget = direction === 'next' ? -exitDistance : exitDistance;
      const enterStart = direction === 'next' ? exitDistance : -exitDistance;

      const animId = activeAnimId.value + 1;
      activeAnimId.value = animId;
      isAnimatingChange.value = true;

      trackOpacity.value = withTiming(0, { duration: EXIT_DURATION });
      trackTranslateX.value = withTiming(
        exitTarget,
        { duration: EXIT_DURATION, easing: Easing.out(Easing.quad) },
        (finished) => {
          'worklet';
          if (finished && activeAnimId.value === animId) {
            trackTranslateX.value = enterStart;
            trackOpacity.value = 0.4;
            runOnJS(executeMidpointSkip)(token);
            trackTranslateX.value = withTiming(
              0,
              { duration: SNAP_DURATION, easing: SNAP_EASING },
              (snapDone) => {
                'worklet';
                if (snapDone && activeAnimId.value === animId) {
                  isAnimatingChange.value = false;
                }
              },
            );
            trackOpacity.value = withTiming(1, {
              duration: SNAP_DURATION,
              easing: SNAP_EASING,
            });
          } else if (activeAnimId.value === animId) {
            isAnimatingChange.value = false;
          }
        },
      );
    },
    [
      activeAnimId,
      executeMidpointSkip,
      isAnimatingChange,
      markInternalSkipExpected,
      trackAreaWidth,
      trackOpacity,
      trackTranslateX,
    ],
  );

  // Flush any in-flight button skip on unmount so a quick tap + screen transition never drops a skip
  useEffect(() => {
    return () => {
      if (pendingMidpointRef.current) {
        const pending = pendingMidpointRef.current;
        pendingMidpointRef.current = null;
        buttonAnimTokenRef.current += 1;
        pending.action();
      }
    };
  }, []);

  // Animate external/automatic track transitions (auto-advance, Bluetooth/notification/widget controls,
  // queue jumps, or starting a new track/album elsewhere in the app).
  useEffect(() => {
    const trackId = currentTrack?.id ?? null;
    if (!trackId) {
      prevTrackSnapshotRef.current = null;
      return;
    }

    const s = playerStore.getState();
    const nextIndex = s.currentTrackIndex;
    const nextQueue = s.queue;
    const nextQueueLength = nextQueue.length;
    const prev = prevTrackSnapshotRef.current;

    prevTrackSnapshotRef.current = {
      id: trackId,
      index: nextIndex,
      queueLength: nextQueueLength,
      queue: nextQueue,
    };

    if (!prev || prev.id === trackId) {
      return;
    }

    const expected = internalSkipExpectedRef.current;
    if (expected.remaining > 0 && Date.now() <= expected.expiresAt) {
      internalSkipExpectedRef.current = {
        remaining: expected.remaining - 1,
        expiresAt: expected.expiresAt,
      };
      return;
    }
    internalSkipExpectedRef.current = { remaining: 0, expiresAt: 0 };

    let direction: 'next' | 'prev' = 'next';
    if (prev.queue === nextQueue && prev.index != null && nextIndex != null) {
      const repeatMode = playbackSettingsStore.getState().repeatMode;
      const isWrapForward =
        repeatMode === 'all' && prev.index === prev.queueLength - 1 && nextIndex === 0 && prev.queueLength > 1;
      const isWrapBackward =
        repeatMode === 'all' && prev.index === 0 && nextIndex === nextQueueLength - 1 && nextQueueLength > 1;
      if (isWrapBackward) {
        direction = 'prev';
      } else if (!isWrapForward && nextIndex < prev.index) {
        direction = 'prev';
      }
    }

    const width = trackAreaWidth.value > 0 ? trackAreaWidth.value : 300;
    const enterDistance = width + 20;
    const startX = direction === 'next' ? enterDistance : -enterDistance;

    cancelAnimation(trackTranslateX);
    cancelAnimation(trackOpacity);
    const animId = activeAnimId.value + 1;
    activeAnimId.value = animId;
    isAnimatingChange.value = true;
    trackTranslateX.value = startX;
    trackOpacity.value = 0.4;

    trackTranslateX.value = withTiming(
      0,
      { duration: SNAP_DURATION, easing: SNAP_EASING },
      (snapDone) => {
        'worklet';
        if (snapDone && activeAnimId.value === animId) {
          isAnimatingChange.value = false;
        }
      },
    );
    trackOpacity.value = withTiming(1, {
      duration: SNAP_DURATION,
      easing: SNAP_EASING,
    });
  }, [
    currentTrack?.id,
    activeAnimId,
    isAnimatingChange,
    trackAreaWidth,
    trackOpacity,
    trackTranslateX,
  ]);

  const shouldPreviousRestartOnly = useCallback(() => {
    const s = playerStore.getState();
    const { skipPreviousBehavior, repeatMode } = playbackSettingsStore.getState();
    const willRestartSameTrack = skipPreviousBehavior === 'restart-or-previous' && s.position > 3;
    const canGoToPrevTrack = (s.currentTrackIndex != null && s.currentTrackIndex > 0) || repeatMode !== 'off';
    return { willRestartSameTrack, canGoToPrevTrack };
  }, []);

  const handleSkipNext = useCallback(() => {
    if (!canSkipNext) return;
    runSlideTransition('next', skipToNext);
  }, [canSkipNext, runSlideTransition]);

  const handleSkipPrev = useCallback(() => {
    if (!canSkipPrevious) return;
    const { willRestartSameTrack, canGoToPrevTrack } = shouldPreviousRestartOnly();
    if (willRestartSameTrack || !canGoToPrevTrack) {
      skipToPrevious();
      return;
    }
    runSlideTransition('prev', skipToPrevious);
  }, [canSkipPrevious, runSlideTransition, shouldPreviousRestartOnly]);

  const handleSwipeLeftEnd = useCallback(
    (exitDistance: number) => {
      runSlideTransition('next', skipToNext, exitDistance);
    },
    [runSlideTransition],
  );

  const handleSwipeRightEnd = useCallback(
    (exitDistance: number) => {
      const { willRestartSameTrack, canGoToPrevTrack } = shouldPreviousRestartOnly();

      if (willRestartSameTrack) {
        skipToPrevious();
        snapBackToRest();
        return;
      }

      if (!canGoToPrevTrack) {
        snapBackToRest();
        return;
      }

      runSlideTransition('prev', skipToPrevious, exitDistance);
    },
    [runSlideTransition, shouldPreviousRestartOnly, snapBackToRest],
  );

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
            runOnJS(handleSwipeLeftEnd)(exitDistance);
            gestureDirection.value = 0;
            return;
          }

          // Swipe right (previous track): check position > 3 via JS store read so gesture stays stable
          if (isSwipeRight) {
            runOnJS(handleSwipeRightEnd)(exitDistance);
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
    handleSwipeLeftEnd,
    handleSwipeRightEnd,
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
      {/* Isolated progress strip */}
      <MiniProgressStrip primaryColor={colors.primary} />

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
                <AtrumLogo size={16} color="rgba(150,150,150,1)" />
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
        <MiniPrevButton
          canSkipPrevious={canSkipPrevious}
          iconColor={colors.textPrimary}
          onSkipPrevious={handleSkipPrev}
        />

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
