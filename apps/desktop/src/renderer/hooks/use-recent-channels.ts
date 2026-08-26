import { useEffect, useState } from "react";

const MAX_WARM_CHANNELS = 3;

export function useRecentChannels(selectedId: string | null) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedId) return;
    setIds((current) =>
      [selectedId, ...current.filter((id) => id !== selectedId)].slice(0, MAX_WARM_CHANNELS)
    );
  }, [selectedId]);
  return ids;
}
