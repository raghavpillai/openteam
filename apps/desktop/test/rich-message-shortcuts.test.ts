import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type ShortcutDelegate =
  typeof import("../src/renderer/components/openbot/rich-message").createRichWidgetShortcutDelegate;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let createRichWidgetShortcutDelegate: ShortcutDelegate;

beforeAll(async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "http://127.0.0.1:5173/" } },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  ({ createRichWidgetShortcutDelegate } = await import(
    "../src/renderer/components/openbot/rich-message"
  ));
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

type KeydownListener = (event: KeyboardEvent) => void;

class ShortcutDocument {
  activeElement: Element | null = null;
  addCalls = 0;
  dialogOpen = false;
  pending: HTMLElement[] = [];
  removeCalls = 0;
  readonly listeners = new Set<KeydownListener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject, capture?: boolean) {
    expect(type).toBe("keydown");
    expect(capture).toBe(true);
    this.addCalls += 1;
    this.listeners.add(listener as KeydownListener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture?: boolean
  ) {
    expect(type).toBe("keydown");
    expect(capture).toBe(true);
    this.removeCalls += 1;
    this.listeners.delete(listener as KeydownListener);
  }

  querySelector(selector: string) {
    expect(selector).toBe('[role="dialog"], [aria-modal="true"]');
    return this.dialogOpen ? ({} as Element) : null;
  }

  querySelectorAll(selector: string) {
    expect(selector).toBe('[data-rich-widget-state="pending"]');
    const pending = this.pending;
    return {
      item: (index: number) => pending[index] ?? null,
      length: pending.length,
    };
  }

  keydown(overrides: Partial<KeyboardEvent> = {}) {
    const event = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: "a",
      metaKey: false,
      shiftKey: false,
      target: null,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...overrides,
    } as KeyboardEvent;
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

describe("rich-message keyboard delegation", () => {
  test("uses one document listener and routes to the latest pending card", () => {
    const ownerDocument = new ShortcutDocument();
    const first = { id: "first" } as unknown as HTMLElement;
    const second = { id: "second" } as unknown as HTMLElement;
    ownerDocument.pending = [first, second];
    const delegate = createRichWidgetShortcutDelegate(ownerDocument as unknown as Document);
    const routed: string[] = [];

    const removeFirst = delegate.register(first, () => routed.push("first"));
    const removeSecond = delegate.register(second, () => routed.push("second"));

    expect(ownerDocument.addCalls).toBe(1);
    expect(ownerDocument.listeners.size).toBe(1);
    ownerDocument.keydown();
    expect(routed).toEqual(["second"]);

    removeSecond();
    ownerDocument.pending = [first];
    ownerDocument.keydown();
    expect(routed).toEqual(["second", "first"]);
    expect(ownerDocument.removeCalls).toBe(0);

    removeFirst();
    expect(ownerDocument.removeCalls).toBe(1);
    expect(ownerDocument.listeners.size).toBe(0);
  });

  test("retains editable, dialog, modifier, handled-event, and key-shape guards", () => {
    const ownerDocument = new ShortcutDocument();
    const card = {} as HTMLElement;
    ownerDocument.pending = [card];
    const delegate = createRichWidgetShortcutDelegate(ownerDocument as unknown as Document);
    let calls = 0;
    const remove = delegate.register(card, () => {
      calls += 1;
    });

    ownerDocument.dialogOpen = true;
    ownerDocument.keydown();
    ownerDocument.dialogOpen = false;
    ownerDocument.keydown({ ctrlKey: true });
    ownerDocument.keydown({ defaultPrevented: true });
    ownerDocument.keydown({ key: "Enter" });
    const originalInput = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
    class TestInput {}
    Object.defineProperty(globalThis, "HTMLInputElement", {
      configurable: true,
      value: TestInput,
    });
    try {
      ownerDocument.keydown({ target: new TestInput() as unknown as EventTarget });
      ownerDocument.activeElement = new TestInput() as unknown as Element;
      ownerDocument.keydown();
    } finally {
      ownerDocument.activeElement = null;
      if (originalInput) Object.defineProperty(globalThis, "HTMLInputElement", originalInput);
      else delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
    }
    expect(calls).toBe(0);

    ownerDocument.keydown({ key: "b" });
    expect(calls).toBe(1);
    remove();
  });
});
