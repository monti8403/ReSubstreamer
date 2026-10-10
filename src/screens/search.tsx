import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { AlbumRow } from '../components/AlbumRow';
import { ArtistRow } from '../components/ArtistRow';
import { CachedImage } from '../components/CachedImage';
import { EmptyState } from '../components/EmptyState';
import { RecentSearches } from '../components/RecentSearches';
import { SongRow } from '../components/SongRow';
import { useSongCoverArt } from '../hooks/useSongCoverArt';
import { useTheme } from '../hooks/useTheme';
import { getLocalTrackUri } from '../services/musicCacheService';
import { playMoreLikeThis } from '../services/moreOptionsService';
import { minDelay } from '../utils/stringHelpers';
import {
  type AlbumID3,
  type ArtistID3,
  type Child,
} from '../services/subsonicService';
import { listDownloadedAlbumIds } from '../db/repository/downloads';
import { favoritesStore } from '../store/favoritesStore';
import { filterBarStore } from '../store/filterBarStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { getDb } from '../store/persistence/db';
import { offlineModeStore } from '../store/offlineModeStore';
import { recentSearchStore } from '../store/recentSearchStore';
import { searchStore } from '../store/searchStore';

/* ------------------------------------------------------------------ */
/*  Top Hit helpers                                                   */
/* ------------------------------------------------------------------ */

type TopHitItem =
  | { type: 'artist'; data: ArtistID3 }
  | { type: 'song'; data: Child }
  | { type: 'album'; data: AlbumID3 };

function TopHitSongCover({ song }: { song: Child }) {
  const songCoverArtId = useSongCoverArt(song);
  return (
    <CachedImage
      coverArtId={songCoverArtId}
      size={180}
      style={styles.topHitCover}
      resizeMode="cover"
    />
  );
}

interface TopHitCardProps {
  topHit: TopHitItem;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
  t: (key: string, defaultValue?: any) => string;
}

function TopHitCard({ topHit, onPress, colors, t }: TopHitCardProps) {
  const isArtist = topHit.type === 'artist';
  const isSong = topHit.type === 'song';
  const isAlbum = topHit.type === 'album';

  const title = isArtist
    ? topHit.data.name
    : isSong
    ? topHit.data.title
    : topHit.data.name;

  const subtitle = isArtist
    ? null
    : isSong
    ? topHit.data.artist ?? t('unknownArtist', 'Unknown Artist')
    : topHit.data.artist ?? t('unknownArtist', 'Unknown Artist');

  const badgeText = isArtist
    ? t('artist', 'Artist')
    : isSong
    ? t('song', 'Song')
    : t('album', 'Album');

  return (
    <Pressable
      testID={`top-hit:${topHit.type}:${topHit.data.id}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.topHitCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.topHitImageWrap}>
        {isArtist && (
          <CachedImage
            coverArtId={topHit.data.coverArt}
            size={180}
            style={styles.topHitAvatar}
            resizeMode="cover"
          />
        )}
        {isSong && <TopHitSongCover song={topHit.data} />}
        {isAlbum && (
          <CachedImage
            coverArtId={topHit.data.coverArt}
            size={180}
            style={styles.topHitCover}
            resizeMode="cover"
          />
        )}
      </View>
      <View style={styles.topHitContent}>
        <Text
          style={[styles.topHitTitle, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[styles.topHitSubtitle, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
        <View style={[styles.badge, { backgroundColor: colors.inputBg }]}>
          <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
            {badgeText}
          </Text>
        </View>
      </View>
      {isSong && (
        <View style={[styles.topHitPlayButton, { backgroundColor: colors.primary }]}>
          <Ionicons name="play" size={18} color="#fff" style={styles.playIcon} />
        </View>
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  SearchScreen                                                      */
/* ------------------------------------------------------------------ */

export function SearchScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const headerHeight = searchStore((s) => s.headerHeight);
  const recentSearches = recentSearchStore((s) => s.recentSearches);

  const query = searchStore((s) => s.query);
  const results = searchStore((s) => s.results);
  const loading = searchStore((s) => s.loading);
  const performSearch = searchStore((s) => s.performSearch);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const [showAllSongs, setShowAllSongs] = useState(false);

  useEffect(() => {
    setShowAllSongs(false);
  }, [query]);

  useEffect(() => {
    if (!isFocused) return;
    const store = filterBarStore.getState();
    store.setLayoutToggle(null);
    store.setDownloadButtonConfig(null);
    store.setHideDownloaded(false);
    store.setHideFavorites(false);
  }, [isFocused]);

  // Re-run the active search when offline/online mode flips. `searchLibrary` routes
  // on the mode (offline = downloaded-only, no artists; online = full library +
  // server), so a stale result set from the other mode must be replaced without the
  // user having to re-type. Skip the mount pass (didModeMount) and empty queries.
  const didModeMount = useRef(false);
  useEffect(() => {
    if (!didModeMount.current) {
      didModeMount.current = true;
      return;
    }
    if (searchStore.getState().query.trim()) void performSearch();
  }, [offlineMode, performSearch]);

  const downloadedOnly = filterBarStore((s) => s.downloadedOnly);
  const favoritesOnly = filterBarStore((s) => s.favoritesOnly);
  // `revision` is the download tables' change signal: the id set below is SQL, and SQL has
  // no Zustand subscription, so without it a download completing (or being deleted) under
  // the user leaves these results silently stale.
  const revision = musicCacheStore((s) => s.revision);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const starredSongIds = favoritesStore((s) => s.songIds);
  const starredAlbumIds = favoritesStore((s) => s.albumIds);
  const starredArtistIds = favoritesStore((s) => s.artistIds);

  const [downloadedAlbumIds, setDownloadedAlbumIds] = useState<ReadonlySet<string> | null>(null);
  const downloadedKey = `${includePartial}:${revision}`;
  useEffect(() => {
    if (!downloadedOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const ids = db ? await listDownloadedAlbumIds(db, { includePartial }) : new Set<string>();
      if (alive) setDownloadedAlbumIds(ids);
    })();
    return () => {
      alive = false;
    };
  }, [downloadedOnly, includePartial, downloadedKey]);
  const downloadedUnknown = downloadedOnly && downloadedAlbumIds === null;

  const filtered = useMemo(() => {
    let artists = results.artists;
    let albums = results.albums;
    let songs = results.songs;

    if (downloadedOnly) {
      albums =
        downloadedAlbumIds === null ? [] : albums.filter((a) => downloadedAlbumIds.has(a.id));
      songs = songs.filter((s) => getLocalTrackUri(s.id) !== null);
      artists = [];
    }

    if (favoritesOnly) {
      artists = artists.filter((a) => starredArtistIds.has(a.id));
      albums = albums.filter((a) => starredAlbumIds.has(a.id));
      songs = songs.filter((s) => starredSongIds.has(s.id));
    }

    return { artists, albums, songs };
  }, [
    results,
    downloadedOnly,
    favoritesOnly,
    downloadedAlbumIds,
    starredSongIds,
    starredAlbumIds,
    starredArtistIds,
  ]);

  const hasResults =
    filtered.artists.length > 0 ||
    filtered.albums.length > 0 ||
    filtered.songs.length > 0;

  const filteredAway =
    (downloadedOnly || favoritesOnly) &&
    (results.artists.length > 0 || results.albums.length > 0 || results.songs.length > 0);

  const busy = loading || downloadedUnknown;

  const normalizedQuery = query.trim().toLowerCase();
  const topHit: TopHitItem | null = useMemo(() => {
    if (!normalizedQuery) return null;
    const exactArtist = filtered.artists.find(
      (a) => a.name.trim().toLowerCase() === normalizedQuery,
    );
    if (exactArtist) {
      return { type: 'artist', data: exactArtist };
    }
    if (filtered.songs.length > 0) {
      return { type: 'song', data: filtered.songs[0] };
    }
    if (filtered.artists.length > 0) {
      return { type: 'artist', data: filtered.artists[0] };
    }
    if (filtered.albums.length > 0) {
      return { type: 'album', data: filtered.albums[0] };
    }
    return null;
  }, [normalizedQuery, filtered.artists, filtered.songs, filtered.albums]);

  const displayedSongs = useMemo(() => {
    return showAllSongs ? filtered.songs : filtered.songs.slice(0, 5);
  }, [showAllSongs, filtered.songs]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!query.trim()) return;
    setRefreshing(true);
    const delay = minDelay();
    await performSearch();
    await delay;
    setRefreshing(false);
  }, [query, performSearch]);

  const recordCurrent = useCallback(() => {
    recentSearchStore.getState().record(searchStore.getState().query);
  }, []);

  const handleTopHitPress = useCallback(() => {
    if (!topHit) return;
    recordCurrent();
    if (topHit.type === 'artist') {
      router.push(`/artist/${topHit.data.id}`);
    } else if (topHit.type === 'song') {
      void playMoreLikeThis(topHit.data, { downloadedOnly });
    } else {
      router.push(`/album/${topHit.data.id}`);
    }
  }, [topHit, recordCurrent, router, downloadedOnly]);

  // Empty box: show recent-searches history when present, otherwise the
  // original placeholder (offline-aware).
  if (!query.trim()) {
    if (recentSearches.length > 0) {
      return <RecentSearches paddingTop={headerHeight} />;
    }
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <EmptyState
          icon="search-outline"
          title={offlineMode ? t('searchDownloadedMusic') : t('searchForMusic')}
          subtitle={offlineMode ? t('findDownloadedMusic') : t('findMusic')}
        />
      </View>
    );
  }

  // Query present, a search/refresh (or the downloaded-set read) in flight with nothing to
  // show yet — a spinner, not a blank screen.
  if (busy && !hasResults) {
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <View style={styles.loadingCentered}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            {t('searching')}
          </Text>
        </View>
      </View>
    );
  }

  // Query present, no results, nothing in flight: no-results placeholder.
  if (!hasResults && !busy) {
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <EmptyState
          icon="search-outline"
          title={filteredAway ? t('noMatchesForFilters') : t('noResultsFound')}
          subtitle={filteredAway ? t('tryAdjustingFilters') : t('noResultsFor', { query })}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {loading && (
        <View
          style={[
            styles.loadingStrip,
            {
              top: headerHeight,
              backgroundColor: colors.background,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.loadingStripText, { color: colors.textSecondary }]}>
            {t('searching')}
          </Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[styles.listContent, { paddingTop: headerHeight + 16 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        <Animated.View entering={FadeIn.duration(200)}>
          {/* 1. Top Hit Card */}
          {topHit && (
            <View style={styles.sectionWrap}>
              <Text style={[styles.sectionTitle, { color: colors.label }]}>
                {t('topResult', 'Top result')}
              </Text>
              <TopHitCard
                topHit={topHit}
                onPress={handleTopHitPress}
                colors={colors}
                t={t}
              />
            </View>
          )}

          {/* 2. Songs (Max 5, expandable) */}
          {filtered.songs.length > 0 && (
            <View style={styles.sectionWrap}>
              <Text style={[styles.sectionTitle, { color: colors.label }]}>
                {t('songs')}
              </Text>
              <View style={styles.songsList}>
                {displayedSongs.map((song) => (
                  <SongRow
                    key={song.id}
                    song={song}
                    variant="compact"
                    onPress={() => {
                      recordCurrent();
                      void playMoreLikeThis(song, { downloadedOnly });
                    }}
                  />
                ))}
              </View>
              {filtered.songs.length > 5 && (
                <Pressable
                  onPress={() => setShowAllSongs((prev) => !prev)}
                  style={styles.expandButton}
                >
                  <Text style={[styles.expandButtonText, { color: colors.primary }]}>
                    {showAllSongs
                      ? t('showLess', 'Show less')
                      : t('seeAllSongs', 'See all {{count}} songs', {
                          count: filtered.songs.length,
                        })}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* 3. Artists (Horizontal Carousel) */}
          {filtered.artists.length > 0 && (
            <View style={styles.sectionWrap}>
              <Text style={[styles.sectionTitle, { color: colors.label }]}>
                {t('artists')}
              </Text>
              <FlatList
                horizontal
                data={filtered.artists}
                keyExtractor={(item) => `artist-${item.id}`}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carouselContainer}
                renderItem={({ item }) => (
                  <ArtistRow
                    artist={item}
                    variant="carousel"
                    onPress={() => {
                      recordCurrent();
                      router.push(`/artist/${item.id}`);
                    }}
                  />
                )}
              />
            </View>
          )}

          {/* 4. Albums (Horizontal Carousel) */}
          {filtered.albums.length > 0 && (
            <View style={styles.sectionWrap}>
              <Text style={[styles.sectionTitle, { color: colors.label }]}>
                {t('albums')}
              </Text>
              <FlatList
                horizontal
                data={filtered.albums}
                keyExtractor={(item) => `album-${item.id}`}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carouselContainer}
                renderItem={({ item }) => (
                  <AlbumRow
                    album={item}
                    variant="carousel"
                    onPress={() => {
                      recordCurrent();
                      router.push(`/album/${item.id}`);
                    }}
                  />
                )}
              />
            </View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  loadingCentered: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  loadingStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loadingStripText: {
    fontSize: 13,
  },
  sectionWrap: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginLeft: 2,
  },
  /* Top Hit Card styles */
  topHitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  topHitImageWrap: {
    marginRight: 14,
  },
  topHitAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  topHitCover: {
    width: 72,
    height: 72,
    borderRadius: 8,
  },
  topHitContent: {
    flex: 1,
    justifyContent: 'center',
  },
  topHitTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  topHitSubtitle: {
    fontSize: 13,
    marginTop: 3,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginTop: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  topHitPlayButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  playIcon: {
    marginLeft: 2,
  },
  /* Songs list */
  songsList: {
    gap: 2,
  },
  expandButton: {
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  expandButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  /* Carousels */
  carouselContainer: {
    paddingRight: 16,
    paddingVertical: 4,
  },
});
