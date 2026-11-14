import Ionicons from "@react-native-vector-icons/ionicons/static";
import MaterialCommunityIcons from "@react-native-vector-icons/material-design-icons/static";
import * as Haptics from '@/utils/haptics';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated as RNAnimated, Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

const PRESS_IN_DURATION = 80;
const PRESS_OUT_DURATION = 150;
const PRESS_OPACITY = 0.7;

import { useTheme } from '../hooks/useTheme';

import { absoluteFill } from '../utils/styles';
import type { IoniconsName, MaterialCommunityIconsName } from '../utils/iconNames';
/* ------------------------------------------------------------------ */
/*  Module-level: active row tracking                                  */
/* ------------------------------------------------------------------ */

interface SwipeableMethods {
  close: () => void;
  openLeft: () => void;
  openRight: () => void;
  reset: () => void;
}

let _activeRef: SwipeableMethods | null = null;

/**
 * Close whichever SwipeableRow is currently peeked open (if any).
 * Call from list `onScrollBeginDrag` so open rows close on scroll.
 */
export function closeOpenRow() {
  _activeRef?.close();
  _activeRef = null;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SwipeAction {
  icon: IoniconsName | MaterialCommunityIconsName;
  /** Icon library to use. Defaults to `'ionicons'`. */
  iconFamily?: 'ionicons' | 'mdi';
  color: string;
  /** Text label displayed below the icon (e.g., "Queue", "Favorite"). */
  label?: string;
  onPress: () => void;
  /** When true the row is removed from the list after the action fires. */
  removesRow?: boolean;
}

export interface SwipeableRowProps {
  /** Actions revealed when swiping RIGHT (content moves right, buttons on left). */
  rightActions?: SwipeAction[];
  /** Actions revealed when swiping LEFT (content moves left, buttons on right). */
  leftActions?: SwipeAction[];
  /** Full swipe right auto-triggers the first rightAction. */
  enableFullSwipeRight?: boolean;
  /** Full swipe left auto-triggers the outermost (last) leftAction. */
  enableFullSwipeLeft?: boolean;
  /** Corner radius for the sliding content card (matches the row content's radius). */
  borderRadius?: number;
  /** Vertical spacing below the row, applied outside the rounded content area. */
  rowGap?: number;
  /** Background color shown at rest beneath children. Defaults to `colors.card` from the theme. Pass `'transparent'` to disable. */
  restingBackgroundColor?: string;
  /** Called when a long-press gesture activates. */
  onLongPress?: () => void;
  /** Called when the row is tapped. */
  onPress?: () => void;
  /**
   * When true the row reads as inert: swipe gestures are suppressed,
   * tap/long-press callbacks are not invoked, and the press-opacity
   * tween + selection haptic do not fire. The visual dimming itself is
   * the responsibility of the caller (apply opacity to the children
   * View) so the SwipeableRow primitive doesn't need a theme hook.
   */
  disabled?: boolean;
  /** When true, renders smaller action discs and typography suited for compact rows. */
  compact?: boolean;
  /** Preset dimensions for swipe action buttons. Overrides `compact` when set. */
  actionSize?: 'default' | 'queue' | 'compact';
  /** Horizontal drag distance (in points) required to activate the swipe. Defaults to 20. */
  dragOffset?: number;
  children: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ACTION_METRICS = {
  default: { width: 74, discSize: 46, iconSize: 22, fontSize: 12, gap: 4 },
  queue: { width: 64, discSize: 36, iconSize: 18, fontSize: 11, gap: 3 },
  compact: { width: 60, discSize: 34, iconSize: 18, fontSize: 10, gap: 2 },
} as const;

/** Progress threshold beyond which a swipe counts as "full" (1.5x action panel width). */
const FULL_SWIPE_PROGRESS_THRESHOLD = 1.5;

/** Fallback timeout (ms) to close the row if onSwipeableOpen never fires. */
const FULL_SWIPE_CLOSE_TIMEOUT = 500;

/**
 * Leftmost band (px) reserved for the OS back-swipe. A negative-left hitSlop
 * insets the pan's begin-region so the row swipe won't START in this band,
 * letting the native iOS edge-back recognizer win there. Taps are
 * unaffected. Tunable: raise if back-swipe still opens a row, lower if
 * near-edge row swipes feel unresponsive.
 */
const EDGE_BACK_GESTURE_WIDTH = 25;

/* ------------------------------------------------------------------ */
/*  SwipeableRow                                                       */
/* ------------------------------------------------------------------ */

export const SwipeableRow = memo(function SwipeableRow({
  rightActions = [],
  leftActions = [],
  enableFullSwipeRight = false,
  enableFullSwipeLeft = false,
  borderRadius = 16,
  rowGap = 0,
  restingBackgroundColor,
  onLongPress,
  onPress,
  disabled = false,
  compact = false,
  actionSize,
  dragOffset,
  children,
}: SwipeableRowProps) {
  const resolvedActionSize = actionSize ?? (compact ? 'compact' : 'default');
  const { colors } = useTheme();
  const effectiveRestingBg = restingBackgroundColor ?? colors.card;
  const swipeableRef = useRef<SwipeableMethods>(null);
  const isOpenRef = useRef(false);
  const pendingFullSwipeCloseRef = useRef(false);
  const pendingFullSwipeActionRef = useRef<SwipeAction | null>(null);
  const pendingFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasRight = rightActions.length > 0;
  const hasLeft = leftActions.length > 0;

  // SharedValues for UI-thread operations (haptic, icon pop, swipe bg) – race-free & 0 runOnJS per frame
  const fullSwipeRightTriggered = useSharedValue(false);
  const fullSwipeLeftTriggered = useSharedValue(false);
  const swipeProgress = useSharedValue(0);

  // JS refs for JS-thread reads (callbacks) – set via runOnJS to guarantee ordering
  const fullSwipeRightRef = useRef(false);
  const fullSwipeLeftRef = useRef(false);

  const setFullSwipeRight = useCallback((v: boolean) => {
    fullSwipeRightRef.current = v;
  }, []);

  const setFullSwipeLeft = useCallback((v: boolean) => {
    fullSwipeLeftRef.current = v;
  }, []);

  const clearFallbackTimer = useCallback(() => {
    if (pendingFallbackTimerRef.current !== null) {
      clearTimeout(pendingFallbackTimerRef.current);
      pendingFallbackTimerRef.current = null;
    }
  }, []);

  const swipeBgAnimatedStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, swipeProgress.value * 2),
  }));

  /* ---- Swipeable event handlers ---- */

  const handleOpenStartDrag = useCallback(() => {
    if (_activeRef && _activeRef !== swipeableRef.current) {
      _activeRef.close();
      _activeRef = null;
    }
  }, []);

  const triggerPendingAction = useCallback(() => {
    clearFallbackTimer();
    const pending = pendingFullSwipeActionRef.current;
    if (pending) {
      pendingFullSwipeActionRef.current = null;
      pending.onPress();
    }
  }, [clearFallbackTimer]);

  const handleSwipeableWillOpen = useCallback(
    (direction: 'left' | 'right') => {
      if (
        direction === 'right' &&
        enableFullSwipeRight &&
        fullSwipeRightRef.current
      ) {
        fullSwipeRightRef.current = false;
        const action = rightActions[0];
        if (!action) return;
        pendingFullSwipeActionRef.current = action;
        if (!action.removesRow) {
          pendingFullSwipeCloseRef.current = true;
          clearFallbackTimer();
          pendingFallbackTimerRef.current = setTimeout(() => {
            pendingFullSwipeCloseRef.current = false;
            swipeableRef.current?.close();
            triggerPendingAction();
          }, FULL_SWIPE_CLOSE_TIMEOUT);
        } else {
          clearFallbackTimer();
          pendingFallbackTimerRef.current = setTimeout(
            triggerPendingAction,
            FULL_SWIPE_CLOSE_TIMEOUT,
          );
        }
        return;
      }
      if (
        direction === 'left' &&
        enableFullSwipeLeft &&
        fullSwipeLeftRef.current
      ) {
        fullSwipeLeftRef.current = false;
        const action = leftActions[leftActions.length - 1];
        if (!action) return;
        pendingFullSwipeActionRef.current = action;
        if (!action.removesRow) {
          pendingFullSwipeCloseRef.current = true;
          clearFallbackTimer();
          pendingFallbackTimerRef.current = setTimeout(() => {
            pendingFullSwipeCloseRef.current = false;
            swipeableRef.current?.close();
            triggerPendingAction();
          }, FULL_SWIPE_CLOSE_TIMEOUT);
        } else {
          clearFallbackTimer();
          pendingFallbackTimerRef.current = setTimeout(
            triggerPendingAction,
            FULL_SWIPE_CLOSE_TIMEOUT,
          );
        }
      }
    },
    [
      enableFullSwipeRight,
      enableFullSwipeLeft,
      rightActions,
      leftActions,
      clearFallbackTimer,
      triggerPendingAction,
    ],
  );

  useEffect(() => {
    return () => {
      clearFallbackTimer();
      pendingFullSwipeCloseRef.current = false;
      pendingFullSwipeActionRef.current = null;
      if (_activeRef === swipeableRef.current) {
        _activeRef = null;
      }
    };
  }, [clearFallbackTimer]);

  const handleSwipeableOpen = useCallback(() => {
    clearFallbackTimer();
    const pending = pendingFullSwipeActionRef.current;
    if (pendingFullSwipeCloseRef.current) {
      pendingFullSwipeCloseRef.current = false;
      swipeableRef.current?.close();
      // Wait for handleSwipeableClose to run non-removing mutations (e.g. moveQueueItemToUserQueue)
      // so row reorder animations never fight the swipe spring.
      if (pending) {
        pendingFallbackTimerRef.current = setTimeout(triggerPendingAction, 260);
      }
      return;
    }
    if (pending?.removesRow) {
      triggerPendingAction();
      return;
    }
    isOpenRef.current = true;
    _activeRef = swipeableRef.current;
  }, [clearFallbackTimer, triggerPendingAction]);

  const handleSwipeableClose = useCallback(() => {
    isOpenRef.current = false;
    fullSwipeRightRef.current = false;
    fullSwipeLeftRef.current = false;
    pendingFullSwipeCloseRef.current = false;
    swipeProgress.value = 0;
    if (_activeRef === swipeableRef.current) {
      _activeRef = null;
    }
    triggerPendingAction();
  }, [swipeProgress, triggerPendingAction]);

  /* ---- Tap / long-press handlers ---- */

  // Use RN core Animated for press opacity — runs on native driver but does
  // NOT participate in Reanimated's shadow-tree commit-hook walk, reducing
  // per-row memory pressure in long lists.
  const pressOpacityAnim = useRef(new RNAnimated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    if (disabled) return;
    if (isOpenRef.current) return;
    RNAnimated.timing(pressOpacityAnim, {
      toValue: PRESS_OPACITY,
      duration: PRESS_IN_DURATION,
      useNativeDriver: true,
    }).start();
  }, [disabled, pressOpacityAnim]);

  const handlePressOut = useCallback(() => {
    if (disabled) return;
    RNAnimated.timing(pressOpacityAnim, {
      toValue: 1,
      duration: PRESS_OUT_DURATION,
      useNativeDriver: true,
    }).start();
  }, [disabled, pressOpacityAnim]);

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (isOpenRef.current) {
      swipeableRef.current?.close();
      return;
    }
    Haptics.selectionAsync();
    onPress?.();
  }, [disabled, onPress]);

  const handleLongPress = useCallback(() => {
    if (disabled) return;
    if (isOpenRef.current) {
      swipeableRef.current?.close();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onLongPress?.();
  }, [disabled, onLongPress]);

  /* ---- Action panel render functions ---- */

  const hasFullSwipe =
    (enableFullSwipeRight && hasRight) || (enableFullSwipeLeft && hasLeft);
  const effectiveFriction = hasFullSwipe ? 1.15 : 1.35;
  const effectiveOvershootFriction = hasFullSwipe ? 1 : 4;

  // renderLeftActions = shown when swiping RIGHT = our rightActions
  // Outermost action is index 0 (left edge of screen).
  const renderLeftPanel = useCallback(
    (
      progress: SharedValue<number>,
      _translation: SharedValue<number>,
      methods: SwipeableMethods,
    ) => (
      <ActionPanel
        actions={rightActions}
        progress={progress}
        swipeProgress={swipeProgress}
        methods={methods}
        enableFullSwipe={enableFullSwipeRight}
        fullSwipeActionIndex={0}
        fullSwipeTriggered={fullSwipeRightTriggered}
        onFullSwipeChange={setFullSwipeRight}
        actionSize={resolvedActionSize}
      />
    ),
    [rightActions, enableFullSwipeRight, fullSwipeRightTriggered, setFullSwipeRight, swipeProgress, resolvedActionSize],
  );

  // renderRightActions = shown when swiping LEFT = our leftActions
  // Outermost action is the last index (right edge of screen).
  const renderRightPanel = useCallback(
    (
      progress: SharedValue<number>,
      _translation: SharedValue<number>,
      methods: SwipeableMethods,
    ) => (
      <ActionPanel
        actions={leftActions}
        progress={progress}
        swipeProgress={swipeProgress}
        methods={methods}
        enableFullSwipe={enableFullSwipeLeft}
        fullSwipeActionIndex={leftActions.length - 1}
        fullSwipeTriggered={fullSwipeLeftTriggered}
        onFullSwipeChange={setFullSwipeLeft}
        actionSize={resolvedActionSize}
      />
    ),
    [leftActions, enableFullSwipeLeft, fullSwipeLeftTriggered, setFullSwipeLeft, swipeProgress, resolvedActionSize],
  );

  const swipeContainerStyle = useMemo(
    () => ({
      backgroundColor: 'transparent' as const,
      marginBottom: rowGap || undefined,
    }),
    [rowGap],
  );

  const contentClipStyle = useMemo(
    () => ({ borderRadius, overflow: 'hidden' as const }),
    [borderRadius],
  );

  const effectiveDragOffset = dragOffset ?? 6;

  return (
    <ReanimatedSwipeable
      ref={swipeableRef as any}
      enabled={!disabled}
      hitSlop={{ left: -EDGE_BACK_GESTURE_WIDTH }}
      friction={effectiveFriction}
      overshootFriction={effectiveOvershootFriction}
      dragOffsetFromLeftEdge={effectiveDragOffset}
      dragOffsetFromRightEdge={effectiveDragOffset}
      leftThreshold={32}
      rightThreshold={32}
      overshootLeft={hasRight}
      overshootRight={hasLeft}
      renderLeftActions={hasRight && !disabled ? renderLeftPanel : undefined}
      renderRightActions={hasLeft && !disabled ? renderRightPanel : undefined}
      onSwipeableOpenStartDrag={handleOpenStartDrag}
      onSwipeableWillOpen={handleSwipeableWillOpen}
      onSwipeableOpen={handleSwipeableOpen}
      onSwipeableClose={handleSwipeableClose}
      containerStyle={swipeContainerStyle}
    >
      <Pressable
        onPress={handlePress}
        onLongPress={onLongPress ? handleLongPress : undefined}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        delayLongPress={400}
      >
        <RNAnimated.View style={[contentClipStyle, { opacity: pressOpacityAnim }]}>
          {effectiveRestingBg !== 'transparent' && (
            <View style={[styles.swipeBg, { backgroundColor: effectiveRestingBg }]} />
          )}
          <Animated.View
            style={[styles.swipeBg, { backgroundColor: colors.inputBg }, swipeBgAnimatedStyle]}
          />
          {children}
        </RNAnimated.View>
      </Pressable>
    </ReanimatedSwipeable>
  );
});

/* ------------------------------------------------------------------ */
/*  ActionPanel – row of action buttons behind the swiped content      */
/* ------------------------------------------------------------------ */

type ResolvedActionSize = 'default' | 'queue' | 'compact';

interface ActionPanelProps {
  actions: SwipeAction[];
  progress: SharedValue<number>;
  swipeProgress: SharedValue<number>;
  methods: SwipeableMethods;
  enableFullSwipe: boolean;
  /** Which action index receives the pop animation on full swipe. */
  fullSwipeActionIndex: number;
  fullSwipeTriggered: SharedValue<boolean>;
  onFullSwipeChange: (triggered: boolean) => void;
  actionSize: ResolvedActionSize;
}

function ActionPanel({
  actions,
  progress,
  swipeProgress,
  methods,
  enableFullSwipe,
  fullSwipeActionIndex,
  fullSwipeTriggered,
  onFullSwipeChange,
  actionSize,
}: ActionPanelProps) {
  const iconPopScale = useSharedValue(1);

  // Keep swipe background progress strictly on the UI thread (zero runOnJS calls per frame).
  useAnimatedReaction(
    () => progress.value,
    (current) => {
      swipeProgress.value = current;
    },
  );

  useAnimatedReaction(
    () => progress.value,
    (current, previous) => {
      if (!enableFullSwipe) return;

      const prev = previous ?? 0;

      if (
        current >= FULL_SWIPE_PROGRESS_THRESHOLD &&
        prev < FULL_SWIPE_PROGRESS_THRESHOLD
      ) {
        fullSwipeTriggered.value = true;
        runOnJS(onFullSwipeChange)(true);
        runOnJS(Haptics.selectionAsync)();
        iconPopScale.value = withSequence(
          withTiming(1.35, { duration: 120 }),
          withTiming(1.22, { duration: 100 }),
          withTiming(1.35, { duration: 100 }),
          withTiming(1, { duration: 180 }),
        );
      } else if (
        current < FULL_SWIPE_PROGRESS_THRESHOLD &&
        prev >= FULL_SWIPE_PROGRESS_THRESHOLD
      ) {
        fullSwipeTriggered.value = false;
        runOnJS(onFullSwipeChange)(false);
      }
    },
  );

  return (
    <View style={styles.actionPanel}>
      {actions.map((action, index) => (
        <ActionButton
          key={index}
          action={action}
          progress={progress}
          methods={methods}
          popScale={enableFullSwipe && index === fullSwipeActionIndex ? iconPopScale : undefined}
          actionSize={actionSize}
        />
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  ActionButton – circular disc with icon + label                     */
/* ------------------------------------------------------------------ */

interface ActionButtonProps {
  action: SwipeAction;
  progress: SharedValue<number>;
  methods: SwipeableMethods;
  popScale?: SharedValue<number>;
  actionSize: ResolvedActionSize;
}

const ActionButton = memo(function ActionButton({
  action,
  progress,
  methods,
  popScale,
  actionSize,
}: ActionButtonProps) {
  const discStyle = useAnimatedStyle(() => {
    const baseScale = interpolate(
      progress.value,
      [0, 0.6, 1],
      [0.5, 1, 1],
      'clamp',
    );
    const extra = popScale ? popScale.value : 1;
    return {
      transform: [{ scale: baseScale * extra }],
      opacity: interpolate(progress.value, [0, 0.3, 1], [0, 1, 1], 'clamp'),
    };
  });

  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3, 1], [0, 1, 1], 'clamp'),
  }));

  const handlePress = useCallback(() => {
    action.onPress();
    methods.close();
  }, [action, methods]);

  const metrics = ACTION_METRICS[actionSize];

  return (
    <Pressable
      onPress={handlePress}
      style={[
        styles.actionButton,
        { width: metrics.width, gap: metrics.gap },
      ]}
    >
      <Animated.View
        style={[
          styles.iconDisc,
          {
            backgroundColor: action.color,
            width: metrics.discSize,
            height: metrics.discSize,
            borderRadius: metrics.discSize / 2,
          },
          discStyle,
        ]}
      >
        {action.iconFamily === 'mdi' ? (
          <MaterialCommunityIcons name={action.icon as MaterialCommunityIconsName} size={metrics.iconSize} color="#fff" />
        ) : (
          <Ionicons name={action.icon as IoniconsName} size={metrics.iconSize} color="#fff" />
        )}
      </Animated.View>
      {action.label != null && (
        <Animated.Text
          style={[
            styles.actionLabel,
            { fontSize: metrics.fontSize },
            labelStyle,
          ]}
          numberOfLines={1}
        >
          {action.label}
        </Animated.Text>
      )}
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  swipeBg: {
    ...absoluteFill,
  },
  actionPanel: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    width: ACTION_METRICS.default.width,
    justifyContent: 'center',
    alignItems: 'center',
    gap: ACTION_METRICS.default.gap,
  },
  iconDisc: {
    width: ACTION_METRICS.default.discSize,
    height: ACTION_METRICS.default.discSize,
    borderRadius: ACTION_METRICS.default.discSize / 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: {
    color: '#fff',
    fontSize: ACTION_METRICS.default.fontSize,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
});
