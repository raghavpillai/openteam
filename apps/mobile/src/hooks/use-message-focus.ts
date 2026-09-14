import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { FlatList } from "react-native";

/** Variable-height rows may need several render batches before an index is measurable. */
export function useMessageFocus<T>(
  list: RefObject<FlatList<T> | null>,
  targetId: string | undefined,
  targetIndex: number
) {
  const target = useRef({ id: targetId, index: targetIndex });
  target.current = { id: targetId, index: targetIndex };
  const pending = useRef(Boolean(targetId));
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    pending.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    pending.current = Boolean(targetId);
    attempts.current = 0;
    return cancel;
  }, [targetId, cancel]);

  useEffect(() => {
    if (!targetId || targetIndex < 0) return;
    const place = () => {
      if (!pending.current || target.current.index < 0 || attempts.current >= 12) return;
      attempts.current += 1;
      list.current?.scrollToIndex({
        index: target.current.index,
        animated: false,
        viewPosition: 0.5,
      });
      timer.current = setTimeout(place, 150);
    };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(place, 0);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [list, targetId, targetIndex]);

  return {
    cancel,
    onVisibleMessageIds: useCallback(
      (ids: readonly string[]) => {
        if (target.current.id && ids.includes(target.current.id)) cancel();
      },
      [cancel]
    ),
    onScrollToIndexFailed: ({
      index,
      averageItemLength,
    }: {
      index: number;
      averageItemLength: number;
    }) => {
      if (!pending.current) return;
      list.current?.scrollToOffset({
        offset: Math.max(0, averageItemLength * index),
        animated: false,
      });
    },
  };
}
