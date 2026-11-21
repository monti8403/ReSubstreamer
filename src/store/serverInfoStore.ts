import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { setSortArticles } from '../db/sortArticles';
import { kvStorage } from './persistence';

export interface OpenSubsonicExtension {
  name: string;
  versions: number[];
}

export function resolveSonicSimilaritySupport(
  extensions: readonly OpenSubsonicExtension[] | undefined,
): { supportsSonicSimilarity: boolean; sonicSimilarityVersion: number | null } {
  if (!Array.isArray(extensions)) {
    return { supportsSonicSimilarity: false, sonicSimilarityVersion: null };
  }
  const ext = extensions.find((e) => e?.name === 'sonicSimilarity');
  if (ext && Array.isArray(ext.versions) && ext.versions.includes(1)) {
    return { supportsSonicSimilarity: true, sonicSimilarityVersion: 1 };
  }
  return { supportsSonicSimilarity: false, sonicSimilarityVersion: null };
}

export interface ServerInfo {
  serverType: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  openSubsonic: boolean;
  extensions: OpenSubsonicExtension[];
  supportsSonicSimilarity: boolean;
  sonicSimilarityVersion: number | null;
  lastFetchedAt: number | null;
  adminRole: boolean | null;
  shareRole: boolean | null;
  /**
   * The space-separated `ignoredArticles` hint returned by the server's
   * `getIndexes` / `getArtists` endpoint, parsed into an array. Drives
   * the article-stripped sort in album/artist/playlist lists when
   * present. `null` until the first successful fetch; falls back to
   * `DEFAULT_IGNORED_ARTICLES` in `sortHelpers.ts` when null.
   */
  ignoredArticles: string[] | null;
}

export type ServerInfoInput = Omit<
  ServerInfo,
  'supportsSonicSimilarity' | 'sonicSimilarityVersion'
> &
  Partial<Pick<ServerInfo, 'supportsSonicSimilarity' | 'sonicSimilarityVersion'>>;

export interface ServerInfoState extends ServerInfo {
  /** Session-only runtime invalidation if a `sonicSimilarity` endpoint returns 404. */
  sonicSimilaritySessionDisabled: boolean;
  setServerInfo: (info: ServerInfoInput) => void;
  setOpenSubsonicExtensions: (extensions: OpenSubsonicExtension[]) => void;
  invalidateSonicSimilarityForSession: () => void;
  resetSonicSimilaritySessionOverride: () => void;
  setIgnoredArticles: (articles: string[] | null) => void;
  clearServerInfo: () => void;
}

const PERSIST_KEY = 'substreamer-server-info';

const initialServerInfo: ServerInfo = {
  serverType: null,
  serverVersion: null,
  apiVersion: null,
  openSubsonic: false,
  extensions: [],
  supportsSonicSimilarity: false,
  sonicSimilarityVersion: null,
  lastFetchedAt: null,
  adminRole: null,
  shareRole: null,
  ignoredArticles: null,
};

export const serverInfoStore = create<ServerInfoState>()(
  persist(
    (set) => ({
      ...initialServerInfo,
      sonicSimilaritySessionDisabled: false,

      setServerInfo: (info) => {
        const derived = resolveSonicSimilaritySupport(info.extensions);
        set({
          ...info,
          supportsSonicSimilarity:
            info.supportsSonicSimilarity ?? derived.supportsSonicSimilarity,
          sonicSimilarityVersion:
            info.sonicSimilarityVersion !== undefined
              ? info.sonicSimilarityVersion
              : derived.sonicSimilarityVersion,
          sonicSimilaritySessionDisabled: false,
          lastFetchedAt: info.lastFetchedAt ?? Date.now(),
        });
      },

      setOpenSubsonicExtensions: (extensions) => {
        const derived = resolveSonicSimilaritySupport(extensions);
        set({
          extensions,
          supportsSonicSimilarity: derived.supportsSonicSimilarity,
          sonicSimilarityVersion: derived.sonicSimilarityVersion,
          sonicSimilaritySessionDisabled: false,
        });
      },

      invalidateSonicSimilarityForSession: () =>
        set({ sonicSimilaritySessionDisabled: true }),

      resetSonicSimilaritySessionOverride: () =>
        set({ sonicSimilaritySessionDisabled: false }),

      setIgnoredArticles: (articles) => {
        set({ ignoredArticles: articles });
        // Keep the dependency-free mirror the db/sort layer reads in sync.
        setSortArticles(articles);
      },

      clearServerInfo: () => {
        set({ ...initialServerInfo, sonicSimilaritySessionDisabled: false });
        setSortArticles(null);
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        serverType: state.serverType,
        serverVersion: state.serverVersion,
        apiVersion: state.apiVersion,
        openSubsonic: state.openSubsonic,
        extensions: state.extensions,
        supportsSonicSimilarity: state.supportsSonicSimilarity,
        sonicSimilarityVersion: state.sonicSimilarityVersion,
        lastFetchedAt: state.lastFetchedAt,
        adminRole: state.adminRole,
        shareRole: state.shareRole,
        ignoredArticles: state.ignoredArticles,
      }),
      // Seed the mirror from persisted state on boot.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        setSortArticles(state.ignoredArticles);
        if (typeof state.supportsSonicSimilarity !== 'boolean') {
          const derived = resolveSonicSimilaritySupport(state.extensions);
          serverInfoStore.setState({
            supportsSonicSimilarity: derived.supportsSonicSimilarity,
            sonicSimilarityVersion: derived.sonicSimilarityVersion,
          });
        }
      },
    }
  )
);
