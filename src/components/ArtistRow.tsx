import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { RowMetaLine } from './RowMetaLine';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useTheme } from '../hooks/useTheme';
import { toggleStar } from '../services/moreOptionsService';
import { type ArtistID3 } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { offlineModeStore } from '../store/offlineModeStore';

const COVER_SIZE = 300;

export const ArtistRow = memo(function ArtistRow({
  artist,
  onPress,
  variant = 'row',
}: {
  artist: ArtistID3;
  /** Overrides the default tap action (navigate to the artist). */
  onPress?: () => void;
  variant?: 'row' | 'carousel';
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const starred = useIsStarred('artist', artist.id);
  const rating = useRating(artist.id, artist.userRating);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const defaultOnPress = useCallback(() => {
    router.push(`/artist/${artist.id}`);
  }, [artist.id, router]);
  const handlePress = onPress ?? defaultOnPress;

  const handleToggleStar = useCallback(() => {
    toggleStar('artist', artist.id);
  }, [artist.id]);

  const handleLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'artist', item: artist });
  }, [artist]);

  const leftActions: SwipeAction[] = useMemo(
    () =>
      offlineMode
        ? []
        : [
            {
              icon: starred ? 'heart' : 'heart-outline',
              color: colors.red,
              label: starred ? t('remove') : t('add'),
              onPress: handleToggleStar,
            },
          ],
    [starred, colors.red, handleToggleStar, offlineMode, t],
  );

  if (variant === 'carousel') {
    return (
      <Pressable
        testID={`artist:${artist.id}`}
        onPress={handlePress}
        onLongPress={handleLongPress}
        style={styles.carouselItem}
      >
        <View style={styles.carouselAvatarWrap}>
          <CachedImage
            coverArtId={artist.coverArt}
            size={180}
            style={styles.carouselAvatar}
            resizeMode="cover"
          />
        </View>
        <Text
          style={[styles.carouselName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {artist.name}
        </Text>
      </Pressable>
    );
  }

  return (
    <SwipeableRow
      leftActions={leftActions}
      enableFullSwipeLeft={!offlineMode}
      rowGap={8}
      onLongPress={handleLongPress}
      onPress={handlePress}
    >
      <View style={styles.row}>
        <CachedImage coverArtId={artist.coverArt} size={COVER_SIZE} style={styles.cover} resizeMode="cover" />
        <View style={styles.text}>
          <Text
            style={[styles.artistName, { color: colors.textPrimary }]}
            numberOfLines={1}
          >
            {artist.name}
          </Text>
          <View style={styles.meta}>
            <RowMetaLine
              leading={
                <>
                  <Ionicons name="disc-outline" size={14} color={colors.primary} />
                  <Text
                    style={[styles.metaText, { color: colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {t('albumCount', { count: artist.albumCount })}
                  </Text>
                </>
              }
              slots={['rating', 'heart']}
              rating={rating}
              starred={starred}
            />
          </View>
        </View>
      </View>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  cover: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  text: {
    flex: 1,
    marginLeft: 12,
  },
  artistName: {
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    marginTop: 10,
  },
  metaText: {
    fontSize: 12,
    marginLeft: 3,
  },
  carouselItem: {
    width: 90,
    marginRight: 16,
    alignItems: 'center',
  },
  carouselAvatarWrap: {
    width: 90,
    height: 90,
    borderRadius: 45,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  carouselAvatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
  },
  carouselName: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
    width: 90,
  },
});
