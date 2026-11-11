import { recentPlaysStore, type RecentWidgetItem } from '../recentPlaysStore';

describe('recentPlaysStore', () => {
  beforeEach(() => {
    recentPlaysStore.getState().clearRecentPlays();
  });

  it('records recent plays and caps at 4 items', () => {
    const item1: RecentWidgetItem = { id: '1', type: 'album', title: 'Album 1' };
    const item2: RecentWidgetItem = { id: '2', type: 'playlist', title: 'Playlist 2' };
    const item3: RecentWidgetItem = { id: '3', type: 'artist', title: 'Artist 3' };
    const item4: RecentWidgetItem = { id: '4', type: 'album', title: 'Album 4' };
    const item5: RecentWidgetItem = { id: '5', type: 'album', title: 'Album 5' };

    recentPlaysStore.getState().recordRecentPlay(item1);
    recentPlaysStore.getState().recordRecentPlay(item2);
    recentPlaysStore.getState().recordRecentPlay(item3);
    recentPlaysStore.getState().recordRecentPlay(item4);
    recentPlaysStore.getState().recordRecentPlay(item5);

    const items = recentPlaysStore.getState().recentItems;
    expect(items.length).toBe(4);
    expect(items[0].id).toBe('5');
    expect(items[1].id).toBe('4');
    expect(items[2].id).toBe('3');
    expect(items[3].id).toBe('2');
  });

  it('moves existing item to top if played again (deduplicates)', () => {
    const item1: RecentWidgetItem = { id: '1', type: 'album', title: 'Album 1' };
    const item2: RecentWidgetItem = { id: '2', type: 'playlist', title: 'Playlist 2' };

    recentPlaysStore.getState().recordRecentPlay(item1);
    recentPlaysStore.getState().recordRecentPlay(item2);
    recentPlaysStore.getState().recordRecentPlay(item1);

    const items = recentPlaysStore.getState().recentItems;
    expect(items.length).toBe(2);
    expect(items[0].id).toBe('1');
    expect(items[1].id).toBe('2');
  });
});

