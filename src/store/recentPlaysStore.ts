import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kvStorage } from './persistence';

export interface RecentWidgetItem {
  id: string;
  type: 'album' | 'playlist' | 'artist';
  title: string;
  subtitle?: string;
  coverUri?: string;
}

interface RecentPlaysState {
  recentItems: RecentWidgetItem[];
  recordRecentPlay: (item: RecentWidgetItem) => void;
  clearRecentPlays: () => void;
}

const PERSIST_KEY = 'substreamer-recent-plays';

export const recentPlaysStore = create<RecentPlaysState>()(
  persist(
    (set) => ({
      recentItems: [],
      recordRecentPlay: (item) =>
        set((state) => {
          const filtered = state.recentItems.filter((i) => i.id !== item.id);
          const updated = [item, ...filtered].slice(0, 4);
          return { recentItems: updated };
        }),
      clearRecentPlays: () => set({ recentItems: [] }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ recentItems: state.recentItems }),
    }
  )
);

