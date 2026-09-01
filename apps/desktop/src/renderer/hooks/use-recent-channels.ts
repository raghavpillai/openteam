import { useRef } from "react";

const MAX_WARM_CHANNELS = 3;

export function useRecentChannels(selectedId: string | null) {
  const ids = useRef<string[]>([]);
  if (selectedId && ids.current[0] !== selectedId) {
    ids.current = [selectedId, ...ids.current.filter((id) => id !== selectedId)].slice(
      0,
      MAX_WARM_CHANNELS
    );
  }
  return ids.current;
}
