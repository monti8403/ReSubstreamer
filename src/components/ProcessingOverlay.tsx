import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayoutMode } from '../hooks/useLayoutMode';
import { authStore } from '../store/authStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { playerStore } from '../store/playerStore';
import { processingOverlayStore } from '../store/processingOverlayStore';
import { BANNER_HEIGHT } from './DownloadBanner';
import { absoluteFill } from '../utils/styles';

const FADE_MS = 200;
const AUTO_DISMISS_MS = 3000;
const UNMOUNT_BUFFER_MS = 60;
const BOTTOM_OFFSET = 24;
const MINI_PLAYER_HEIGHT = 56;

export function ProcessingOverlay() {
  const status = processingOverlayStore((s) => s.status);
  const label = processingOverlayStore((s) => s.label);
  const hide = processingOverlayStore((s) => s.hide);

  const insets = useSafeAreaInsets();
  const isLoggedIn = authStore((s) => s.isLoggedIn);
  const hasCurrentTrack = playerStore((s) => s.currentTrack !== null);
  const isWide = useLayoutMode() === 'wide';
  const miniPlayerVisible = isLoggedIn && hasCurrentTrack && !isWide;
  const hasDownloads = musicCacheStore((s) =>
    s.downloadQueue.some(
      (q) => q.status === 'downloading' || q.status === 'queued' || q.status === 'error',
    ),
  );
  const bottomOffset =
    Math.max(insets.bottom, 16) +
    BOTTOM_OFFSET +
    (miniPlayerVisible ? MINI_PLAYER_HEIGHT : 0) +
    (hasDownloads ? BANNER_HEIGHT : 0);

  // The toast ONLY displays for real error states — never for loading or success!
  const shown = status === 'error' && !!label;

  const [mounted, setMounted] = useState(shown);
  const lastContent = useRef<{ label: string }>({ label: '' });
  if (shown) lastContent.current = { label };
  const display = shown ? { label } : lastContent.current;

  const opacity = useSharedValue(0);
  const translateY = useSharedValue(16);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasShown = useRef(false);

  useEffect(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }

    if (shown) {
      setMounted(true);
      if (!wasShown.current) {
        opacity.value = 0;
        translateY.value = 16;
      }
      wasShown.current = true;
      opacity.value = withTiming(1, { duration: FADE_MS });
      translateY.value = withSpring(0, { damping: 18, stiffness: 220 });

      dismissTimer.current = setTimeout(() => {
        hide();
      }, AUTO_DISMISS_MS);
    } else {
      wasShown.current = false;
      opacity.value = withTiming(0, { duration: FADE_MS });
      translateY.value = withTiming(16, { duration: FADE_MS });
      unmountTimer.current = setTimeout(
        () => setMounted(false),
        FADE_MS + UNMOUNT_BUFFER_MS,
      );
    }

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    };
  }, [shown, hide, opacity, translateY]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!mounted) return null;

  return (
    <Animated.View
      testID="processingOverlayBackdrop"
      style={[styles.wrapper, { bottom: bottomOffset }]}
      pointerEvents="box-none"
    >
      <Animated.View
        testID="processingOverlayCard"
        style={[styles.card, cardStyle]}
        pointerEvents="none"
      >
        <Ionicons name="alert-circle" size={18} color="#EF4444" />
        <Text style={styles.label} numberOfLines={2}>
          {display.label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    ...absoluteFill,
    top: undefined,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1E1E',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '600',
    lineHeight: 18,
    flexShrink: 1,
  },
});
