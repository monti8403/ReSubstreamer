const mockHapticsSelection = jest.fn();
jest.mock('@/utils/haptics', () => ({
  selectionAsync: () => mockHapticsSelection(),
}));

const mockCloseOpenRow = jest.fn();
jest.mock('@/components/SwipeableRow', () => ({
  closeOpenRow: () => mockCloseOpenRow(),
}));

const mockScrollToOffset = jest.fn();
let mockFlashListProps: any = {};
jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(props: any, ref: any) {
      mockFlashListProps = props;
      React.useImperativeHandle(ref, () => ({
        scrollToOffset: mockScrollToOffset,
      }));
      return (
        <View testID="flash-list">
          {props.ListHeaderComponent}
          {props.data?.length === 0 && props.ListEmptyComponent}
          {props.data?.map((item: any, index: number) => (
            <View key={props.keyExtractor ? props.keyExtractor(item, index) : String(index)}>
              {props.renderItem({ item, index })}
            </View>
          ))}
        </View>
      );
    }),
  };
});

const mockPanCallbacks: {
  onTouchesDown?: (e: any, stateManager: any) => void;
  onTouchesMove?: (e: any) => void;
  onFinalize?: () => void;
} = {};
jest.mock('react-native-gesture-handler', () => {
  const makePan = () => {
    const g: any = {
      manualActivation: () => g,
      shouldCancelWhenOutside: () => g,
      onTouchesDown: (cb: any) => {
        mockPanCallbacks.onTouchesDown = cb;
        return g;
      },
      onTouchesMove: (cb: any) => {
        mockPanCallbacks.onTouchesMove = cb;
        return g;
      },
      onFinalize: (cb: any) => {
        mockPanCallbacks.onFinalize = cb;
        return g;
      },
    };
    return g;
  };
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: {
      Pan: makePan,
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: any) => React.useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    runOnJS: (fn: Function) => fn,
  };
});

import React, { createRef } from 'react';
import { Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { type FlashListRef } from '@shopify/flash-list';

import { ReorderableFlashList } from '../ReorderableFlashList';

interface Item {
  key: string;
  label: string;
  fixed?: boolean;
}

const makeItems = (count: number): Item[] =>
  Array.from({ length: count }, (_, i) => ({ key: `k${i}`, label: `Item ${i}` }));

describe('ReorderableFlashList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlashListProps = {};
  });

  it('configures FlashList v2 with maintainVisibleContentPosition disabled, forwards listRef, and renders empty state', () => {
    const listRef = createRef<FlashListRef<Item> | null>();
    const { getByTestId, rerender } = render(
      <ReorderableFlashList
        data={[]}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text testID="ghost">{item.label}</Text>}
        onReorder={jest.fn()}
        rowHeight={64}
        accentColor="#1D9BF0"
        listRef={listRef}
        ListEmptyComponent={<Text testID="empty">Nothing here</Text>}
      />,
    );

    expect(mockFlashListProps.maintainVisibleContentPosition).toEqual({ disabled: true });
    expect(mockFlashListProps.drawDistance).toBe(300);
    expect(listRef.current).not.toBeNull();
    expect(getByTestId('empty')).toBeTruthy();

    rerender(
      <ReorderableFlashList
        data={makeItems(2)}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={jest.fn()}
        rowHeight={64}
        accentColor="#1D9BF0"
        getItemType={(it) => (it.fixed ? 'fixed' : 'normal')}
        listRef={listRef}
      />,
    );
    expect(mockFlashListProps.getItemType({ key: 'a', label: 'A', fixed: true }, 0)).toBe('fixed');
  });

  it('activates only inside right handle band and draggable region, shows ghost overlay, and commits reorder', () => {
    const items = makeItems(4);
    const onReorder = jest.fn();
    const onDragStateChange = jest.fn();
    const renderedDragging: Record<string, boolean> = {};

    const { getByTestId, queryByTestId } = render(
      <ReorderableFlashList
        testID="test-rfl"
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={({ item, isDragging }) => {
          renderedDragging[item.key] = isDragging;
          return <Text testID={`row-${item.key}`}>{item.label}</Text>;
        }}
        renderGhost={(item, idx) => (
          <View testID="ghost-row">
            <Text>{`Ghost ${idx}: ${item.label}`}</Text>
          </View>
        )}
        onReorder={onReorder}
        onDragStateChange={onDragStateChange}
        rowHeight={64}
        contentPaddingTop={20}
        ListHeaderComponent={<View style={{ height: 100 }} />}
        accentColor="#1D9BF0"
      />,
    );

    // Measure container & header -> draggableTopY = 20 + 100 = 120
    fireEvent(getByTestId('test-rfl'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 600 } },
    });
    fireEvent(getByTestId('test-rfl-header'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 100 } },
    });

    // Multi-touch -> fail
    const multiSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 2, allTouches: [{ x: 380, y: 150 }, { x: 100, y: 150 }] },
        multiSM,
      );
    });
    expect(multiSM.fail).toHaveBeenCalled();

    // Touch outside right handle band (x = 120 < 400 - 56) -> fail
    const leftSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 120, y: 150 }] },
        leftSM,
      );
    });
    expect(leftSM.fail).toHaveBeenCalled();

    // Touch inside header (y = 80 < 120) -> fail
    const headerSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 80 }] },
        headerSM,
      );
    });
    expect(headerSM.fail).toHaveBeenCalled();

    // Touch handle of item 0 (y = 140 -> contentY 140 -> index 0) -> activate
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 140 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();
    expect(mockCloseOpenRow).toHaveBeenCalled();
    expect(mockHapticsSelection).toHaveBeenCalledTimes(1);
    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(mockFlashListProps.scrollEnabled).toBe(false);
    expect(renderedDragging.k0).toBe(true);
    expect(renderedDragging.k1).toBe(false);
    expect(getByTestId('test-rfl-drag-overlay')).toBeTruthy();
    expect(getByTestId('ghost-row')).toBeTruthy();

    // Move finger down to item 2 (y = 260 -> index 2)
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 380, y: 260 }],
      });
    });
    expect(mockHapticsSelection).toHaveBeenCalledTimes(2);

    // Move within same row (y = 270) -> no duplicate haptic
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 380, y: 270 }],
      });
    });
    expect(mockHapticsSelection).toHaveBeenCalledTimes(2);

    // Release
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });
    expect(onDragStateChange).toHaveBeenCalledWith(false);
    expect(mockFlashListProps.scrollEnabled).toBe(true);
    expect(queryByTestId('test-rfl-drag-overlay')).toBeNull();
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it('auto-scrolls near viewport edges via rAF and cancels cleanly on finalize/unmount', () => {
    const rafQueue: Array<(t: number) => void> = [];
    const rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
    const cafSpy = jest
      .spyOn(global, 'cancelAnimationFrame')
      .mockImplementation(() => {});

    try {
      const items = makeItems(25);
      const onReorder = jest.fn();

      const { getByTestId, unmount } = render(
        <ReorderableFlashList
          testID="scroll-rfl"
          data={items}
          keyExtractor={(it) => it.key}
          renderItem={({ item }) => <Text>{item.label}</Text>}
          renderGhost={(item) => <Text>{item.label}</Text>}
          onReorder={onReorder}
          rowHeight={84}
          rowGap={10}
          accentColor="#1D9BF0"
        />,
      );

      fireEvent(getByTestId('scroll-rfl'), 'layout', {
        nativeEvent: { layout: { width: 400, height: 300 } },
      });
      act(() => {
        mockFlashListProps.onContentSizeChange?.(400, 25 * 94);
      });

      // Grab near bottom edge (y = 280 in 300px viewport -> row 2)
      const dragSM = { activate: jest.fn(), fail: jest.fn() };
      act(() => {
        mockPanCallbacks.onTouchesDown?.(
          { numberOfTouches: 1, allTouches: [{ x: 380, y: 280 }] },
          dragSM,
        );
      });
      expect(dragSM.activate).toHaveBeenCalled();

      act(() => {
        for (let f = 0; f < 8; f += 1) {
          rafQueue.shift()?.((f + 1) * 16);
        }
      });
      expect(mockScrollToOffset).toHaveBeenCalledWith(
        expect.objectContaining({ offset: expect.any(Number), animated: false }),
      );

      // Finalize commits reorder
      act(() => {
        mockPanCallbacks.onFinalize?.();
      });
      expect(onReorder).toHaveBeenCalled();
      expect(cafSpy).toHaveBeenCalled();

      // Trailing frame when inactive exits safely
      act(() => {
        rafQueue.shift()?.(200);
      });

      // Start another drag and unmount mid-drag
      const drag2SM = { activate: jest.fn(), fail: jest.fn() };
      act(() => {
        mockFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 0 } } });
        mockPanCallbacks.onTouchesDown?.(
          { numberOfTouches: 1, allTouches: [{ x: 380, y: 20 }] },
          drag2SM,
        );
      });
      unmount();
      expect(cafSpy).toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });

  it('tracks dragged item by key across mid-drag list shifts and aborts cleanly if item disappears', () => {
    const items = makeItems(4); // k0, k1, k2, k3
    const onReorder = jest.fn();

    const { getByTestId, rerender } = render(
      <ReorderableFlashList
        testID="shift-rfl"
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={onReorder}
        rowHeight={64}
        draggableStart={1}
        draggableCount={3}
        leadingRowsHeight={104}
        accentColor="#1D9BF0"
      />,
    );

    fireEvent(getByTestId('shift-rfl'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 600 } },
    });

    // Touch leading row (y = 50 < 104) -> fail
    const leadingSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 50 }] },
        leadingSM,
      );
    });
    expect(leadingSM.fail).toHaveBeenCalled();

    // Grab k2 (draggableStart=1, top=104 -> k1 is [104,168), k2 is [168,232))
    const dragSM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 190 }] },
        dragSM,
      );
    });
    expect(dragSM.activate).toHaveBeenCalled();

    // Move to target index 3 (y = 260)
    act(() => {
      mockPanCallbacks.onTouchesMove?.({
        numberOfTouches: 1,
        allTouches: [{ x: 380, y: 260 }],
      });
    });

    // Mid-drag: leading item k0 finishes, so k1,k2,k3 shift to indices 0,1,2
    rerender(
      <ReorderableFlashList
        testID="shift-rfl"
        data={items.slice(1)}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={onReorder}
        rowHeight={64}
        draggableStart={0}
        draggableCount={3}
        leadingRowsHeight={0}
        accentColor="#1D9BF0"
      />,
    );

    // Release -> k2 is now at actualFrom=1, clampedTo=2
    act(() => {
      mockPanCallbacks.onFinalize?.();
    });
    expect(onReorder).toHaveBeenCalledWith(1, 2);

    // Next drag: grabbed item is removed mid-drag -> no reorder called
    onReorder.mockClear();
    const drag2SM = { activate: jest.fn(), fail: jest.fn() };
    act(() => {
      mockPanCallbacks.onTouchesDown?.(
        { numberOfTouches: 1, allTouches: [{ x: 380, y: 20 }] },
        drag2SM,
      );
    });
    expect(drag2SM.activate).toHaveBeenCalled();

    rerender(
      <ReorderableFlashList
        testID="shift-rfl"
        data={items.slice(2)}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={onReorder}
        rowHeight={64}
        draggableStart={0}
        draggableCount={2}
        leadingRowsHeight={0}
        accentColor="#1D9BF0"
      />,
    );

    act(() => {
      mockPanCallbacks.onFinalize?.();
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('guards inactive onTouchesMove/onFinalize and header removal', () => {
    const items = makeItems(2);
    const onReorder = jest.fn();

    const { rerender } = render(
      <ReorderableFlashList
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={onReorder}
        rowHeight={64}
        ListHeaderComponent={<View style={{ height: 50 }} />}
        accentColor="#1D9BF0"
      />,
    );

    // Inactive move/finalize should no-op
    act(() => {
      mockPanCallbacks.onTouchesMove?.({ numberOfTouches: 1, allTouches: [{ x: 380, y: 80 }] });
      mockPanCallbacks.onFinalize?.();
    });
    expect(onReorder).not.toHaveBeenCalled();

    // Removing header resets measured header height without error
    rerender(
      <ReorderableFlashList
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <Text>{item.label}</Text>}
        renderGhost={(item) => <Text>{item.label}</Text>}
        onReorder={onReorder}
        rowHeight={64}
        ListHeaderComponent={null}
        accentColor="#1D9BF0"
      />,
    );
  });
});
