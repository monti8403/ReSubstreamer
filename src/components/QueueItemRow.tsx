import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useReorderableDrag } from 'react-native-reorderable-list';

import { CachedImage } from './CachedImage';
import { NowPlayingIndicator } from './NowPlayingIndicator';
import { RowMetaLine } from './RowMetaLine';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useSongCoverArt } from '../hooks/useSongCoverArt';
import { moveQueueItemToUserQueue, removeItemFromQueue } from '../services/moreOptionsService';
import { type Child } from '../services/subsonicService';
import { offlineModeStore } from '../store/offlineModeStore';
import { playerStore } from '../store/playerStore';
import { formatTrackDuration } from '../utils/formatters';

import type { ThemeColors } from '../constants/theme';

import { absoluteFill } from '../utils/styles';
/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const COVER_SIZE = 40;

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface QueueItemRowProps {
  track: Child;
  index: number;
  isActive: boolean;
  colors: Pick<ThemeColors, 'textPrimary' | 'textSecondary' | 'primary' | 'border' | 'red' | 'green'>;
  onPress: (index: number) => void;
  onLongPress?: (track: Child) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const QueueItemRow = memo(function QueueItemRow({
  track,
  index,
  isActive,
  colors,
  onPress,
  onLongPress,
}: QueueItemRowProps) {
  const drag = useReorderableDrag();

  const handlePress = useCallback(() => {
    onPress(index);
  }, [index, onPress]);

  const handleLongPress = useCallback(() => {
    onLongPress?.(track);
  }, [onLongPress, track]);

  const { t } = useTranslation();
  const songCoverArtId = useSongCoverArt(track);
  const starred = useIsStarred('song', track.id);
  const downloadStatus = useDownloadStatus('song', track.id);
  const rating = useRating(track.id, track.userRating);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const isInUserQueue = playerStore((s) => s.userQueueTrackIds.includes(track.id));

  const handleRemove = useCallback(() => {
    removeItemFromQueue(index);
  }, [index]);

  const handleAddToUserQueue = useCallback(() => {
    void moveQueueItemToUserQueue(index);
  }, [index]);

  const titleColor = isActive ? colors.primary : colors.textPrimary;
  const subtitleColor = isActive ? colors.primary : colors.textSecondary;
  const durationText =
    track.duration != null ? formatTrackDuration(track.duration) : '—';

  // Swipe RIGHT → Add to user queue (only on Next Up tracks; hidden on active track and items already in user queue)
  const rightActions: SwipeAction[] = useMemo(
    () =>
      isActive || isInUserQueue
        ? []
        : [
            {
              icon: 'playlist-play',
              iconFamily: 'mdi' as const,
              color: colors.primary,
              label: t('queue'),
              onPress: handleAddToUserQueue,
            },
          ],
    [isActive, isInUserQueue, handleAddToUserQueue, colors.primary, t],
  );

  // Swipe LEFT → Remove from queue (red)
  const leftActions: SwipeAction[] = useMemo(
    () => [
      {
        icon: 'trash-outline' as const,
        color: colors.red,
        label: t('remove'),
        onPress: handleRemove,
        removesRow: true,
      },
    ],
    [colors.red, handleRemove, t],
  );

  return (
    <SwipeableRow
      rightActions={rightActions}
      leftActions={leftActions}
      enableFullSwipeRight={!isActive && !isInUserQueue}
      enableFullSwipeLeft
      restingBackgroundColor="transparent"
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
    >
      <View style={[styles.row, { borderBottomColor: colors.border }]}>
        {/* Cover art with now-playing overlay */}
        <View style={styles.coverWrap}>
          <CachedImage
            coverArtId={songCoverArtId}
            size={50}
            style={styles.cover}
            resizeMode="cover"
          />
          {isActive && (
            <View style={styles.activeOverlay}>
              <NowPlayingIndicator size={24} color={colors.primary} />
            </View>
          )}
        </View>

        {/* Track info */}
        <View style={styles.info}>
          <View style={styles.line}>
            <Text
              style={[styles.title, { color: titleColor }]}
              numberOfLines={1}
            >
              {track.title}
            </Text>
            <RowMetaLine
              slots={['duration']}
              durationText={durationText}
              durationFontSize={14}
              durationColor={isActive ? colors.primary : undefined}
            />
          </View>
          <View style={[styles.line, styles.artistLine]}>
            {track.artist ? (
              <Text
                style={[styles.artist, { color: subtitleColor }]}
                numberOfLines={1}
              >
                {track.artist}
              </Text>
            ) : (
              <View style={styles.artistPlaceholder} />
            )}
            <RowMetaLine
              slots={['rating', 'download', 'heart']}
              rating={rating}
              starred={starred}
              downloadStatus={
                downloadStatus === 'complete' || downloadStatus === 'partial'
                  ? downloadStatus
                  : 'none'
              }
            />
          </View>
        </View>

        {/* Drag handle */}
        <Pressable
          onPressIn={drag}
          hitSlop={8}
          style={styles.dragHandle}
        >
          <Ionicons
            name="reorder-three-outline"
            size={24}
            color={colors.textSecondary}
          />
        </Pressable>
      </View>
    </SwipeableRow>
  );
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dragHandle: {
    marginLeft: 8,
    opacity: 0.5,
  },
  coverWrap: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  cover: {
    width: COVER_SIZE,
    height: COVER_SIZE,
  },
  activeOverlay: {
    ...absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
  },
  // Each text line splits into a left-flexed text + a right-pinned
  // RowMetaLine block. The text gets `flex: 1` + numberOfLines={1} so it
  // truncates instead of pushing the trailing block off-screen.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  artistLine: {
    marginTop: 2,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: '600',
  },
  artist: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
  },
  // Holds the artist line's row height stable when track.artist is null
  // so the status icons stay below the title line instead of climbing up
  // and colliding with the duration.
  artistPlaceholder: {
    flex: 1,
    minWidth: 0,
    height: 18,
  },
});
