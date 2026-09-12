interface Storage {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
}

export function createHapticPreferenceStore(storage: Storage) {
  // Stay quiet until the saved choice is known, including when storage is unavailable.
  let state = { enabled: false, ready: false, saving: false };
  let revision = 0;
  let savedEnabled: boolean | undefined;
  let hydration: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate: () => {
      if (hydration) return hydration;
      const startedAt = revision;
      hydration = (async () => {
        let enabled = false;
        try {
          const stored = await storage.read();
          enabled = stored === null || stored === "on";
        } catch {
          // A locked Keychain must not restore haptics that someone may have disabled.
        }
        if (revision === startedAt) {
          savedEnabled = enabled;
          publish({ enabled, ready: true, saving: false });
        }
      })();
      return hydration;
    },
    setEnabled: async (enabled: boolean) => {
      if (state.saving || (state.ready && state.enabled === enabled && savedEnabled === enabled))
        return;
      revision += 1;
      publish({ enabled, ready: true, saving: true });
      try {
        await storage.write(enabled ? "on" : "off");
        savedEnabled = enabled;
      } finally {
        // Keep the explicit choice for this session even if persistence fails.
        publish({ ...state, saving: false });
      }
    },
  };
}
