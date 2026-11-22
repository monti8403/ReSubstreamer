import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@react-native-vector-icons/ionicons/static';

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
import { playerStore } from '../store/playerStore';
import { formatTrackDuration } from '../utils/formatters';
import { ensureQueueKey } from '../utils/queueKeys';

import type { ThemeColors } from '../constants/theme';

import { absoluteFill } from '../utils/styles';
import { QUEUE_ROW_HEIGHT } from './player/queueDragMath';

export { QUEUE_ROW_HEIGHT };
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
  isInUserQueue?: boolean;
  queueKey?: string;
  isDragging?: boolean;
  showDragHandle?: boolean;
  colors: Pick<ThemeColors, 'textPrimary' | 'textSecondary' | 'primary' | 'border' | 'red' | 'green'>;
  onPress: (index: number) => void;
  onLongPress?: (track: Child) => void;
  onGrabHandle?: () => void;
  onReleaseHandle?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const QueueItemRowInner = memo(function QueueItemRowInner({
  track,
  index,
  isActive,
  isInUserQueue,
  queueKey,
  isDragging = false,
  showDragHandle,
  colors,
  onPress,
  onLongPress,
  onGrabHandle,
  onReleaseHandle,
}: Omit<QueueItemRowProps, 'isInUserQueue'> & { isInUserQueue: boolean }) {
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

  // Swipe LEFT → Remove from queue (red) — disabled on active track (can't be removed)
  const leftActions: SwipeAction[] = useMemo(
    () =>
      isActive
        ? []
        : [
          {
            icon: 'trash-outline' as const,
            color: colors.red,
            label: t('remove'),
            onPress: handleRemove,
            removesRow: true,
          },
        ],
    [isActive, colors.red, handleRemove, t],
  );

  const shouldShowDragHandle = showDragHandle ?? !isActive;

  return (
    <SwipeableRow
      rightActions={rightActions}
      leftActions={leftActions}
      enableFullSwipeRight={!isActive && !isInUserQueue}
      enableFullSwipeLeft={!isActive}
      actionSize="queue"
      restingBackgroundColor="transparent"
      recyclingKey={queueKey ?? track.id}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
    >
      <View
        style={[
          styles.row,
          { borderBottomColor: colors.border },
          isDragging && styles.draggingRow,
        ]}
      >
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
        {shouldShowDragHandle &&
          (onGrabHandle || onReleaseHandle ? (
            <Pressable
              testID="queue-item-drag-handle"
              onPressIn={onGrabHandle}
              onPressOut={onReleaseHandle}
              hitSlop={8}
              style={styles.dragHandle}
            >
              <Ionicons
                name="reorder-three-outline"
                size={24}
                color={colors.textSecondary}
              />
            </Pressable>
          ) : (
            <View testID="queue-item-drag-handle" style={styles.dragHandle}>
              <Ionicons
                name="reorder-three-outline"
                size={24}
                color={colors.textSecondary}
              />
            </View>
          ))}
      </View>
    </SwipeableRow>
  );
});

const QueueItemRowStoreFallback = memo(function QueueItemRowStoreFallback(
  props: Omit<QueueItemRowProps, 'isInUserQueue'>,
) {
  const entryKey = ensureQueueKey(props.track);
  const isInUserQueue = playerStore((s) =>
    s.userQueueKeys.length > 0
      ? s.userQueueKeys.includes(entryKey)
      : s.userQueueTrackIds.includes(props.track.id),
  );
  return <QueueItemRowInner {...props} isInUserQueue={isInUserQueue} />;
});

export const QueueItemRow = memo(function QueueItemRow(props: QueueItemRowProps) {
  if (props.isInUserQueue !== undefined) {
    return <QueueItemRowInner {...props} isInUserQueue={props.isInUserQueue} />;
  }
  return <QueueItemRowStoreFallback {...props} />;
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  row: {
    height: QUEUE_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  draggingRow: {
    opacity: 0.25,
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
