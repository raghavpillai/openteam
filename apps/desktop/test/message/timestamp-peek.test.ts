import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachTimestampPeek } from "../../src/renderer/lib/timestamp-peek";

class ElementFixture {
  parentElement: ElementFixture | null = null;
  scrollWidth = 100;
  clientWidth = 100;
  overflowX = "visible";
  direction = "ltr";
  values = new Map<string, string>();
  attributes = new Set<string>();
  listener?: (event: WheelEvent) => void;
  animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; onfinish: (() => void) | null; cancel: () => void }[] = [];
  style = {
    setProperty: (key: string, value: string) => this.values.set(key, value),
    removeProperty: (key: string) => this.values.delete(key),
  };
  setAttribute(key: string) { this.attributes.add(key); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  addEventListener(_type: string, listener: (event: WheelEvent) => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { frames, options, cancelled: false, onfinish: null as (() => void) | null, cancel() { this.cancelled = true; } };
    this.animations.push(animation);
    return animation;
  }
  wheel(deltaX: number, deltaY = 0, target: ElementFixture = this, ctrlKey = false) {
    let prevented = false;
    this.listener?.({ deltaX, deltaY, target, ctrlKey, defaultPrevented: false, preventDefault: () => { prevented = true; } } as unknown as WheelEvent);
    return prevented;
  }
}

describe("transcript timestamp gesture", () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let dispose: (() => void) | undefined;
  let reducedMotion = false;
  beforeEach(() => {
    reducedMotion = false;
    const replacements = {
      Element: ElementFixture,
      getComputedStyle: (element: ElementFixture) => ({ overflowX: element.overflowX, direction: element.direction, getPropertyValue: (key: string) => element.values.get(key) ?? "" }),
      matchMedia: () => ({ matches: reducedMotion }),
    };
    for (const [key, value] of Object.entries(replacements)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true });
    }
  });
  afterEach(() => {
    dispose?.();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const mount = () => {
    const viewport = new ElementFixture();
    dispose = attachTimestampPeek(viewport as unknown as HTMLElement);
    return viewport;
  };

  test("leaves vertical scrolling, pinch zoom, and tiny horizontal jitter alone", () => {
    const viewport = mount();
    expect(viewport.wheel(3, 30)).toBe(false);
    expect(viewport.wheel(1)).toBe(false);
    expect(viewport.wheel(30, 0, viewport, true)).toBe(false);
    expect(viewport.values.size).toBe(0);
  });

  test("clamps reveal distance, reverses, and respects right-to-left direction", () => {
    const viewport = mount();
    expect(viewport.wheel(100)).toBe(true);
    expect(viewport.values.get("--timestamp-peek")).toBe("82px");
    viewport.wheel(-32);
    expect(viewport.values.get("--timestamp-peek")).toBe("50px");
    viewport.wheel(-100);
    expect(viewport.values.get("--timestamp-peek")).toBe("0px");
    viewport.direction = "rtl";
    viewport.wheel(-20);
    expect(viewport.values.get("--timestamp-peek")).toBe("20px");
  });

  test("keeps a gesture inside an overflowing code block even after the pointer leaves it", () => {
    const viewport = mount();
    const block = new ElementFixture();
    block.parentElement = viewport;
    block.scrollWidth = 400;
    block.overflowX = "auto";
    expect(viewport.wheel(30, 0, block)).toBe(false);
    expect(viewport.wheel(30)).toBe(false);
    expect(viewport.attributes.has("data-timestamp-peeking")).toBe(false);
  });

  test("returns after release and resumes from an interrupted animation's visible position", async () => {
    const viewport = mount();
    viewport.wheel(60);
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(viewport.animations[0]?.options.duration).toBe(435);
    expect(viewport.animations[0]?.frames[0]?.["--timestamp-peek"]).toBe("60px");
    // Model the computed value partway through the Web Animation.
    viewport.values.set("--timestamp-peek", "25px");
    viewport.wheel(10);
    expect(viewport.animations[0]?.cancelled).toBe(true);
    expect(viewport.values.get("--timestamp-peek")).toBe("35px");
    dispose?.();
    expect(viewport.values.size).toBe(0);
    expect(viewport.listener).toBeUndefined();
  });

  test("reduced motion resets immediately on release without a return animation", async () => {
    reducedMotion = true;
    const viewport = mount();
    viewport.wheel(50);
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(viewport.animations).toHaveLength(0);
    expect(viewport.values.get("--timestamp-peek")).toBe("0px");
    expect(viewport.attributes.has("data-timestamp-peeking")).toBe(false);
  });
});
