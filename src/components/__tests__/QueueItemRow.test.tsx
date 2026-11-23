jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

const mockMoveQueueItemToUserQueue = jest.fn();
const mockRemoveItemFromQueue = jest.fn();

jest.mock('../../services/moreOptionsService', () => ({
  moveQueueItemToUserQueue: (...args: unknown[]) => mockMoveQueueItemToUserQueue(...args),
  removeItemFromQueue: (...args: unknown[]) => mockRemoveItemFromQueue(...args),
}));

jest.mock('../../hooks/useDownloadStatus', () => ({
  useDownloadStatus: () => 'none',
}));
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => false }));
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({ useSongCoverArt: () => 'art1' }));

let mockCapturedProps: any = {};
jest.mock('../SwipeableRow', () => {
  const { View, Pressable, Text } = require('react-native');
  return {
    SwipeableRow: (props: any) => {
      mockCapturedProps = props;
      return (
        <View testID="swipeable-row">
          {props.children}
          {props.rightActions?.map((a: any, i: number) => (
            <Pressable key={i} testID={`right-action-${i}`} onPress={a.onPress}>
              <Text>{a.label}</Text>
            </Pressable>
          ))}
          {props.leftActions?.map((a: any, i: number) => (
            <Pressable key={i} testID={`left-action-${i}`} onPress={a.onPress}>
              <Text>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      );
    },
  };
});

jest.mock('../CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View testID="cached-image" /> };
});

jest.mock('../NowPlayingIndicator', () => {
  const { View } = require('react-native');
  return { NowPlayingIndicator: () => <View testID="now-playing-indicator" /> };
});

jest.mock('../RowMetaLine', () => {
  const { View } = require('react-native');
  return { RowMetaLine: () => <View testID="row-meta" /> };
});

import { QueueItemRow } from '../QueueItemRow';
import { playerStore } from '../../store/playerStore';
import type { Child } from '../../services/subsonicService';

const mockColors = {
  textPrimary: '#fff',
  textSecondary: '#888',
  primary: '#1D9BF0',
  border: '#333',
  red: '#e91429',
  green: '#10B981',
};

const makeTrack = (id: string): Child => ({
  id,
  title: `Track ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 200,
  isDir: false,
});

describe('QueueItemRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapturedProps = {};
    playerStore.setState({ userQueueTrackIds: [], userQueueKeys: [] });
  });

  it('shows right swipe (Add to Queue) on Next Up tracks', () => {
    const track = makeTrack('s1');
    const { getByTestId, getByText } = render(
      <QueueItemRow
        track={track}
        index={2}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    expect(mockCapturedProps.enableFullSwipeRight).toBe(true);
    expect(mockCapturedProps.actionSize).toBe('queue');
    expect(mockCapturedProps.rightActions).toHaveLength(1);
    expect(mockCapturedProps.rightActions[0].icon).toBe('playlist-play');

    fireEvent.press(getByTestId('right-action-0'));
    expect(mockMoveQueueItemToUserQueue).toHaveBeenCalledWith(2);
  });

  it('hides right swipe when track is already in userQueueTrackIds', () => {
    playerStore.setState({ userQueueTrackIds: ['s1'] });
    const track = makeTrack('s1');
    render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    expect(mockCapturedProps.enableFullSwipeRight).toBe(false);
    expect(mockCapturedProps.rightActions).toHaveLength(0);
    // Left action (remove) still available
    expect(mockCapturedProps.leftActions).toHaveLength(1);
  });

  it('hides right swipe when track is active track', () => {
    const track = makeTrack('s0');
    render(
      <QueueItemRow
        track={track}
        index={0}
        isActive={true}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    expect(mockCapturedProps.enableFullSwipeRight).toBe(false);
    expect(mockCapturedProps.rightActions).toHaveLength(0);
  });

  it('triggers removeItemFromQueue when left action is pressed', () => {
    const track = makeTrack('s1');
    const { getByTestId } = render(
      <QueueItemRow
        track={track}
        index={3}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('left-action-0'));
    expect(mockRemoveItemFromQueue).toHaveBeenCalledWith(3);
  });

  it('renders drag handle when isActive is false', () => {
    const track = makeTrack('s1');
    const { getByTestId } = render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );
    expect(getByTestId('queue-item-drag-handle')).toBeTruthy();
  });

  it('does not render drag handle when isActive is true', () => {
    const track = makeTrack('s0');
    const { queryByTestId } = render(
      <QueueItemRow
        track={track}
        index={0}
        isActive={true}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('queue-item-drag-handle')).toBeNull();
  });

  it('triggers handle callbacks on pressIn and pressOut when provided', () => {
    const track = makeTrack('s1');
    const onGrabHandle = jest.fn();
    const onReleaseHandle = jest.fn();
    const { getByTestId } = render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
        onGrabHandle={onGrabHandle}
        onReleaseHandle={onReleaseHandle}
      />,
    );

    const handle = getByTestId('queue-item-drag-handle');
    fireEvent(handle, 'pressIn');
    expect(onGrabHandle).toHaveBeenCalledTimes(1);

    fireEvent(handle, 'pressOut');
    expect(onReleaseHandle).toHaveBeenCalledTimes(1);
  });

  it('forwards queueKey as SwipeableRow recyclingKey, hides handle when showDragHandle is false, and dims when isDragging', () => {
    const track = makeTrack('s1');
    const { queryByTestId, rerender, toJSON } = render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        isInUserQueue={false}
        queueKey="s1_99"
        isDragging={true}
        showDragHandle={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    expect(mockCapturedProps.recyclingKey).toBe('s1_99');
    expect(queryByTestId('queue-item-drag-handle')).toBeNull();
    expect(JSON.stringify(toJSON())).toContain('"opacity":0.25');

    rerender(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        isInUserQueue={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );
    expect(mockCapturedProps.recyclingKey).toBe('s1');
    expect(queryByTestId('queue-item-drag-handle')).toBeTruthy();
  });

  it('suppresses row long-press when touch starts on the drag handle and resets on release/cancel', () => {
    const track = makeTrack('s1');
    const onLongPress = jest.fn();
    const onPress = jest.fn();
    const { getByTestId } = render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        isInUserQueue={false}
        colors={mockColors}
        onPress={onPress}
        onLongPress={onLongPress}
      />,
    );

    const handle = getByTestId('queue-item-drag-handle');
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(false);

    fireEvent(handle, 'touchStart');
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(true);

    fireEvent(handle, 'touchEnd');
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(false);

    fireEvent(handle, 'touchStart');
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(true);

    fireEvent(handle, 'touchCancel');
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(false);

    fireEvent(handle, 'touchStart');
    mockCapturedProps.onPress();
    expect(onPress).toHaveBeenCalledWith(1);
    expect(mockCapturedProps.shouldSuppressLongPress()).toBe(false);
  });

  it('respects explicit isInUserQueue prop without subscribing to playerStore', () => {
    const subscribeSpy = jest.spyOn(playerStore, 'subscribe');
    const track = makeTrack('s1');
    render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        isInUserQueue={true}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );
    expect(mockCapturedProps.enableFullSwipeRight).toBe(false);
    expect(mockCapturedProps.rightActions).toHaveLength(0);
    expect(subscribeSpy).not.toHaveBeenCalled();
    subscribeSpy.mockRestore();
  });

  it('checks userQueueKeys in fallback mode when userQueueKeys is populated', () => {
    const { ensureQueueKey } = require('../../utils/queueKeys');
    const track = makeTrack('s1');
    const otherCopy = makeTrack('s1');
    const otherKey = ensureQueueKey(otherCopy);

    playerStore.setState({ userQueueKeys: [otherKey], userQueueTrackIds: ['s1'] });

    render(
      <QueueItemRow
        track={track}
        index={1}
        isActive={false}
        colors={mockColors}
        onPress={jest.fn()}
      />,
    );

    // Track's own entry key is NOT in userQueueKeys, even though track.id is in userQueueTrackIds
    expect(mockCapturedProps.enableFullSwipeRight).toBe(true);
    expect(mockCapturedProps.rightActions).toHaveLength(1);
  });
});
