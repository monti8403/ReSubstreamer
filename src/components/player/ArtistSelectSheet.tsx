import { memo, useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '../BottomSheet';
import { useTheme } from '@/hooks/useTheme';
import { resolveArtistId, type TrackArtistItem } from '@/services/artistResolutionService';

export interface ArtistSelectSheetProps {
  visible: boolean;
  artists: TrackArtistItem[];
  onClose: () => void;
  onSelectArtist: (artist: TrackArtistItem) => void;
}

export const ArtistSelectSheet = memo(function ArtistSelectSheet({
  visible,
  artists,
  onClose,
  onSelectArtist,
}: ArtistSelectSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [resolvingName, setResolvingName] = useState<string | null>(null);

  const handlePress = useCallback(
    async (artist: TrackArtistItem) => {
      if (resolvingName) return;

      if (artist.id) {
        onSelectArtist(artist);
        return;
      }

      setResolvingName(artist.name);
      try {
        const resolvedId = await resolveArtistId(artist.name);
        if (resolvedId) {
          onSelectArtist({ ...artist, id: resolvedId });
        } else {
          onSelectArtist(artist);
        }
      } catch {
        onSelectArtist(artist);
      } finally {
        setResolvingName(null);
      }
    },
    [resolvingName, onSelectArtist],
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      backgroundColor="#121212"
      scrollable
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('artists', 'Artisti')}</Text>
        </View>

        <View style={styles.list}>
          {artists.map((artist) => {
            const isResolving = resolvingName === artist.name;
            return (
              <Pressable
                key={artist.name}
                testID={`artist-select-item-${artist.name}`}
                accessibilityRole="button"
                accessibilityLabel={artist.name}
                style={({ pressed }) => [
                  styles.itemRow,
                  pressed && styles.itemRowPressed,
                ]}
                onPress={() => handlePress(artist)}
                disabled={Boolean(resolvingName)}
              >
                <View style={styles.avatarWrap}>
                  <Ionicons
                    name="person-circle-outline"
                    size={32}
                    color={colors.primary}
                  />
                </View>

                <Text style={styles.artistName} numberOfLines={1}>
                  {artist.name}
                </Text>

                {isResolving ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color="#666666"
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </BottomSheet>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingBottom: 8,
  },
  header: {
    paddingTop: 4,
    paddingBottom: 14,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#262626',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  list: {
    paddingTop: 4,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginVertical: 2,
  },
  itemRowPressed: {
    backgroundColor: '#1E1E1E',
  },
  avatarWrap: {
    marginRight: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artistName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
  },
});

