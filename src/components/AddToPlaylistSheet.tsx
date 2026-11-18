import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { CachedImage } from './CachedImage';
import { resolveSongCoverArt } from '../hooks/useSongCoverArt';
import { useTheme } from '../hooks/useTheme';
import { coverArtForAlbum } from '../utils/coverArtId';
import { hexWithAlpha } from '../utils/colors';
import {
  addSongsToPlaylist,
  resolveLocalTargetSongIds,
  resolveTargetSongIds,
} from '../services/playlistService';
import { createNewPlaylist } from '../services/subsonicService';
import {
  addToPlaylistStore,
  type AddToPlaylistTarget,
} from '../store/addToPlaylistStore';
import { refreshPlaylistLibrary } from '../services/normalizedLibrarySync';
import { getDb } from '../store/persistence/db';
import {
  getPlaylistsSongContainment,
  listAllPlaylists,
  playlistBrowseRowToPlaylist,
  type PlaylistSongContainment,
} from '../db/repository/playlists';
import { runWithOverlay } from '../store/processingOverlayStore';

import type { Playlist } from '../services/subsonicService';

const CONTENT_DELAY_MS = 750;
const CONTENT_ANIMATE_DURATION = 1000;
const SPINNER_HEIGHT = 48;

function getTargetCoverArt(target: AddToPlaylistTarget): string | undefined {
  // `coverArt`-value based cover art (see src/utils/coverArtId.ts).
  if (target.type === 'song') return resolveSongCoverArt(target.item);
  if (target.type === 'album') return coverArtForAlbum(target.item);
  const first = target.songs[0];
  return first ? resolveSongCoverArt(first) : undefined;
}

function getSubtitleText(target: AddToPlaylistTarget, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (target.type === 'song') {
    const title = target.item.title ?? t('unknownSong');
    const artist = target.item.artist ?? t('unknownArtist');
    return `${title} — ${artist}`;
  }
  if (target.type === 'queue') {
    const count = target.songs.length;
    return t('tracksFromQueue', { count });
  }
  const name = target.item.name ?? t('unknownAlbum');
  const artist = target.item.artist ?? t('unknownArtist');
  return `${name} — ${artist}`;
}

export function AddToPlaylistSheet() {
  const visible = addToPlaylistStore((s) => s.visible);
  const target = addToPlaylistStore((s) => s.target);
  const hide = addToPlaylistStore((s) => s.hide);
  // The pickable playlists come from the normalized `playlists` table (bounded read),
  // seeded from cache then refreshed from the server on open.
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsFetchError, setPlaylistsFetchError] = useState(false);
  const [targetSongIds, setTargetSongIds] = useState<string[] | null>(null);
  const [containmentMap, setContainmentMap] = useState<Map<string, PlaylistSongContainment>>(
    () => new Map(),
  );

  const { colors } = useTheme();
  const { t } = useTranslation();

  // Reveal runs 'loading' → 'measuring' → 'ready':
  //   'loading'   — spinner at SPINNER_HEIGHT while the sheet animates in
  //   'measuring' — content mounted off-screen to capture its natural height
  //   'ready'     — height animates SPINNER_HEIGHT → measured, content fades in
  const [phase, setPhase] = useState<'loading' | 'measuring' | 'ready'>('loading');
  const hasMeasured = useRef(false);
  const animatedHeight = useSharedValue(SPINNER_HEIGHT);
  const contentOpacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      setTargetSongIds(null);
      setContainmentMap(new Map());
      return undefined;
    }
    setPhase('loading');
    hasMeasured.current = false;
    animatedHeight.value = SPINNER_HEIGHT;
    contentOpacity.value = 0;
    setTargetSongIds(null);
    setContainmentMap(new Map());
    let alive = true;
    const timer = setTimeout(async () => {
      const db = getDb();
      let resolvedIds: string[] | null = null;
      if (target) {
        resolvedIds = await resolveLocalTargetSongIds(target, db);
        if (!alive) return;
        if (resolvedIds) setTargetSongIds(resolvedIds);
      }
      let latestResolvedIds = resolvedIds;

      // Seed with the cached playlists + SQLite containment first so the reveal
      // animation measures real content, THEN measure, THEN refresh from the server.
      if (db) {
        const [cachedRows, containment] = await Promise.all([
          listAllPlaylists(db),
          resolvedIds && resolvedIds.length > 0
            ? getPlaylistsSongContainment(db, resolvedIds)
            : Promise.resolve(new Map<string, PlaylistSongContainment>()),
        ]);
        if (!alive) return;
        const cached = cachedRows.map(playlistBrowseRowToPlaylist);
        if (cached.length) setPlaylists(cached);
        setContainmentMap(containment);
      }
      setPhase('measuring');
      setPlaylistsLoading(true);
      setPlaylistsFetchError(false);

      // If target is an album whose tracks weren't in SQLite yet, resolve them once
      // without blocking the initial sheet reveal.
      if (target && !resolvedIds) {
        resolveTargetSongIds(target)
          .then(async (fetchedIds) => {
            if (!alive || !fetchedIds) return;
            latestResolvedIds = fetchedIds;
            setTargetSongIds(fetchedIds);
            if (db) {
              const containment = await getPlaylistsSongContainment(db, fetchedIds);
              if (alive) setContainmentMap(containment);
            }
          })
          .catch(() => {
            // Resolved on select if the background lookup fails.
          });
      }

      try {
        await refreshPlaylistLibrary();
        if (db && alive) {
          const [refreshedRows, containment] = await Promise.all([
            listAllPlaylists(db),
            latestResolvedIds && latestResolvedIds.length > 0
              ? getPlaylistsSongContainment(db, latestResolvedIds)
              : Promise.resolve(null),
          ]);
          if (!alive) return;
          setPlaylists(refreshedRows.map(playlistBrowseRowToPlaylist));
          if (containment) setContainmentMap(containment);
        }
      } catch {
        if (alive) setPlaylistsFetchError(true);
      } finally {
        if (alive) setPlaylistsLoading(false);
      }
    }, CONTENT_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible, target, animatedHeight, contentOpacity]);

  const transitionToReady = useCallback(() => {
    setPhase('ready');
  }, []);

  const handleContentLayout = useCallback((e: LayoutChangeEvent) => {
    if (hasMeasured.current) return;
    hasMeasured.current = true;
    const targetHeight = e.nativeEvent.layout.height;
    animatedHeight.value = withTiming(targetHeight, {
      duration: CONTENT_ANIMATE_DURATION,
      easing: Easing.out(Easing.cubic),
    }, (finished) => {
      if (finished) {
        runOnJS(transitionToReady)();
      }
    });
    contentOpacity.value = withTiming(1, {
      duration: CONTENT_ANIMATE_DURATION,
      easing: Easing.out(Easing.cubic),
    });
  }, [animatedHeight, contentOpacity, transitionToReady]);

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    height: animatedHeight.value,
    overflow: 'hidden' as const,
  }));

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    hide();
    setMode('pick');
    setName('');
    setBusy(false);
    setError(null);
    setTargetSongIds(null);
    setContainmentMap(new Map());
  }, [hide]);

  const handleSelectPlaylist = useCallback(
    async (playlist: Playlist) => {
      if (!target || busy) return;
      if (containmentMap.get(playlist.id)?.isFullyContained) return;
      setBusy(true);
      setError(null);
      handleClose();
      await runWithOverlay(
        async () => {
          const songIds =
            targetSongIds && targetSongIds.length > 0
              ? targetSongIds
              : await resolveTargetSongIds(target);
          if (!songIds) throw new Error('Could not resolve songs');

          const { success } = await addSongsToPlaylist(playlist.id, songIds);
          if (!success) throw new Error('API returned false');

          void refreshPlaylistLibrary();
        },
        { error: t('failedToAddToPlaylist') },
      );
    },
    [target, targetSongIds, containmentMap, busy, handleClose, t],
  );

  const handleCreatePlaylist = useCallback(async () => {
    if (!target || busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('pleaseEnterPlaylistName'));
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const songIds =
        targetSongIds && targetSongIds.length > 0
          ? targetSongIds
          : await resolveTargetSongIds(target);
      if (!songIds) throw new Error('Could not resolve songs');

      const success = await createNewPlaylist(trimmed, songIds);
      if (!success) throw new Error('API returned false');

      handleClose();
      void refreshPlaylistLibrary();
    } catch {
      setBusy(false);
      setError(t('failedToCreatePlaylist'));
    }
  }, [target, targetSongIds, busy, name, handleClose, t]);

  const handleShowCreate = useCallback(() => {
    setMode('create');
    setError(null);
  }, []);

  const handleBackToPick = useCallback(() => {
    setMode('pick');
    setName('');
    setError(null);
  }, []);

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        title: { color: colors.textPrimary },
        subtitle: { color: colors.textSecondary },
        input: {
          backgroundColor: colors.inputBg,
          color: colors.textPrimary,
          borderColor: colors.border,
        },
        createButton: { backgroundColor: colors.primary },
        errorText: { color: colors.red },
        playlistName: { color: colors.textPrimary },
        playlistCount: { color: colors.textSecondary },
        partialHint: { color: colors.primary, fontWeight: '500' as const },
        alreadyInBadge: { backgroundColor: hexWithAlpha(colors.green, 0.14) },
        alreadyInText: { color: colors.green },
        newPlaylistLabel: { color: colors.primary },
        separator: { backgroundColor: colors.border },
      }),
    [colors],
  );

  const subtitle = target ? getSubtitleText(target, t) : '';
  const coverArtId = target ? getTargetCoverArt(target) : undefined;

  return (
    <BottomSheet visible={visible} onClose={handleClose} maxHeight="70%" scrollable={false}>
      <View style={styles.header}>
        {coverArtId && (
          <CachedImage coverArtId={coverArtId} size={150} style={styles.coverArt} resizeMode="cover" />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.title, dynamicStyles.title]} numberOfLines={1}>
            {t('addToPlaylist')}
          </Text>
          <Text style={[styles.subtitle, dynamicStyles.subtitle]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>

      {mode === 'create' ? (
        // The create form must stay OUTSIDE the measuring container: that container is
        // overflow:'hidden' at the pick-list's measured height, which clips the create
        // button. Its own scroll view renders at natural height so the button reflows
        // above the keyboard, and it isn't the node handleContentLayout measures, so
        // the pick-list reveal animation is unaffected.
        <ScrollView
          style={styles.flexContainer}
          contentContainerStyle={styles.formSection}
          bounces={false}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Back arrow */}
          <Pressable onPress={handleBackToPick} style={styles.backButton}>
            <Ionicons name="arrow-back" size={20} color={colors.primary} />
            <Text style={[styles.backLabel, { color: colors.primary }]}>{t('back')}</Text>
          </Pressable>

          <Text style={[styles.label, dynamicStyles.subtitle]}>{t('playlistName')}</Text>
          <TextInput
            style={[styles.input, dynamicStyles.input]}
            value={name}
            onChangeText={setName}
            placeholder={t('enterPlaylistNamePlaceholder')}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="done"
            autoFocus
            editable={!busy}
            onSubmitEditing={handleCreatePlaylist}
          />

          {error && (
            <Text style={[styles.errorText, dynamicStyles.errorText]}>{error}</Text>
          )}

          <Pressable
            onPress={handleCreatePlaylist}
            disabled={busy}
            style={({ pressed }) => [
              styles.createButton,
              dynamicStyles.createButton,
              pressed && styles.buttonPressed,
              busy && styles.buttonDisabled,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="add-outline" size={18} color="#fff" />
                <Text style={styles.createButtonText}>{t('createPlaylist')}</Text>
              </>
            )}
          </Pressable>
        </ScrollView>
      ) : (
        <Animated.View style={[styles.flexContainer, phase !== 'ready' && containerAnimatedStyle]}>
          {phase === 'loading' ? (
            <ActivityIndicator style={styles.loadingIndicator} color={colors.textSecondary} />
          ) : (
            <Animated.View
              style={[
                styles.flexContainer,
                contentAnimatedStyle,
                // During 'measuring', render absolutely positioned and off-screen
                // so the content can report its natural height without affecting layout
                phase === 'measuring' && styles.measuring,
              ]}
              onLayout={phase === 'measuring' ? handleContentLayout : undefined}
            >
              <ScrollView
                style={styles.listContainer}
                contentContainerStyle={styles.listContent}
                bounces={false}
                showsVerticalScrollIndicator={false}
              >
                {/* New Playlist row */}
                <Pressable
                  onPress={handleShowCreate}
                  style={({ pressed }) => [
                    styles.playlistRow,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                  <Text style={[styles.newPlaylistLabel, dynamicStyles.newPlaylistLabel]}>
                    {t('newPlaylist')}
                  </Text>
                </Pressable>

                <View style={[styles.separator, dynamicStyles.separator]} />

                {playlists.map((playlist) => {
                  const containment = containmentMap.get(playlist.id);
                  const isFullyContained = containment?.isFullyContained ?? false;
                  const existingCount = containment?.existingCount ?? 0;
                  const totalTargetSongs = targetSongIds?.length ?? 0;
                  const isPartiallyContained =
                    totalTargetSongs > 1 && existingCount > 0 && !isFullyContained;
                  const rowDisabled = busy || isFullyContained;

                  return (
                    <Pressable
                      key={playlist.id}
                      onPress={() => handleSelectPlaylist(playlist)}
                      disabled={rowDisabled}
                      accessibilityState={{ disabled: rowDisabled }}
                      style={({ pressed }) => [
                        styles.playlistRow,
                        isFullyContained && styles.playlistRowDisabled,
                        pressed && !rowDisabled && styles.rowPressed,
                      ]}
                    >
                      <Ionicons
                        name="list-outline"
                        size={22}
                        color={isFullyContained ? colors.label : colors.textSecondary}
                      />
                      <View style={styles.playlistInfo}>
                        <Text
                          style={[styles.playlistName, dynamicStyles.playlistName]}
                          numberOfLines={1}
                        >
                          {playlist.name}
                        </Text>
                        <Text
                          style={[styles.playlistCount, dynamicStyles.playlistCount]}
                          numberOfLines={1}
                        >
                          {t('trackWithCount', { count: playlist.songCount ?? 0 })}
                          {isPartiallyContained && (
                            <Text style={dynamicStyles.partialHint}>
                              {` · ${t('alreadyInPlaylistCount', { count: existingCount })}`}
                            </Text>
                          )}
                        </Text>
                      </View>
                      {isFullyContained && (
                        <View style={[styles.alreadyInBadge, dynamicStyles.alreadyInBadge]}>
                          <Ionicons
                            name="checkmark-circle"
                            size={15}
                            color={colors.green}
                          />
                          <Text style={[styles.alreadyInText, dynamicStyles.alreadyInText]}>
                            {t('alreadyInPlaylist')}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })}

                {playlists.length === 0 && playlistsLoading && (
                  <ActivityIndicator style={styles.loadingIndicator} color={colors.textSecondary} />
                )}

                {playlists.length === 0 && !playlistsLoading && !playlistsFetchError && (
                  <Text style={[styles.emptyText, dynamicStyles.playlistCount]}>
                    {t('noPlaylistsYet')}
                  </Text>
                )}

                {playlistsFetchError && playlists.length === 0 && !playlistsLoading && (
                  <Text style={[styles.emptyText, dynamicStyles.errorText]}>
                    {t('failedToLoadPlaylists')}
                  </Text>
                )}

                {playlists.length > 0 && playlistsLoading && (
                  <ActivityIndicator style={styles.loadingIndicator} size="small" color={colors.textSecondary} />
                )}
              </ScrollView>
            </Animated.View>
          )}
        </Animated.View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    marginBottom: 16,
  },
  coverArt: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.12)',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
  },
  flexContainer: {
    flexShrink: 1,
  },
  listContainer: {
    flexShrink: 1,
  },
  listContent: {
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  playlistRowDisabled: {
    opacity: 0.55,
  },
  rowPressed: {
    opacity: 0.6,
  },
  playlistInfo: {
    flex: 1,
    minWidth: 0,
  },
  playlistName: {
    fontSize: 16,
    fontWeight: '500',
  },
  playlistCount: {
    fontSize: 14,
    marginTop: 1,
  },
  alreadyInBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  alreadyInText: {
    fontSize: 12,
    fontWeight: '600',
  },
  newPlaylistLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
  },
  loadingIndicator: {
    paddingVertical: 16,
  },
  formSection: {
    paddingHorizontal: 4,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 16,
  },
  backLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  errorText: {
    fontSize: 14,
    marginTop: 12,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 20,
    marginBottom: 8,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  measuring: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});
