import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import { ChatScrollState } from "../chat-viewport";
import * as Haptics from "../haptics";

export function useChatScroll<T>(
  list: RefObject<FlatList<T> | null>,
  onFollowingChange: (following: boolean) => void,
  hasNewer = false
) {
  const state = useRef(new ChatScrollState()).current;
  const [following, setFollowingState] = useState(state.following);
  const callback = useRef(onFollowingChange);
  callback.current = onFollowingChange;
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const settled = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publish = useCallback(() => {
    setFollowingState(state.following);
    callback.current(state.following);
  }, [state]);
  const cancelCorrection = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (settled.current !== null) clearTimeout(settled.current);
  }, []);
  const scrollToBottom = useCallback(() => {
    if (state.canCorrect && state.viewportHeight > 0) {
      list.current?.scrollToOffset({ offset: state.bottomOffset, animated: false });
    }
  }, [list, state]);
  const correctAfterLayout = useCallback(() => {
    cancelCorrection();
    if (!state.canCorrect) return;
    frame.current = requestAnimationFrame(scrollToBottom);
    settled.current = setTimeout(scrollToBottom, 120);
  }, [cancelCorrection, scrollToBottom, state]);
  useEffect(() => cancelCorrection, [cancelCorrection]);

  const setFollowing = useCallback(
    (next: boolean) => {
      state.setFollowing(next);
      publish();
      correctAfterLayout();
    },
    [correctAfterLayout, publish, state]
  );
  const reset = useCallback(
    (next: boolean) => {
      cancelCorrection();
      state.reset(next);
      publish();
    },
    [cancelCorrection, publish, state]
  );
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previous = state.following;
    if (
      state.observeScroll(contentOffset.y, layoutMeasurement.height, contentSize.height, hasNewer)
    ) {
      void Haptics.selectionAsync();
    }
    if (previous !== state.following) publish();
  };

  return {
    state,
    following,
    setFollowing,
    reset,
    correctAfterLayout,
    onContentSizeChange: (_width: number, height: number) => {
      state.contentHeight = height;
      correctAfterLayout();
    },
    onLayout: (event: LayoutChangeEvent) => {
      state.viewportHeight = event.nativeEvent.layout.height;
      correctAfterLayout();
    },
    onScroll,
    onScrollBeginDrag: () => {
      cancelCorrection();
      state.beginDrag();
      publish();
    },
    onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll(event);
      state.endDrag();
    },
    onMomentumScrollBegin: () => state.beginMomentum(),
    onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll(event);
      state.endMomentum();
    },
  };
}
