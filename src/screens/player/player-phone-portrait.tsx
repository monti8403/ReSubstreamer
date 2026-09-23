import Ionicons from "@react-native-vector-icons/ionicons/static";
import { FlashList } from '@shopify/flash-list';
import ReorderableList, { type ReorderableListReorderEvent } from 'react-native-reorderable-list';
import { Stack, useNavigation, useRouter } from 'expo-router';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, Pressable as GHPressable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { AlbumInfoContent } from '@/components/AlbumInfoContent';
import { LyricsContent } from '@/components/LyricsContent';
import { BookmarkButton } from '@/components/BookmarkButton';
import { CachedImage } from '@/components/CachedImage';
import { CastButton } from '@/components/RoutePicker';
import { FavoriteButton } from '@/components/FavoriteButton';
import { EmptyState } from '@/components/EmptyState';
import { MarqueeText } from '@/components/MarqueeText';
import { MoreOptionsButton } from '@/components/MoreOptionsButton';
import { PlaybackRateButton } from '@/components/PlaybackRateButton';
import { PlayerProgressBar } from '@/components/PlayerProgressBar';
import { PlayerTabBar, type PlayerTab } from '@/components/PlayerTabBar';
import { RepeatButton } from '@/components/RepeatButton';
import { ShuffleButton } from '@/components/ShuffleButton';
import { ShuffleOverlay } from '@/components/ShuffleOverlay';
import { SkipIntervalButton } from '@/components/SkipIntervalButton';
import { SleepTimerButton } from '@/components/SleepTimerButton';
import { SleepTimerCapsule } from '@/components/SleepTimerCapsule';
import { PlaybackSourceBadge } from '@/components/PlaybackSourceBadge';
import { QueueItemRow } from '@/components/QueueItemRow';
import { QueueSectionHeader } from '@/components/player/QueueSectionHeader';
import { closeOpenRow } from '@/components/SwipeableRow';
import { type ThemeColors } from '@/constants/theme';
import { useCanSkip } from '@/hooks/useCanSkip';
import { PlayerCoverGradient } from '@/components/player/PlayerCoverGradient';
import { useSongCoverArt } from '@/hooks/useSongCoverArt';
import { usePlayerActions } from '@/hooks/usePlayerActions';
import { usePlaybackState } from '@/hooks/usePlaybackState';
import { useShuffleOverlay } from '@/hooks/useShuffleOverlay';
import { getPlayerSize } from '@/hooks/playerSize';
import { useTheme } from '@/hooks/useTheme';
import { offlineModeStore } from '@/store/offlineModeStore';
import {
  clearQueue,
  clearUserQueue,
  retryPlayback,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
} from '@/services/playerService';
import { sanitizeBiographyText } from '@/utils/formatters';
import { type Child } from '@/services/subsonicService';
import { usePlayerAlbumInfo } from '@/hooks/usePlayerAlbumInfo';
import { usePlayerLyrics, type PlayerLyricsResult } from '@/hooks/usePlayerLyrics';
import { playbackSettingsStore } from '@/store/playbackSettingsStore';
import { moreOptionsStore } from '@/store/moreOptionsStore';
import { playerStore } from '@/store/playerStore';
import { mixHexColors } from '@/utils/colors';
import { reorderQueue } from '@/services/moreOptionsService';


import { absoluteFill } from '@/utils/styles';
const HERO_PADDING = 32;
const HERO_COVER_SIZE = 600;
const HEADER_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;

const TAB_FADE_DURATION = 300;
const TAB_FADE_EASING = Easing.out(Easing.cubic);
const TAB_SLIDE_DISTANCE = 12;

/** Static content inset for the queue list — module-scope so FlashList isn't
 *  handed a fresh object on every parent re-render. */
const QUEUE_CONTENT_CONTAINER_STYLE = { paddingBottom: 12 } as const;

export function PlayerPhonePortrait() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const navigation = useNavigation();
  const router = useRouter();
  const currentTrack = playerStore((s) => s.currentTrack);
  const songCoverArtId = useSongCoverArt(currentTrack);
  const currentTrackIndex = playerStore((s) => s.currentTrackIndex);
  const queue = playerStore((s) => s.queue);
  const queueLoading = playerStore((s) => s.queueLoading);

  const onClose = useCallback(() => router.back(), [router]);

  // Auto-dismiss when the queue is externally cleared (e.g. offline mode
  // removes all non-downloaded tracks while this screen is open).
  const [wasPopulated, setWasPopulated] = useState(false);
  useEffect(() => {
    if (currentTrack) {
      setWasPopulated(true);
    } else if (wasPopulated) {
      onClose();
    }
  }, [currentTrack, wasPopulated, onClose]);



  const offlineMode = offlineModeStore((s) => s.offlineMode);

  // Lyrics are fetched at the screen, not inside the lazily-mounted Lyrics tab,
  // so they load whenever the player is open rather than only once it is selected.
  const {
    entry: lyricsEntry,
    loading: lyricsLoading,
    error: lyricsError,
    handleRetry: handleRetryLyrics,
  } = usePlayerLyrics(
    currentTrack?.id ?? null,
    currentTrack?.artist,
    currentTrack?.title,
    true,
  );

  /* ---- Tab state ---- */
  const [activeTab, setActiveTab] = useState<PlayerTab>('player');
  const [mountedTabs, setMountedTabs] = useState<Set<PlayerTab>>(() => new Set(['player']));
  const listRef = useRef<any>(null);

  // Ensure tab is mounted when selected
  useEffect(() => {
    if (!mountedTabs.has(activeTab)) {
      setMountedTabs((prev) => new Set(prev).add(activeTab));
    }
    if (activeTab === 'queue') {
      listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    }
  }, [activeTab, mountedTabs]);

  const ensureQueueMounted = useCallback(() => {
    setMountedTabs((prev) => (prev.has('queue') ? prev : new Set(prev).add('queue')));
    setVisibleTabs((prev) => (prev.has('queue') ? prev : new Set(prev).add('queue')));
  }, []);

  /* ---- Tab crossfade & drawer animations ---- */
  const playerOpacity = useSharedValue(1);
  const queueOpacity = useSharedValue(0);
  const queueTranslateY = useSharedValue(windowHeight);
  const infoOpacity = useSharedValue(0);
  const lyricsOpacity = useSharedValue(0);
  const isTransitioningQueue = useSharedValue(false);

  const ensurePlayerMounted = useCallback(() => {
    setMountedTabs((prev) => (prev.has('player') ? prev : new Set(prev).add('player')));
    setVisibleTabs((prev) => (prev.has('player') ? prev : new Set(prev).add('player')));
  }, []);

  // Screen-level vertical swipe:
  // - Swipe DOWN anywhere on player -> dismisses player to mini-player (onClose)
  // - Swipe UP anywhere on player -> opens queue drawer sheet (setActiveTab('queue'))
  const screenSwipeGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY([-14, 18])
      .failOffsetX([-35, 35])
      .cancelsTouchesInView(false)
      .onStart(() => {
        'worklet';
      })
      .onUpdate((event) => {
        'worklet';
        if (isTransitioningQueue.value) return;
        if (event.translationY < 0) {
          runOnJS(ensureQueueMounted)();
          queueTranslateY.value = Math.max(0, windowHeight + event.translationY);
          queueOpacity.value = interpolate(
            queueTranslateY.value,
            [0, windowHeight],
            [1, 0.4],
          );
        }
      })
      .onEnd((event) => {
        'worklet';
        if (isTransitioningQueue.value) return;
        if (event.translationY < -35 || event.velocityY < -220) {
          isTransitioningQueue.value = true;
          queueTranslateY.value = withSpring(
            0,
            { damping: 28, stiffness: 220, mass: 0.8 },
            (finished) => {
              if (finished) {
                runOnJS(setActiveTab)('queue');
                isTransitioningQueue.value = false;
              }
            },
          );
          queueOpacity.value = withTiming(1, { duration: 180 });
        } else if (event.translationY > 40 || event.velocityY > 240) {
          runOnJS(onClose)();
        } else {
          queueTranslateY.value = withTiming(windowHeight, {
            duration: 220,
            easing: Easing.out(Easing.cubic),
          });
          queueOpacity.value = withTiming(0, { duration: 180 });
        }
      });
  }, [windowHeight, ensureQueueMounted, queueTranslateY, queueOpacity, onClose, isTransitioningQueue]);

  const isQueueAtTop = useSharedValue(true);
  const handleQueueScroll = useCallback((event: any) => {
    isQueueAtTop.value = (event.nativeEvent?.contentOffset?.y ?? 0) <= 0;
  }, [isQueueAtTop]);

  // Swipe down gesture to dismiss queue back to player (active when list is at top or dragging handle)
  const queueSwipeDownGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY(8)
      .failOffsetY(-12)
      .failOffsetX([-45, 45])
      .onStart(() => {
        'worklet';
        if (isTransitioningQueue.value) return;
        runOnJS(ensurePlayerMounted)();
      })
      .onUpdate((event) => {
        'worklet';
        if (isTransitioningQueue.value) return;
        if (isQueueAtTop.value && event.translationY > 0) {
          queueTranslateY.value = event.translationY;
          queueOpacity.value = interpolate(
            queueTranslateY.value,
            [0, windowHeight],
            [1, 0.35],
          );
        }
      })
      .onEnd((event) => {
        'worklet';
        if (isTransitioningQueue.value) return;
        if (isQueueAtTop.value && (event.translationY > 55 || event.velocityY > 240)) {
          isTransitioningQueue.value = true;
          queueTranslateY.value = withTiming(
            windowHeight,
            { duration: 240, easing: Easing.bezier(0.25, 1, 0.5, 1) },
            (finished) => {
              if (finished) {
                runOnJS(setActiveTab)('player');
                isTransitioningQueue.value = false;
              }
            },
          );
          queueOpacity.value = withTiming(0, { duration: 200 });
        } else {
          queueTranslateY.value = withSpring(0, {
            damping: 24,
            stiffness: 220,
            mass: 0.8,
          });
          queueOpacity.value = withTiming(1, { duration: 180 });
        }
      });
  }, [windowHeight, isQueueAtTop, queueTranslateY, queueOpacity, ensurePlayerMounted, isTransitioningQueue]);

  // Android hardware back button handler: if queue is open, close queue and return to player
  useEffect(() => {
    if (activeTab !== 'queue') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setActiveTab('player');
      return true;
    });
    return () => subscription.remove();
  }, [activeTab]);

  useEffect(() => {
    const config = { duration: TAB_FADE_DURATION, easing: TAB_FADE_EASING };
    if (activeTab === 'info' || activeTab === 'lyrics') {
      playerOpacity.value = withTiming(0, config);
    } else {
      // Keep player panel visible during queue transitions so queueTranslateY drives the synergy animation
      playerOpacity.value = withTiming(1, config);
    }
    infoOpacity.value = withTiming(activeTab === 'info' ? 1 : 0, config);
    lyricsOpacity.value = withTiming(activeTab === 'lyrics' ? 1 : 0, config);

    if (activeTab === 'queue') {
      isTransitioningQueue.value = false;
      queueTranslateY.value = withSpring(0, {
        damping: 28,
        stiffness: 220,
        mass: 0.8,
      });
      queueOpacity.value = withTiming(1, { duration: 200 });
    } else {
      isTransitioningQueue.value = false;
      queueTranslateY.value = withTiming(windowHeight, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      queueOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [activeTab, windowHeight, playerOpacity, infoOpacity, lyricsOpacity, queueTranslateY, queueOpacity, isTransitioningQueue]);

  // Track which tabs should be visible in the compositor.
  const [visibleTabs, setVisibleTabs] = useState<Set<PlayerTab>>(
    () => new Set([activeTab]),
  );
  useEffect(() => {
    setVisibleTabs((prev) => {
      const next = new Set(prev);
      next.add(activeTab);
      if (activeTab === 'queue') next.add('player');
      if (activeTab === 'player') next.add('queue');
      return next;
    });
    const timer = setTimeout(() => {
      setVisibleTabs(new Set([activeTab]));
    }, TAB_FADE_DURATION + 60);
    return () => clearTimeout(timer);
  }, [activeTab]);

  const playerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: playerOpacity.value,
    transform: [{ translateY: interpolate(playerOpacity.value, [0, 1], [TAB_SLIDE_DISTANCE, 0]) }],
  }));
  const queueAnimatedStyle = useAnimatedStyle(() => ({
    opacity: queueOpacity.value,
    transform: [{ translateY: queueTranslateY.value }],
  }));
  const infoAnimatedStyle = useAnimatedStyle(() => ({
    opacity: infoOpacity.value,
    transform: [{ translateY: interpolate(infoOpacity.value, [0, 1], [TAB_SLIDE_DISTANCE, 0]) }],
  }));
  const lyricsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: lyricsOpacity.value,
    transform: [{ translateY: interpolate(lyricsOpacity.value, [0, 1], [TAB_SLIDE_DISTANCE, 0]) }],
  }));

  /* ---- Header: dismiss button + more options ---- */
  useEffect(() => {
    if (Platform.OS === 'ios') return;
    navigation.setOptions({
      headerLeft: () => (
        <GHPressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => [{ opacity: 1 }, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-down" size={28} color={colors.textPrimary} />
        </GHPressable>
      ),
      headerRight: () =>
        currentTrack ? (
          <MoreOptionsButton
            onPress={() =>
              moreOptionsStore.getState().show({ type: 'song', item: currentTrack }, 'player-phone-portrait')
            }
            color={colors.textPrimary}
          />
        ) : null,
    });
  }, [currentTrack, navigation, onClose, colors.textPrimary]);

  const onClearConfirmed = useCallback(() => {
    onClose();
    setTimeout(() => clearQueue(), 350);
  }, [onClose]);

  const {
    handleSeek,
    handleQueueItemPress,
    handleQueueItemLongPress,
    handleShareQueue,
    handleClearQueue,
  } = usePlayerActions({ source: 'player-phone-portrait', onClearConfirmed });

  const {
    shuffling,
    handleShuffle,
    overlayStyle,
    spinStyle,
  } = useShuffleOverlay();



  // Muted primary for active queue item highlight
  const queueColors = useMemo(() => ({
    ...colors,
    primary: mixHexColors(colors.primary, colors.textPrimary, 0.45),
  }), [colors]);

  const userQueueTrackIds = playerStore((s) => s.userQueueTrackIds);

  const visibleQueue = useMemo(() => {
    const startIdx = currentTrackIndex ?? 0;
    return queue.slice(startIdx);
  }, [queue, currentTrackIndex]);

  const userQueueCount = useMemo(() => {
    const upcoming = visibleQueue.slice(1);
    return upcoming.filter((item) => userQueueTrackIds.includes(item.id)).length;
  }, [visibleQueue, userQueueTrackIds]);

  const handleClearUserQueue = useCallback(() => {
    void clearUserQueue();
  }, []);

  const pendingScrollToTopOnSelectRef = useRef(false);

  useEffect(() => {
    if (pendingScrollToTopOnSelectRef.current) {
      pendingScrollToTopOnSelectRef.current = false;
      listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
    }
  }, [currentTrack?.id, currentTrackIndex]);

  const onQueueItemPressWithScroll = useCallback(
    (targetAbsoluteIndex: number) => {
      if (targetAbsoluteIndex !== currentTrackIndex) {
        pendingScrollToTopOnSelectRef.current = true;
      }
      handleQueueItemPress(targetAbsoluteIndex);
    },
    [currentTrackIndex, handleQueueItemPress],
  );

  const renderQueueItem = useCallback(
    ({ item, index: relativeIndex }: { item: Child; index: number }) => {
      const absoluteIndex = (currentTrackIndex ?? 0) + relativeIndex;
      const isNowPlayingHeader = relativeIndex === 0;
      const isCurrentItemInUserQueue = userQueueTrackIds.includes(item.id);
      const prevItem = relativeIndex > 0 ? visibleQueue[relativeIndex - 1] : null;
      const isPrevInUserQueue = prevItem ? userQueueTrackIds.includes(prevItem.id) : false;

      const isUserQueueHeader =
        relativeIndex > 0 &&
        isCurrentItemInUserQueue &&
        (relativeIndex === 1 || !isPrevInUserQueue);

      const isContextQueueHeader =
        relativeIndex > 0 &&
        !isCurrentItemInUserQueue &&
        (relativeIndex === 1 || isPrevInUserQueue);

      return (
        <View>
          {isNowPlayingHeader && (
            <QueueSectionHeader
              title={t('nowPlayingHeader')}
              colors={colors}
            />
          )}
          {isUserQueueHeader && (
            <QueueSectionHeader
              title={t('userQueue')}
              count={userQueueCount}
              onClear={handleClearUserQueue}
              colors={colors}
            />
          )}
          {isContextQueueHeader && (
            <QueueSectionHeader
              title={t('nextUp')}
              colors={colors}
            />
          )}
          <QueueItemRow
            track={item}
            index={absoluteIndex}
            isActive={relativeIndex === 0}
            colors={queueColors}
            onPress={onQueueItemPressWithScroll}
            onLongPress={handleQueueItemLongPress}
          />
        </View>
      );
    },
    [
      currentTrackIndex,
      userQueueTrackIds,
      userQueueCount,
      visibleQueue,
      queueColors,
      colors,
      onQueueItemPressWithScroll,
      handleQueueItemLongPress,
      handleClearUserQueue,
      t,
    ],
  );

  const keyExtractor = useCallback(
    (item: Child) => (item as any)._queueKey || item.id,
    [],
  );

  const handleReorderQueue = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      const offset = currentTrackIndex ?? 0;
      void reorderQueue(offset + from, offset + to);
    },
    [currentTrackIndex],
  );

  const queueListHeader = useMemo(
    () => (
      <QueueHeader
        colors={colors}
        handleClearQueue={handleClearQueue}
        handleShuffle={handleShuffle}
        handleShareQueue={handleShareQueue}
        shuffling={shuffling}
        queueLength={visibleQueue.length}
        swipeDownGesture={queueSwipeDownGesture}
      />
    ),
    [colors, handleClearQueue, handleShuffle, handleShareQueue, shuffling, visibleQueue.length, queueSwipeDownGesture],
  );

  const headerTopPadding = Platform.OS === 'ios'
    ? insets.top + HEADER_BAR_HEIGHT
    : insets.top + HEADER_BAR_HEIGHT;

  if (!currentTrack) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="musical-notes-outline"
          title={t('nothingPlaying')}
          subtitle={t('nothingPlayingSubtitle')}
        />
      </View>
    );
  }

  return (
    <>
      {Platform.OS === 'ios' && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="chevron.down" onPress={onClose} />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              icon="ellipsis"
              onPress={() => moreOptionsStore.getState().show({ type: 'song', item: currentTrack! }, 'player-phone-portrait')}
              hidden={!currentTrack}
            />
          </Stack.Toolbar>
        </>
      )}
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Gradient background */}
        <View style={[absoluteFill, { backgroundColor: colors.background }]} />
        <PlayerCoverGradient
          coverArtId={songCoverArtId}
          endColor={colors.background}
        />

        {/* Content area with tab switching */}
        <View style={styles.contentArea}>
          {/* Player tab — vertically centered across full area */}
          <Animated.View
            style={[
              styles.tabPanel,
              Platform.OS === 'android' && { top: headerTopPadding },
              !visibleTabs.has('player') && styles.hiddenTab,
              playerAnimatedStyle,
            ]}
            pointerEvents={activeTab === 'player' ? 'auto' : 'none'}
          >
            <View style={{ flex: 1 }}>
              <PlayerContent
                currentTrack={currentTrack}
                colors={colors}
                queueLoading={queueLoading}
                handleSeek={handleSeek}
                handleShuffle={handleShuffle}
                shuffling={shuffling}
                onSwitchToQueue={() => setActiveTab('queue')}
                screenSwipeGesture={screenSwipeGesture}
                queueTranslateY={queueTranslateY}
              />
            </View>
          </Animated.View>

          {/* Queue tab — below header, slides up as sheet */}
          <Animated.View
            style={[
              styles.tabPanel,
              {
                top: headerTopPadding,
                zIndex: 10,
                backgroundColor: colors.background,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: -6 },
                shadowOpacity: 0.25,
                shadowRadius: 16,
                elevation: 16,
                overflow: 'hidden',
              },
              !visibleTabs.has('queue') && styles.hiddenTab,
              queueAnimatedStyle,
            ]}
            pointerEvents={activeTab === 'queue' ? 'auto' : 'none'}
          >
            {mountedTabs.has('queue') && (
              <GestureDetector gesture={queueSwipeDownGesture}>
                <ReorderableList
                  ref={listRef}
                  data={visibleQueue}
                  renderItem={renderQueueItem}
                  keyExtractor={keyExtractor}
                  onReorder={handleReorderQueue}
                  ListHeaderComponent={queueListHeader}
                  onScroll={handleQueueScroll}
                  onScrollBeginDrag={closeOpenRow}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={QUEUE_CONTENT_CONTAINER_STYLE}
                  windowSize={7}
                  maxToRenderPerBatch={10}
                  initialNumToRender={12}
                  updateCellsBatchingPeriod={50}
                />
              </GestureDetector>
            )}
          </Animated.View>

          {/* Album Info tab — below header */}
          <Animated.View
            style={[
              styles.tabPanel,
              { top: headerTopPadding },
              !visibleTabs.has('info') && styles.hiddenTab,
              infoAnimatedStyle,
            ]}
            pointerEvents={activeTab === 'info' ? 'auto' : 'none'}
          >
            {mountedTabs.has('info') && (
              <AlbumInfoTab currentTrack={currentTrack} colors={colors} />
            )}
          </Animated.View>

          {/* Lyrics tab — below header */}
          <Animated.View
            style={[
              styles.tabPanel,
              { top: headerTopPadding },
              !visibleTabs.has('lyrics') && styles.hiddenTab,
              lyricsAnimatedStyle,
            ]}
            pointerEvents={activeTab === 'lyrics' ? 'auto' : 'none'}
          >
            {mountedTabs.has('lyrics') && currentTrack && (
              <LyricsTab
                currentTrack={currentTrack}
                colors={colors}
                entry={lyricsEntry}
                loading={lyricsLoading}
                error={lyricsError}
                handleRetry={handleRetryLyrics}
              />
            )}
          </Animated.View>
        </View>

        {/* Tab bar */}
        <View style={{ paddingBottom: insets.bottom }}>
          <PlayerTabBar activeTab={activeTab} onSelect={setActiveTab} colors={colors} offlineMode={offlineMode} />
        </View>

        {/* Shuffle overlay */}
        <ShuffleOverlay
          visible={shuffling}
          overlayStyle={overlayStyle}
          spinStyle={spinStyle}
          colors={colors}
        />
      </View>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Player content (hero, controls) — "Player" tab                     */
/* ------------------------------------------------------------------ */

interface PlayerContentProps {
  currentTrack: Child;
  colors: ThemeColors;
  queueLoading: boolean;
  handleSeek: (seconds: number) => void;
  handleShuffle: () => void;
  shuffling: boolean;
  /** Called when user swipes on the player area (up for queue, down to dismiss). */
  onSwitchToQueue: () => void;
  screenSwipeGesture?: any;
  queueTranslateY?: SharedValue<number>;
}

const CAROUSEL_GAP = 22;

const CarouselCoverItem = memo(
  ({
    item,
    isCurrent,
    heroSize,
  }: {
    item: Child;
    isCurrent: boolean;
    heroSize: number;
  }) => {
    const coverArtId = useSongCoverArt(item);
    const scale = useSharedValue(isCurrent ? 1 : 0.94);
    const opacity = useSharedValue(isCurrent ? 1 : 0.8);

    useEffect(() => {
      scale.value = withSpring(isCurrent ? 1 : 0.94, {
        damping: 18,
        stiffness: 130,
        mass: 0.8,
      });
      opacity.value = withTiming(isCurrent ? 1 : 0.8, {
        duration: 300,
        easing: Easing.out(Easing.quad),
      });
    }, [isCurrent, scale, opacity]);

    const animatedCardStyle = useAnimatedStyle(() => ({
      opacity: opacity.value,
      transform: [{ scale: scale.value }],
    }));

    return (
      <View
        style={{
          width: heroSize,
          height: heroSize,
          marginHorizontal: CAROUSEL_GAP / 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Animated.View
          style={[
            styles.heroImageWrap,
            {
              width: heroSize,
              height: heroSize,
            },
            animatedCardStyle,
          ]}
        >
          <CachedImage
            key={item.id}
            coverArtId={coverArtId}
            size={HERO_COVER_SIZE}
            style={styles.heroImage}
            resizeMode="cover"
            keepPreviousUntilLoaded={true}
          />
          {isCurrent && (
            <>
              <View style={styles.sleepCapsuleOverlay} pointerEvents="box-none">
                <SleepTimerCapsule />
              </View>
              <View style={styles.sourceBadgeOverlay} pointerEvents="none">
                <PlaybackSourceBadge />
              </View>
            </>
          )}
        </Animated.View>
      </View>
    );
  },
);

const PlayerContent = memo(function PlayerContent({
  currentTrack,
  colors,
  queueLoading,
  handleSeek,
  handleShuffle,
  shuffling,
  screenSwipeGesture,
  queueTranslateY,
}: PlayerContentProps) {
  const { t } = useTranslation();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isPlaying, isBuffering } = usePlaybackState();
  const position = playerStore((s) => s.position);
  const duration = playerStore((s) => s.duration);
  const bufferedPosition = playerStore((s) => s.bufferedPosition);
  const queue = playerStore((s) => s.queue);
  const currentTrackIndex = playerStore((s) => s.currentTrackIndex);
  const { canSkipNext, canSkipPrevious } = useCanSkip();

  const carouselTracks = useMemo(() => {
    if (!currentTrack) return [];
    return queue;
  }, [queue, currentTrack]);

  const currentIndex = currentTrackIndex ?? 0;
  const flatListRef = useRef<FlatList<Child>>(null);
  const isUserScrollingRef = useRef(false);
  const lastScrolledIndexRef = useRef(-1);
  const isSkippingRef = useRef(false);

  const error = playerStore((s) => s.error);
  const retrying = playerStore((s) => s.retrying);
  const queueLength = playerStore((s) => s.queue.length);

  const showSkipInterval = playbackSettingsStore((s) => s.showSkipIntervalButtons);
  const showSleepTimer = playbackSettingsStore((s) => s.showSleepTimerButton);

  const availableHeight = windowHeight - insets.top - insets.bottom - HEADER_BAR_HEIGHT;
  const m = useMemo(
    () => getPlayerSize(availableHeight, windowWidth),
    [availableHeight, windowWidth],
  );

  const transportWidth = useMemo(() => {
    const sideMin = m.sideIcon + 8;
    const maxCenter = windowWidth - 2 * HERO_PADDING - 2 * sideMin;
    return Math.max(120, Math.min(m.transportWidth, maxCenter));
  }, [windowWidth, m.sideIcon, m.transportWidth]);
  const secondaryCenterWidth = useMemo(() => {
    const sideMin = m.sideIcon + 8;
    const maxCenter = windowWidth - 2 * HERO_PADDING - 2 * sideMin;
    return Math.max(120, Math.min(m.secondaryCenterWidth, maxCenter));
  }, [windowWidth, m.sideIcon, m.secondaryCenterWidth]);

  // Fitted hero size
  const heroSize = useMemo(() => {
    const naturalWidth = Math.min(windowWidth - 2 * HERO_PADDING, 464 - 2 * HERO_PADDING);
    const reserved = insets.top + HEADER_BAR_HEIGHT + insets.bottom + m.reserved;
    const maxHero = windowHeight - reserved;
    const fitted = Math.max(Math.min(naturalWidth, maxHero), m.heroFloor);
    return Math.round(fitted * 0.9);
  }, [windowHeight, windowWidth, insets.top, insets.bottom, m.reserved, m.heroFloor]);

  const stepDistance = heroSize + CAROUSEL_GAP;
  const sidePadding = Math.max(0, (windowWidth - heroSize) / 2 - CAROUSEL_GAP / 2);

  const triggerCarouselSkip = useCallback(
    (targetIndex: number) => {
      if (isSkippingRef.current) return;
      if (targetIndex > currentIndex) {
        isSkippingRef.current = true;
        lastScrolledIndexRef.current = targetIndex;
        void skipToNext();
      } else if (targetIndex < currentIndex) {
        isSkippingRef.current = true;
        lastScrolledIndexRef.current = targetIndex;
        void skipToPrevious();
      }
    },
    [currentIndex],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isUserScrollingRef.current) return;
      isUserScrollingRef.current = false;
      const offsetX = event.nativeEvent.contentOffset.x;
      const targetIndex = Math.round(offsetX / stepDistance);
      triggerCarouselSkip(targetIndex);
    },
    [stepDistance, triggerCarouselSkip],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isUserScrollingRef.current) return;
      const velocityX = event.nativeEvent.velocity?.x ?? 0;
      if (Math.abs(velocityX) < 0.1) {
        isUserScrollingRef.current = false;
        const offsetX = event.nativeEvent.contentOffset.x;
        const targetIndex = Math.round(offsetX / stepDistance);
        triggerCarouselSkip(targetIndex);
      }
    },
    [stepDistance, triggerCarouselSkip],
  );

  useEffect(() => {
    isSkippingRef.current = false;
    if (flatListRef.current && !isUserScrollingRef.current && carouselTracks.length > 0) {
      if (lastScrolledIndexRef.current === currentIndex) {
        lastScrolledIndexRef.current = -1;
        return;
      }
      lastScrolledIndexRef.current = -1;
      flatListRef.current.scrollToOffset({
        offset: currentIndex * stepDistance,
        animated: true,
      });
    }
  }, [currentIndex, stepDistance, carouselTracks.length]);

  const onListLayout = useCallback(() => {
    flatListRef.current?.scrollToOffset({
      offset: currentIndex * stepDistance,
      animated: false,
    });
  }, [currentIndex, stepDistance]);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number }) => {
      setTimeout(() => {
        flatListRef.current?.scrollToOffset({
          offset: info.index * stepDistance,
          animated: false,
        });
      }, 50);
    },
    [stepDistance],
  );

  const getItemLayout = useCallback(
    (_: any, index: number) => ({
      length: stepDistance,
      offset: stepDistance * index,
      index,
    }),
    [stepDistance],
  );

  const carouselKeyExtractor = useCallback(
    (item: Child, index: number) => (item as any)._queueKey || `${item.id}-${index}`,
    [],
  );

  const renderCarouselItem = useCallback(
    ({ item, index }: { item: Child; index: number }) => (
      <CarouselCoverItem
        item={item}
        isCurrent={index === currentIndex}
        heroSize={heroSize}
      />
    ),
    [currentIndex, heroSize],
  );

  // Synergistic cover art, info, and controls movement as queue rises/falls
  const heroSynergyStyle = useAnimatedStyle(() => {
    if (!queueTranslateY) return {};
    const ty = queueTranslateY.value;
    const progress = interpolate(ty, [0, windowHeight], [1, 0], 'clamp');

    const scale = interpolate(progress, [0, 1], [1, 0.78], 'clamp');
    const translateY = interpolate(progress, [0, 1], [0, -48], 'clamp');
    const opacity = interpolate(progress, [0.12, 0.72], [1, 0], 'clamp');

    return {
      opacity,
      transform: [
        { translateY },
        { scale },
      ],
    };
  });

  const infoSynergyStyle = useAnimatedStyle(() => {
    if (!queueTranslateY) return {};
    const ty = queueTranslateY.value;
    const progress = interpolate(ty, [0, windowHeight], [1, 0], 'clamp');

    const translateY = interpolate(progress, [0, 1], [0, -24], 'clamp');
    const opacity = interpolate(progress, [0.08, 0.60], [1, 0], 'clamp');

    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const bottomControlsSynergyStyle = useAnimatedStyle(() => {
    if (!queueTranslateY) return {};
    const ty = queueTranslateY.value;
    const progress = interpolate(ty, [0, windowHeight], [1, 0], 'clamp');

    const translateY = interpolate(progress, [0, 1], [0, 36], 'clamp');
    const opacity = interpolate(progress, [0, 0.42], [1, 0], 'clamp');

    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const marqueeStyle = useMemo(
    () => [styles.trackTitle, { color: colors.textPrimary, fontSize: m.titleFont }],
    [colors.textPrimary, m.titleFont],
  );

  if (queueLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.textSecondary} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
          {t('loading')}
        </Text>
      </View>
    );
  }

  const upperContent = (
    <View>
      {Platform.OS === 'ios' && <View style={{ height: insets.top + HEADER_BAR_HEIGHT }} />}
      {/* Hero cover art carousel with synergistic scale, lift, and fade */}
      <Animated.View style={[styles.hero, { paddingBottom: m.heroPadBottom }, heroSynergyStyle]}>
        <View style={{ width: windowWidth, height: heroSize + 16, alignItems: 'center' }}>
          <FlatList
            ref={flatListRef}
            data={carouselTracks}
            renderItem={renderCarouselItem}
            keyExtractor={carouselKeyExtractor}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={stepDistance}
            snapToAlignment="start"
            decelerationRate="fast"
            disableIntervalMomentum={true}
            contentContainerStyle={{ paddingHorizontal: sidePadding }}
            getItemLayout={getItemLayout}
            initialScrollIndex={currentIndex > 0 && currentIndex < carouselTracks.length ? currentIndex : undefined}
            onScrollBeginDrag={() => {
              isUserScrollingRef.current = true;
              isSkippingRef.current = false;
            }}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            onScrollEndDrag={handleScrollEndDrag}
            onLayout={onListLayout}
            onScrollToIndexFailed={onScrollToIndexFailed}
            initialNumToRender={3}
            maxToRenderPerBatch={3}
            windowSize={5}
          />
        </View>
      </Animated.View>

      {/* Track info */}
      <Animated.View style={[styles.trackInfo, { marginBottom: m.infoMarginBottom }, infoSynergyStyle]}>
        <View style={styles.trackInfoRow}>
          <View style={styles.trackInfoText}>
            <MarqueeText style={marqueeStyle}>
              {currentTrack.title}
            </MarqueeText>
            <Text
              style={[styles.trackArtist, { color: colors.textSecondary, fontSize: m.artistFont }]}
              numberOfLines={1}
            >
              {currentTrack.artist ?? t('unknownArtist')}
            </Text>
            <CastButton />
          </View>
          <FavoriteButton trackId={currentTrack.id} style={styles.favoriteButton} />
        </View>
      </Animated.View>
    </View>
  );

  const playerContainer = (
    <View style={styles.playerContentContainer}>
      {upperContent}

      {/* Synergistic bottom controls container (slides down and dissolves as queue ascends) */}
      <Animated.View style={[{ flex: 1 }, bottomControlsSynergyStyle]}>
        {/* Progress bar */}
        <View style={[styles.progressSection, { marginBottom: m.progressMarginBottom }]}>
          <PlayerProgressBar
            position={position}
            duration={duration}
            bufferedPosition={bufferedPosition}
            colors={colors}
            onSeek={handleSeek}
            isBuffering={isBuffering}
            error={error}
            retrying={retrying}
            onRetry={retryPlayback}
          />
        </View>

        {/* Three equal flex spacers */}
        <View style={styles.playerSpacer} />

        {/* Playback controls */}
        <View style={[styles.controls, { paddingVertical: m.controlsPadV }]}>
          {/* Shuffle toggle */}
          <View style={styles.controlSideLeft}>
            <ShuffleButton
              onPress={handleShuffle}
              disabled={shuffling || queueLength < 2}
              size={m.sideIcon}
            />
          </View>

          {/* Transport controls */}
          <View style={[styles.transportControls, { width: transportWidth }]}>
            <GHPressable
              onPress={skipToPrevious}
              hitSlop={12}
              disabled={!canSkipPrevious}
              style={({ pressed }) => [pressed && styles.pressed, !canSkipPrevious && styles.disabled]}
            >
              <Ionicons
                name="play-back"
                size={m.transportIcon}
                color={canSkipPrevious ? colors.textPrimary : colors.textSecondary}
              />
            </GHPressable>

            <GHPressable
              onPress={togglePlayPause}
              style={({ pressed }) => [
                styles.playPauseButton,
                { width: m.playButton, height: m.playButton, borderRadius: m.playButton / 2, backgroundColor: colors.textPrimary },
                pressed && styles.playPausePressed,
              ]}
            >
              {isBuffering ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Ionicons
                  name={isPlaying ? 'pause' : 'play'}
                  size={m.playIcon}
                  color={colors.background}
                  style={!isPlaying ? styles.playIcon : undefined}
                />
              )}
            </GHPressable>

            <GHPressable
              onPress={skipToNext}
              hitSlop={12}
              disabled={!canSkipNext}
              style={({ pressed }) => [pressed && styles.pressed, !canSkipNext && styles.disabled]}
            >
              <Ionicons
                name="play-forward"
                size={m.transportIcon}
                color={canSkipNext ? colors.textPrimary : colors.textSecondary}
              />
            </GHPressable>
          </View>

          {/* Repeat toggle */}
          <View style={styles.controlSideRight}>
            <RepeatButton size={m.sideIcon} />
          </View>
        </View>

        {/* Secondary controls row */}
        {m.showSecondaryRow && (
          <>
            <View style={styles.playerSpacer} />
            <View style={styles.secondaryControls}>
              <View style={[styles.controlSideLeft, styles.secondaryLeftInset]}>
                {showSleepTimer && <SleepTimerButton />}
              </View>
              <View style={[styles.secondaryCenterRow, { width: secondaryCenterWidth }]}>
                {showSkipInterval && (
                  <SkipIntervalButton direction="backward" size={32} />
                )}
                <View style={styles.secondaryRateSlot}>
                  <PlaybackRateButton />
                </View>
                {showSkipInterval && (
                  <SkipIntervalButton direction="forward" size={32} />
                )}
              </View>
              <View style={styles.controlSideRight}>
                <BookmarkButton style={styles.favoriteButton} />
              </View>
            </View>
          </>
        )}

        <View style={styles.playerSpacer} />
      </Animated.View>
    </View>
  );

  if (!screenSwipeGesture) return playerContainer;
  return (
    <GestureDetector gesture={screenSwipeGesture}>
      {playerContainer}
    </GestureDetector>
  );
});

/* ------------------------------------------------------------------ */
/*  Queue header (shuffle, share, clear)                               */
/* ------------------------------------------------------------------ */

interface QueueHeaderProps {
  colors: ThemeColors;
  handleClearQueue: () => void;
  handleShuffle: () => void;
  handleShareQueue: () => void;
  shuffling: boolean;
  queueLength: number;
  swipeDownGesture?: any;
}

const QueueHeader = memo(function QueueHeader({
  colors,
  handleClearQueue,
  handleShuffle,
  handleShareQueue,
  shuffling,
  queueLength,
  swipeDownGesture,
}: QueueHeaderProps) {
  const { t } = useTranslation();
  if (queueLength === 0) return null;

  const headerContent = (
    <View style={styles.queueSection}>
      <View style={styles.dragHandleContainer}>
        <View style={[styles.dragHandlePill, { backgroundColor: colors.textSecondary }]} />
      </View>
      <View style={styles.queueHeaderRow}>
        <Text style={[styles.queueHeaderText, { color: colors.textPrimary }]}>
          {t('queue')}
        </Text>
        <View style={styles.queueActions}>
          <ShuffleButton
            onPress={handleShuffle}
            disabled={shuffling || queueLength < 2}
          />
          <Pressable
            onPress={handleShareQueue}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('shareQueue')}
            style={({ pressed }) => [
              styles.queueActionButton,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="share-outline" size={20} color={colors.textPrimary} />
          </Pressable>
          <Pressable
            onPress={handleClearQueue}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('clearQueue')}
            style={({ pressed }) => [
              styles.queueActionButton,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[styles.clearButtonText, { color: colors.textPrimary }]}
            >
              {t('clear')}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  if (swipeDownGesture) {
    return <GestureDetector gesture={swipeDownGesture}>{headerContent}</GestureDetector>;
  }

  return headerContent;
});

/* ------------------------------------------------------------------ */
/*  Album info tab                                                     */
/* ------------------------------------------------------------------ */

const AlbumInfoTab = memo(function AlbumInfoTab({
  currentTrack,
  colors,
}: {
  currentTrack: Child;
  colors: ThemeColors;
}) {
  const albumId = currentTrack.albumId ?? null;
  const {
    entry: albumInfoEntry,
    loading: albumInfoLoading,
    error: albumInfoError,
    refreshing,
    handleRetry,
    handleRefresh,
  } = usePlayerAlbumInfo(albumId, currentTrack.artist, currentTrack.album);

  const sanitizedNotes = useMemo(() => {
    // Prefer server notes, fall back to Wikipedia-enriched notes
    const serverNotes = albumInfoEntry?.albumInfo.notes;
    if (serverNotes) {
      const sanitized = sanitizeBiographyText(serverNotes);
      if (sanitized) return sanitized;
    }
    return albumInfoEntry?.enrichedNotes ?? null;
  }, [albumInfoEntry?.albumInfo.notes, albumInfoEntry?.enrichedNotes]);

  const notesAttributionUrl = albumInfoEntry?.enrichedNotesUrl ?? null;

  return (
    <View style={styles.albumInfoContainer}>
      <AlbumInfoContent
        track={currentTrack}
        albumInfo={albumInfoEntry?.albumInfo ?? null}
        overrideMbid={albumInfoEntry?.overrideMbid ?? null}
        sanitizedNotes={sanitizedNotes}
        notesAttributionUrl={notesAttributionUrl}
        albumInfoLoading={albumInfoLoading}
        albumInfoError={albumInfoError}
        onRetry={handleRetry}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        colors={colors}
      />
    </View>
  );
});

/* ------------------------------------------------------------------ */
/*  Lyrics tab                                                         */
/* ------------------------------------------------------------------ */

/** Pure presenter — the fetch it displays is owned by `PlayerPhonePortrait`. */
const LyricsTab = memo(function LyricsTab({
  currentTrack,
  colors,
  entry,
  loading,
  error,
  handleRetry,
}: PlayerLyricsResult & {
  currentTrack: Child;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.lyricsContainer}>
      <LyricsContent
        key={currentTrack.id}
        trackId={currentTrack.id}
        lyricsData={entry}
        lyricsLoading={loading}
        lyricsError={error}
        onRetry={handleRetry}
        durationSec={currentTrack.duration ?? null}
        colors={colors}
      />
    </View>
  );
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentArea: {
    flex: 1,
  },
  tabPanel: {
    ...absoluteFill,
  },
  hiddenTab: {
    display: 'none',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
  },
  playerContentContainer: {
    flex: 1,
  },
  playerSpacer: {
    flex: 1,
  },
  hero: {
    width: '100%',
    alignSelf: 'center',
    paddingTop: 8,
    paddingBottom: 24,
    alignItems: 'center',
  },
  heroImageWrap: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
  },
  dragHandleContainer: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 6,
  },
  dragHandlePill: {
    width: 38,
    height: 4,
    borderRadius: 2,
    opacity: 0.35,
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  sleepCapsuleOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceBadgeOverlay: {
    position: 'absolute',
    right: 12,
    bottom: 12,
  },
  trackInfo: {
    paddingHorizontal: HERO_PADDING,
    maxWidth: 464,
    width: '100%',
    alignSelf: 'center',
    marginBottom: 16,
  },
  trackInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackInfoText: {
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  trackArtist: {
    fontSize: 16,
    marginTop: 4,
  },
  favoriteButton: {
    paddingLeft: 12,
    paddingVertical: 4,
  },
  secondaryLeftInset: {
    paddingLeft: 4,
  },
  progressSection: {
    paddingHorizontal: HERO_PADDING,
    maxWidth: 464,
    width: '100%',
    alignSelf: 'center',
    marginBottom: 8,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: HERO_PADDING,
    maxWidth: 464,
    width: '100%',
    alignSelf: 'center',
  },
  controlSideLeft: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  controlSideRight: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  secondaryCenterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  secondaryRateSlot: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryControls: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    // No vertical margin: the three equal flex spacers (above the primary row,
    // between the rows, and below the secondary row) own ALL the inter-row
    // spacing. A fixed marginTop here is asymmetric — it inflates the gap above
    // the secondary row but not below it, so on short screens (where the
    // spacers shrink) the row gets pushed down against the tab bar.
    paddingHorizontal: HERO_PADDING,
    maxWidth: 464,
    width: '100%',
    alignSelf: 'center',
  },
  transportControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    // width is set inline (tier-scaled + clamped to the screen width) so the
    // shuffle/repeat side controls always keep room — see playerSize.
  },
  playPauseButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPausePressed: {
    opacity: 0.7,
  },
  playIcon: {
    marginLeft: 3,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
  queueSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  queueHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  queueHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  queueActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  queueActionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  clearButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  albumInfoContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  lyricsContainer: {
    flex: 1,
  },
});
