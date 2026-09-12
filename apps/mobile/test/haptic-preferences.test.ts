import { describe, expect, test } from "bun:test";
import { createHapticPreferenceStore } from "../src/haptic-preference-store";

describe("saved app haptic preferences", () => {
  test("starts quiet and honors a saved opt-out", async () => {
    const store = createHapticPreferenceStore({ read: async () => "off", write: async () => {} });
    expect(store.getSnapshot().enabled).toBe(false);
    await store.hydrate();
    expect(store.getSnapshot()).toEqual({ enabled: false, ready: true, saving: false });
  });
  test("enables feedback for a first launch after checking storage", async () => {
    const store = createHapticPreferenceStore({ read: async () => null, write: async () => {} });
    await store.hydrate();
    expect(store.getSnapshot().enabled).toBe(true);
  });
  test("an unreadable preference value does not enable feedback", async () => {
    const store = createHapticPreferenceStore({
      read: async () => "invalid",
      write: async () => {},
    });
    await store.hydrate();
    expect(store.getSnapshot().enabled).toBe(false);
  });
  test("unavailable storage cannot accidentally enable feedback", async () => {
    const store = createHapticPreferenceStore({
      read: async () => {
        throw new Error("Keychain locked");
      },
      write: async () => {},
    });
    await store.hydrate();
    expect(store.getSnapshot()).toEqual({ enabled: false, ready: true, saving: false });
  });
  test("opt-out takes effect immediately and persists across a new store instance", async () => {
    let saved: string | null = null;
    const storage = {
      read: async () => saved,
      write: async (value: string) => {
        saved = value;
      },
    };
    const store = createHapticPreferenceStore(storage);
    await store.hydrate();
    const pending = store.setEnabled(false);
    expect(store.getSnapshot().enabled).toBe(false);
    await pending;
    const relaunched = createHapticPreferenceStore(storage);
    await relaunched.hydrate();
    expect(relaunched.getSnapshot().enabled).toBe(false);
  });
  test("late hydration cannot overwrite an explicit user choice", async () => {
    const read = Promise.withResolvers<string | null>();
    const store = createHapticPreferenceStore({ read: () => read.promise, write: async () => {} });
    const loading = store.hydrate();
    await store.setEnabled(false);
    read.resolve("on");
    await loading;
    expect(store.getSnapshot().enabled).toBe(false);
  });
  test("a failed save reports the error but preserves the user's opt-out for the session", async () => {
    const store = createHapticPreferenceStore({
      read: async () => "on",
      write: async () => {
        throw new Error("Keychain locked");
      },
    });
    await store.hydrate();
    await expect(store.setEnabled(false)).rejects.toThrow("Keychain locked");
    expect(store.getSnapshot()).toEqual({ enabled: false, ready: true, saving: false });
  });
  test("unchanged selections do not write and overlapping saves cannot race", async () => {
    const write = Promise.withResolvers<void>();
    const values: string[] = [];
    const store = createHapticPreferenceStore({
      read: async () => "on",
      write: async (value) => {
        values.push(value);
        await write.promise;
      },
    });
    await store.hydrate();
    await store.setEnabled(true);
    expect(values).toEqual([]);
    const saving = store.setEnabled(false);
    await store.setEnabled(true);
    expect(values).toEqual(["off"]);
    write.resolve();
    await saving;
    expect(store.getSnapshot().enabled).toBe(false);
  });
  test("the same choice can be retried after a persistence failure", async () => {
    let writes = 0;
    const store = createHapticPreferenceStore({
      read: async () => "on",
      write: async () => {
        if (++writes === 1) throw new Error("Keychain locked");
      },
    });
    await store.hydrate();
    await expect(store.setEnabled(false)).rejects.toThrow("Keychain locked");
    await store.setEnabled(false);
    expect(writes).toBe(2);
    expect(store.getSnapshot().enabled).toBe(false);
  });
});
