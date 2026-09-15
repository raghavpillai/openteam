import type { BotMemoryList } from "@openteam/contracts";

export interface MemoryViewState {
  data: BotMemoryList | null;
  error: string | null;
  loading: boolean;
  pending: string | null;
}

/** Serialize refreshes and reject any read that started before a mutation. */
export function createMemoryView(options: {
  load: () => Promise<BotMemoryList>;
  remove: (id?: string) => Promise<BotMemoryList>;
  change: (state: MemoryViewState) => void;
}) {
  let state: MemoryViewState = { data: null, error: null, loading: true, pending: null };
  let stopped = false;
  let reading = false;
  let dirty = false;
  let generation = 0;
  let mutationError = false;
  const change = (patch: Partial<MemoryViewState>) => {
    state = { ...state, ...patch };
    if (!stopped) options.change(state);
  };
  const refresh = async () => {
    if (stopped) return;
    if (reading || state.pending) {
      dirty = true;
      return;
    }
    reading = true;
    dirty = false;
    const requestGeneration = generation;
    try {
      const data = await options.load();
      if (!stopped && requestGeneration === generation)
        change({ data, error: mutationError ? state.error : null, loading: false });
    } catch {
      if (!stopped && requestGeneration === generation)
        change({ error: "Could not load memories. Try again.", loading: false });
    } finally {
      reading = false;
      if (dirty && !state.pending && !stopped) void refresh();
    }
  };
  return {
    refresh,
    async remove(id?: string) {
      if (stopped || state.pending) return false;
      generation++;
      mutationError = false;
      change({ pending: id ?? "clear", error: null });
      try {
        const data = await options.remove(id);
        if (stopped) return false;
        change({ data, loading: false });
        return true;
      } catch {
        mutationError = true;
        change({ error: "Could not delete memories. Check your connection and try again." });
        return false;
      } finally {
        change({ pending: null });
        if (!stopped) void refresh();
      }
    },
    stop() {
      stopped = true;
      generation++;
    },
  };
}
