import { ArrowUp, X } from "lucide-react";
import { isMac, isShortcut, shortcutBinding, useShortcutBindings } from "../hooks/use-shortcut-bindings";
import { FN_KEY, shortcutText } from "../lib/keyboard-shortcuts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MIN_VOICE_NOTE_MS } from "@openteam/contracts/transcription";
import { useVoiceRecorder, type Transcriber } from "../hooks/use-voice-recorder";
import { AppshotBotAvatar, BotPicker } from "./bot-picker";
import type { VoiceMemoMode } from "../components/openteam/voice-memo/voice-memo-layer";
import { DictationButton, insertDictation } from "./dictation";
import { Mascot, type MascotHandle } from "./mascot";
import {
  clamp,
  easeInCubic,
  follow,
  lerp,
  lerpRect,
  prefersReducedMotion,
  smooth,
  softClamp,
  spring,
  timeline,
  window01,
  type Rect,
} from "./motion";
import { refreshAppshotTheme } from "./theme";
import type { AppshotBot, AppshotRoster, AppshotSendResult, AppshotShot } from "./types";

// Dictation looks like a voice note in the chat composer: the same bar, wave, glow and orb.
// It carries the glow and orb libraries, so it loads when dictation is available.
let voiceLayerModule: Promise<typeof import("../components/openteam/voice-memo/voice-memo-layer")> | undefined;
const loadVoiceLayer = () => (voiceLayerModule ??= import("../components/openteam/voice-memo/voice-memo-layer"));
const VoiceMemoLayer = lazy(loadVoiceLayer);
/** The bar's capsule, sized to the card: 36 px tall, inset 4 px and concentric with the card's
 * 22 px corners (the chat's is 44 px around a larger composer). */
const VOICE_RADIUS = 18;
/** The mic's centre from the capsule's bottom-right corner: the bar grows out of it. */
const VOICE_ANCHOR = { right: 58, bottom: 18 };
/** How long the layer animates away before it unmounts (matches its CSS). */
const VOICE_EXIT_MS = 680;

const CARD_WIDTH = 452;
const MASCOT = 58;
/** The robot peeks over the card's top edge, from its right side. */
const PERCH_RIGHT = 30;
const PERCH_SHOWN = 0.77;
const HAND = 13;
const POSITION_KEY = "openteam:appshot:position";
const BOT_KEY = "openteam:appshot:bot";
const SENT_PILL_MS = 2_600;
const SPARKS = 9;
/** The thumbnail is 104 pt wide; 3× covers any Retina scale. */
const THUMB_PIXELS = 312;
const DRAFT_SYNC_MS = 300;
/** Main accepts up to this much text with a shot. */
const MAX_TEXT = 100_000;

type Phase = "idle" | "intro" | "compose" | "sending" | "sent" | "closing";

interface LoadedShot {
  id: string;
  url: string;
  /** A small copy for the card's thumbnail. */
  thumb: string;
  /** A tiny, pre-blurred copy of the screen: the glass behind the card and its menus. */
  texture: string;
  frame: Rect;
  aspect: number;
  workArea: Rect;
}

const bridge = () => window.appshot;

const readStorage = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeStorage = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* A convenience only. */ }
};

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** The full-resolution decode the first frame needs (it must match the screen exactly). */
const decodeShot = async (bytes: Uint8Array) => {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  await image.decode();
  return { blob, url };
};

/**
 * The small glass texture and thumbnail, resized off the main thread by createImageBitmap.
 * They're first needed about a second into the intro, so they're made after the window is
 * already on screen.
 */
const shotDerivatives = async (blob: Blob, width: number) => {
  const [tiny, small] = await Promise.all([
    createImageBitmap(blob, { resizeWidth: Math.max(8, Math.round(width / 18)), resizeQuality: "medium" }),
    createImageBitmap(blob, { resizeWidth: THUMB_PIXELS, resizeQuality: "high" }),
  ]);
  // Glass: blurred once at a tiny size; upscaled by the GPU it reads as a ~30 px blur.
  const glass = document.createElement("canvas");
  glass.width = tiny.width;
  glass.height = tiny.height;
  const glassContext = glass.getContext("2d");
  if (glassContext) {
    glassContext.filter = "blur(2.2px) saturate(1.7)";
    // Overdraw the edges so the blur doesn't pull in transparent black.
    glassContext.drawImage(tiny, -6, -6, glass.width + 12, glass.height + 12);
  }
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = small.width;
  thumbCanvas.height = small.height;
  thumbCanvas.getContext("2d")?.drawImage(small, 0, 0);
  tiny.close();
  small.close();
  const [glassBlob, thumbBlob] = await Promise.all([canvasBlob(glass, "image/png"), canvasBlob(thumbCanvas, "image/jpeg", 0.92)]);
  glass.width = glass.height = thumbCanvas.width = thumbCanvas.height = 0;
  return { texture: glassBlob ? URL.createObjectURL(glassBlob) : "", thumb: thumbBlob ? URL.createObjectURL(thumbBlob) : "" };
};

const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const toRect = (box: DOMRect): Rect => ({ x: box.left, y: box.top, width: box.width, height: box.height });
const inflate = (rect: Rect, by: number): Rect => ({
  x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2,
});
const fitInside = (rect: Rect, scale: number, lift = 0): Rect => {
  const width = rect.width * scale;
  const height = rect.height * scale;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2 - lift, width, height };
};

const pickBot = (roster: AppshotRoster, previous: string | null): string | null => {
  const ids = new Set(roster.bots.map((bot) => bot.id));
  for (const candidate of [previous, readStorage(BOT_KEY)]) {
    if (candidate && ids.has(candidate)) return candidate;
  }
  return roster.bots[0]?.id ?? null;
};

export function AppshotApp() {
  const [shot, setShot] = useState<LoadedShot | null>(null);
  const [roster, setRoster] = useState<AppshotRoster>({ bots: [], dictation: false });
  const [botId, setBotId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(true);
  const [sent, setSent] = useState<{ bot: AppshotBot; leaving: boolean } | null>(null);

  const phaseRef = useRef<Phase>("idle");
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const shotRef = useRef<LoadedShot | null>(null);
  const scene = useRef<AbortController | null>(null);
  const position = useRef<{ x: number; bottom: number } | null>(null);
  const growth = useRef<AbortController | null>(null);
  /** True while the text field animates to a new height with its scroll pinned to the top. */
  const growingPinned = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  /** Re-runs the click-through hit test at the last known pointer position. */
  const rehit = useRef<() => void>(() => undefined);
  /** A drag cut short (Esc, a retake, a lost pointer) must not leave the overlay grabbing. */
  const endDrag = () => {
    const drag = dragging.current;
    dragging.current = null;
    card.current?.removeAttribute("data-dragging");
    if (drag && card.current?.hasPointerCapture(drag.pointerId)) card.current.releasePointerCapture(drag.pointerId);
  };
  const lastBoing = useRef(0);

  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const glass = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fly = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const mascot = useRef<MascotHandle>(null);
  const hands = useRef<Array<HTMLElement | null>>([]);
  const sparks = useRef<HTMLDivElement>(null);
  const goo = useRef<SVGSVGElement>(null);
  const gooShapes = useRef<Array<SVGRectElement | null>>([]);
  const gooDrops = useRef<Array<SVGCircleElement | null>>([]);
  const gooFilters = useRef<Array<SVGFilterElement | null>>([]);
  const gooMask = useRef<SVGMaskElement>(null);
  const gooTint = useRef<SVGRectElement>(null);
  const gooShadow = useRef<SVGGElement>(null);
  /** The card's rect as last laid out, so per-frame code never reads layout back. */
  const cardBox = useRef<Rect>({ x: 0, y: 0, width: CARD_WIDTH, height: 0 });
  const glassTargets = useRef<Array<{ element: HTMLElement; x: number; y: number; cardX: number; cardY: number; inCard: boolean }>>([]);
  const interactive = useRef(false);
  const sentLeaveTimer = useRef(0);
  const draftTimer = useRef(0);
  const rosterVersion = useRef(0);
  const lastDisplay = useRef<string | null>(null);

  const bot = roster.bots.find((candidate) => candidate.id === botId) ?? roster.bots[0] ?? null;
  const dictateText = shortcutText(useShortcutBindings().dictate, isMac());

  // ---- Dictation ------------------------------------------------------------------------
  // The overlay records; the signed-in main window transcribes (the same server pipeline as
  // voice notes), and the words land at the caret.
  const transcribeViaApp = useCallback<Transcriber>(async (audio, signal) => {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const result = await bridge()!.transcribe(bytes, audio.type || "audio/webm");
    if (signal.aborted) throw new DOMException("Dictation was cancelled", "AbortError");
    if (!result.ok) throw new Error(result.error);
    return { text: result.text };
  }, []);
  const sendAfterDictation = useRef(false);
  const lastListen = useRef(0);
  const voice = useVoiceRecorder(roster.dictation, (spoken) => {
    const element = input.current;
    setText((current) => {
      const start = element?.selectionStart ?? current.length;
      const end = element?.selectionEnd ?? current.length;
      const next = insertDictation(current, start, end, spoken);
      requestAnimationFrame(() => {
        element?.focus();
        element?.setSelectionRange(next.caret, next.caret);
      });
      return next.value;
    });
    mascot.current?.setHappy(true);
    mascot.current?.boing(0.9);
    window.setTimeout(() => { if (phaseRef.current === "compose") mascot.current?.setHappy(false); }, 900);
  }, transcribeViaApp);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const voiceMode: VoiceMemoMode | null =
    voice.state === "requesting" || voice.state === "recording" ? "recording" : voice.state === "processing" ? "processing" : null;
  // The layer stays for its exit animation after dictation ends, then unmounts (and stops
  // its frame loops).
  const lastVoiceMode = useRef<VoiceMemoMode | null>(null);
  const [, settleVoiceExit] = useState(0);
  if (voiceMode) lastVoiceMode.current = voiceMode;
  const voiceExiting = !voiceMode && lastVoiceMode.current !== null;
  useEffect(() => {
    if (!voiceExiting) return;
    const timer = window.setTimeout(() => {
      lastVoiceMode.current = null;
      settleVoiceExit((count) => count + 1);
    }, VOICE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [voiceExiting]);
  const voiceLayerMode = voiceMode ?? lastVoiceMode.current;
  useEffect(() => {
    if (!roster.dictation) return;
    const idle = window.requestIdleCallback(() => void loadVoiceLayer());
    return () => window.cancelIdleCallback(idle);
  }, [roster.dictation]);
  const cancelDictation = useCallback(() => {
    sendAfterDictation.current = false;
    voiceRef.current.cancel();
    input.current?.focus();
  }, []);
  /** The robot listens along: its antenna bounces with your voice. */
  const onListenLevel = useCallback((level: number) => {
    const now = performance.now();
    if (level > 0.38 && now - lastListen.current > 150) {
      lastListen.current = now;
      mascot.current?.boing(0.25 + level * 0.6);
    }
  }, []);

  // ---- Layout ---------------------------------------------------------------------------

  const cardRect = () => toRect(card.current!.getBoundingClientRect());
  const perchFor = (rect: Rect) => ({
    x: rect.x + rect.width - PERCH_RIGHT - MASCOT,
    y: rect.y - MASCOT * PERCH_SHOWN,
  });
  /** Where the robot's hands hold the card's top edge. */
  const gripFor = (rect: Rect) => {
    const perch = perchFor(rect);
    const middle = perch.x + MASCOT / 2;
    return [
      { x: middle - MASCOT * 0.3, y: rect.y + 0.5 },
      { x: middle + MASCOT * 0.3, y: rect.y + 0.5 },
    ];
  };

  const placeMascot = (x: number, y: number, scaleX = 1, scaleY = 1, rotate = 0) => {
    const root = mascot.current?.root;
    if (root) root.style.transform = `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${scaleX}, ${scaleY})`;
  };
  const placeHand = (index: number, point: { x: number; y: number }, scale = 1) => {
    const hand = hands.current[index];
    if (hand) hand.style.transform = `translate(${point.x - HAND / 2}px, ${point.y - HAND / 2}px) scale(${scale})`;
  };
  const placeFly = (rect: Rect, radius: number, rotate = 0, rim = 1.5, shadow = 0.32, opacity = 1) => {
    const element = fly.current;
    if (!element) return;
    element.style.opacity = String(opacity);
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.style.borderRadius = `${radius}px`;
    element.style.transform = rotate ? `rotate(${rotate}deg)` : "";
    element.style.boxShadow = `0 0 0 ${rim}px rgba(255,255,255,0.92), 0 ${8 + shadow * 20}px ${18 + shadow * 50}px rgba(0,0,0,${shadow})`;
  };
  const placeGoo = (rect: Rect, drop: { x: number; y: number; r: number } | null, opacity = 1) => {
    const svg = goo.current;
    if (!svg) return;
    svg.style.opacity = String(opacity);
    const radius = Math.min(22, rect.height / 2, rect.width / 2);
    for (const shape of gooShapes.current) {
      if (!shape) continue;
      shape.setAttribute("x", rect.x.toFixed(2));
      shape.setAttribute("y", rect.y.toFixed(2));
      shape.setAttribute("width", Math.max(0, rect.width).toFixed(2));
      shape.setAttribute("height", Math.max(0, rect.height).toFixed(2));
      shape.setAttribute("rx", radius.toFixed(2));
    }
    for (const circle of gooDrops.current) {
      if (!circle) continue;
      circle.setAttribute("cx", (drop?.x ?? 0).toFixed(2));
      circle.setAttribute("cy", (drop?.y ?? 0).toFixed(2));
      circle.setAttribute("r", Math.max(0, drop?.r ?? 0).toFixed(2));
    }
    // Filters only run over what moves, not the whole display.
    // The shadow reaches 26 + 64 px below the shape.
    let region = { x: rect.x - 70, y: rect.y - 70, width: rect.width + 140, height: rect.height + 170 };
    if (drop && drop.r > 0) {
      const left = Math.min(region.x, drop.x - drop.r - 70);
      const top = Math.min(region.y, drop.y - drop.r - 70);
      region = {
        x: left,
        y: top,
        width: Math.max(region.x + region.width, drop.x + drop.r + 70) - left,
        height: Math.max(region.y + region.height, drop.y + drop.r + 70) - top,
      };
    }
    // Filters, the mask and the tint all cover only the moving shape, so each frame repaints
    // that region rather than the whole display.
    for (const element of [...gooFilters.current, gooMask.current, gooTint.current]) {
      if (!element) continue;
      element.setAttribute("x", region.x.toFixed(0));
      element.setAttribute("y", region.y.toFixed(0));
      element.setAttribute("width", region.width.toFixed(0));
      element.setAttribute("height", region.height.toFixed(0));
    }
  };

  /** Puts the card where it was left on this display, or above the Dock. */
  const applyCardPosition = () => {
    const element = card.current;
    const loaded = shotRef.current;
    if (!element || !loaded) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (!position.current) {
      const saved = (() => {
        try {
          const value = JSON.parse(readStorage(POSITION_KEY) ?? "null") as { x?: unknown; bottom?: unknown } | null;
          return value && typeof value.x === "number" && typeof value.bottom === "number" ? value : null;
        } catch { return null; }
      })();
      const area = loaded.workArea;
      position.current = saved
        ? { x: (saved.x as number) * viewport.width, bottom: (saved.bottom as number) * viewport.height }
        : { x: area.x + (area.width - CARD_WIDTH) / 2, bottom: area.y + area.height - 56 };
    }
    const height = naturalHeight();
    element.style.height = `${height}px`;
    const next = {
      x: clamp(position.current.x, 10, viewport.width - CARD_WIDTH - 10),
      bottom: clamp(position.current.bottom, height + MASCOT * PERCH_SHOWN + 12, viewport.height - 10),
    };
    position.current = next;
    element.style.left = `${next.x}px`;
    element.style.top = `${next.bottom - height}px`;
    cardBox.current = { x: next.x, y: next.bottom - height, width: CARD_WIDTH, height };
    if (glass.current) glass.current.style.backgroundPosition = `${-next.x}px ${-(next.bottom - height)}px`;
  };

  const naturalHeight = () => body.current?.offsetHeight ?? 0;
  const INPUT_MIN = 22;
  const INPUT_MAX = 220;

  /**
   * New lines grow the text field on a quick spring, so the card's top edge, the thumbnail
   * and the robot on it all rise together, and the new line is revealed above the caret
   * (the field keeps the caret in view while it is shorter than its text).
   */
  const resizeInput = (animate: boolean) => {
    const element = input.current;
    if (!element) return;
    const from = parseFloat(element.style.height) || INPUT_MIN;
    element.style.height = "0px";
    const content = element.scrollHeight;
    const target = clamp(content, INPUT_MIN, INPUT_MAX);
    element.style.height = `${from}px`;
    if (content > INPUT_MAX) element.dataset.scrolls = "";
    else delete element.dataset.scrolls;
    growth.current?.abort();
    const pinned = content <= INPUT_MAX;
    const apply = (height: number) => {
      element.style.height = `${height.toFixed(2)}px`;
      // While it grows, the field would scroll to keep the caret in view and the lines would
      // jump up and slide back. Pinned to the top, they rise with the card's edge instead.
      if (pinned) element.scrollTop = 0;
      layoutCompose();
    };
    if (!animate || Math.abs(target - from) < 0.5 || prefersReducedMotion()) {
      apply(target);
      return;
    }
    const controller = new AbortController();
    growth.current = controller;
    growingPinned.current = pinned;
    const grow = spring(560, 42);
    void timeline(Math.min(420, grow.duration * 1_000), (ms) => apply(lerp(from, target, grow.at(ms / 1_000))), controller.signal)
      .then((done) => {
        if (done) apply(target);
        if (growth.current === controller) growingPinned.current = false;
      });
  };

  /** At rest: the robot peeks over the card and holds its edge. */
  const settlePerch = () => {
    if (!card.current) return;
    const rect = cardBox.current;
    const perch = perchFor(rect);
    placeMascot(perch.x, perch.y);
    gripFor(rect).forEach((point, index) => placeHand(index, point));
  };

  const layoutCompose = () => {
    applyCardPosition();
    // Only while composing does the robot sit on the card. During the scenes it's animated,
    // and once sent it has flown off: a layout pass (clearing the text) must not perch it.
    if (phaseRef.current === "compose") settlePerch();
    moveGlass();
  };

  /** Menus, badges and the sent pill show the same frosted screen as the card, aligned to
   * where they sit. (Over the transparent overlay a backdrop-filter has nothing to blur.)
   * Positions are measured once when these mount; moves and growth then only shift them. */
  const syncGlass = () => {
    const loaded = shotRef.current;
    if (!loaded?.texture || !stage.current) {
      glassTargets.current = [];
      return;
    }
    const box = cardBox.current;
    glassTargets.current = [...stage.current.querySelectorAll<HTMLElement>("[data-glass]")].map((element) => {
      let x = 0;
      let y = 0;
      for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
        x += node.offsetLeft;
        y += node.offsetTop;
      }
      // Centered elements are placed with a -50% translate, which offsets don't include.
      const host = element.closest<HTMLElement>("[data-centered]");
      if (host) {
        x -= host.offsetWidth / 2;
        y -= host.offsetHeight / 2;
      }
      element.style.backgroundImage = `linear-gradient(var(--menu-tint), var(--menu-tint)), url(${loaded.texture})`;
      element.style.backgroundSize = `auto, ${window.innerWidth}px ${window.innerHeight}px`;
      element.style.backgroundPosition = `0 0, ${-x}px ${-y}px`;
      return { element, x, y, cardX: box.x, cardY: box.y, inCard: !!card.current?.contains(element) };
    });
  };
  const moveGlass = () => {
    const box = cardBox.current;
    for (const target of glassTargets.current) {
      if (!target.inCard) continue;
      const x = target.x + box.x - target.cardX;
      const y = target.y + box.y - target.cardY;
      target.element.style.backgroundPosition = `0 0, ${-x}px ${-y}px`;
    }
  };

  /** One source of truth for click-through, so it can never get stuck. */
  const setInteractive = (next: boolean) => {
    if (interactive.current === next) return;
    interactive.current = next;
    bridge()?.setInteractive(next);
  };

  const revokeShot = (images: { url: string; texture: string; thumb: string }) => {
    if (images.url) URL.revokeObjectURL(images.url);
    if (images.texture) URL.revokeObjectURL(images.texture);
    if (images.thumb && images.thumb !== images.url && images.thumb !== "x") URL.revokeObjectURL(images.thumb);
  };

  /** Hidden until the next shot: let go of every image instead of holding them for minutes. */
  const releaseShot = () => {
    const loaded = shotRef.current;
    shotRef.current = null;
    glassTargets.current = [];
    setShot(null);
    if (loaded) window.setTimeout(() => revokeShot(loaded), 0);
  };

  const flushDraft = (value: string) => {
    window.clearTimeout(draftTimer.current);
    bridge()?.saveDraft(value);
  };

  // ---- Scenes ---------------------------------------------------------------------------

  /** The card fades in two layers: content first (it can sit on the settling goo), then the
   * glass, so the card is never an empty slab and the goo never shows a halo around it. */
  const setCardLayers = (glassIn: number, contentIn: number) => {
    card.current?.style.setProperty("--glass-in", glassIn.toFixed(3));
    card.current?.style.setProperty("--content-in", contentIn.toFixed(3));
    // One shadow throughout: the card's fades in exactly as the goo's (the same shape and
    // depth) fades out, and back, so it never doubles up or blinks off between them.
    card.current?.style.setProperty("--shadow-in", glassIn.toFixed(3));
    if (gooShadow.current) gooShadow.current.style.opacity = (1 - glassIn).toFixed(3);
  };

  const resetPieces = () => {
    // An early exit faded the whole stage; a new shot starts visible.
    if (stage.current) stage.current.style.opacity = "";
    const root = mascot.current?.root;
    if (root) root.style.opacity = "1";
    mascot.current?.setHappy(false);
    hands.current.forEach((hand) => hand && (hand.style.opacity = "1"));
    if (card.current) {
      card.current.style.opacity = "1";
      card.current.style.transform = "";
    }
    setCardLayers(0, 0);
    if (goo.current) goo.current.style.opacity = "0";
    if (fly.current) fly.current.style.opacity = "0";
    if (flash.current) flash.current.style.opacity = "0";
  };

  const finishIntro = () => {
    if (card.current) {
      card.current.style.opacity = "1";
      card.current.style.transform = "";
    }
    setCardLayers(1, 1);
    if (fly.current) fly.current.style.opacity = "0";
    if (goo.current) goo.current.style.opacity = "0";
    if (flash.current) flash.current.style.opacity = "0";
    setPhase("compose");
    settlePerch();
    input.current?.focus();
  };

  const playIntro = async (signal: AbortSignal) => {
    const loaded = shotRef.current;
    if (!loaded || !card.current || !thumb.current) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setCardLayers(0, 0);
    if (prefersReducedMotion()) {
      finishIntro();
      return;
    }
    // The card can grow while this plays (typing starts at once), so its rect, the robot's
    // perch and the thumbnail slot are read live every frame rather than snapshotted.
    let target = cardRect();
    let slot = toRect(thumb.current.getBoundingClientRect());
    let perch = perchFor(target);
    let grips = gripFor(target);
    const catchAt = { x: perch.x, y: Math.min(perch.y + 58, viewport.height - MASCOT - 40) };
    const full = loaded.frame;
    const framed = fitInside(full, 0.84, 14);
    const heldWidth = 92;
    const held: Rect = {
      x: catchAt.x + MASCOT / 2 - heldWidth / 2,
      y: catchAt.y + MASCOT * 0.6,
      width: heldWidth,
      height: heldWidth / loaded.aspect,
    };
    const frameSpring = spring(360, 32);
    const jump = spring(300, 19);
    const flight = spring(190, 24);
    const rise = spring(280, 24);
    // Stiff enough to be within a pixel of the slot when the card's own thumbnail fades in.
    const toSlot = spring(380, 34);
    const gooWidth = spring(250, 17);
    const gooHeight = spring(190, 15);
    // content: the card's text and controls fade in over the goo; glass: the card takes over.
    const T = { jump: 230, fly: 480, land: 870, goo: 960, content: 1_220, glass: 1_420, end: 1_640 };
    let landed = false;
    let stretch = 0;
    let lastMs = 0;
    let inputCenter: { x: number; y: number } | null = null;

    const flyRect = (ms: number): { rect: Rect; radius: number; rotate: number } => {
      if (ms < T.fly) {
        const progress = frameSpring.at(ms / 1_000);
        return { rect: lerpRect(full, framed, progress), radius: lerp(0, 18, clamp(progress, 0, 1)), rotate: 0 };
      }
      const progress = flight.at((ms - T.fly) / 1_000);
      const along = clamp(progress, 0, 1);
      const rect = lerpRect(framed, held, progress);
      // Thrown, not slid: the shot arcs up before it drops into the robot's hands.
      rect.y -= Math.sin(Math.PI * along) * 90;
      return { rect, radius: lerp(18, 7, along), rotate: -11 * Math.sin(Math.PI * along) };
    };
    const heldAtGoo = flyRect(T.goo).rect;
    const handsHolding = (rect: Rect) => [
      { x: rect.x + 9, y: rect.y + 4 },
      { x: rect.x + rect.width - 9, y: rect.y + 4 },
    ];

    await timeline(T.end, (ms) => {
      const dt = ms - lastMs;
      lastMs = ms;
      if (ms >= T.goo - 30) {
        target = cardRect();
        slot = toRect(thumb.current!.getBoundingClientRect());
        perch = perchFor(target);
        grips = gripFor(target);
      }
      // Shutter: a quick white flash. (No dimming: on a light screen it read as a gray flash.)
      if (flash.current) {
        flash.current.style.opacity = String(ms < 40 ? (ms / 40) * 0.5 : 0.5 * (1 - smooth(window01(ms, 40, 380))));
      }

      // The shot: framed, thrown to the robot, then docked in the card.
      if (ms < T.goo) {
        const { rect, radius, rotate } = flyRect(ms);
        const along = window01(ms, T.fly, T.land);
        placeFly(rect, radius, rotate, lerp(0, 1.5, smooth(window01(ms, 0, 160))), lerp(0.34, 0.26, along));
      } else {
        const progress = toSlot.at((ms - T.goo) / 1_000);
        const along = clamp(progress, 0, 1);
        const rect = lerpRect(heldAtGoo, slot, progress);
        const fade = 1 - smooth(window01(ms, T.content, T.content + 160));
        placeFly(rect, lerp(7, 10, along), 0, lerp(1.5, 0.5, along), lerp(0.26, 0.1, along), fade);
      }

      // The robot: jumps up from the bottom of the screen, catches, then rides the card up.
      // Squash and stretch follow its speed through a soft limit and a low-pass, so they
      // build and release over a few frames instead of snapping.
      let robot = { x: catchAt.x, y: viewport.height + 24 };
      let stretchTarget = 0;
      if (ms >= T.jump && ms < T.goo) {
        const t = (ms - T.jump) / 1_000;
        const travel = catchAt.y - (viewport.height + 24);
        robot = { x: catchAt.x, y: lerp(viewport.height + 24, catchAt.y, jump.at(t)) };
        stretchTarget = softClamp((-travel * jump.velocity(t)) / 2_800, -0.12, 0.2);
      } else if (ms >= T.goo) {
        const t = (ms - T.goo) / 1_000;
        robot = { x: lerp(catchAt.x, perch.x, rise.at(t)), y: lerp(catchAt.y, perch.y, rise.at(t)) };
        stretchTarget = softClamp(((catchAt.y - perch.y) * rise.velocity(t)) / 2_400, -0.1, 0.14);
      }
      stretch = follow(stretch, stretchTarget, 24, dt);
      let squash = stretch;
      if (ms >= T.land) {
        if (!landed) {
          landed = true;
          mascot.current?.boing(1.2);
        }
        // The catch: a damped squash that starts from rest (zero size and speed), not a pop.
        const since = ms - T.land;
        squash -= 0.13 * Math.exp(-since / 120) * Math.sin(since / 34) * smooth(since / 45);
      }
      placeMascot(robot.x, robot.y, 1 - squash * 0.6, 1 + squash);

      // Eyes on the prize (positions known here, so no layout is read back).
      const current = ms < T.goo ? flyRect(ms).rect : slot;
      inputCenter ??= ms > T.goo + 240 ? center(toRect(input.current!.getBoundingClientRect())) : null;
      mascot.current?.look(ms < T.jump ? null : ms > T.goo + 240 && inputCenter ? inputCenter : center(current), { x: robot.x + MASCOT / 2, y: robot.y + MASCOT * 0.45 });

      // Hands reach for the shot as it lands, then take the card's edge.
      if (ms < T.land - 150) {
        hands.current.forEach((_, index) => placeHand(index, { x: robot.x + MASCOT / 2, y: robot.y + MASCOT * 0.7 }, 0));
      } else if (ms < T.goo) {
        const reach = smooth(window01(ms, T.land - 150, T.land + 30));
        const sides = [
          { x: robot.x + MASCOT * 0.1, y: robot.y + MASCOT * 0.72 },
          { x: robot.x + MASCOT * 0.9, y: robot.y + MASCOT * 0.72 },
        ];
        handsHolding(flyRect(ms).rect).forEach((corner, index) => {
          const side = sides[index]!;
          placeHand(index, { x: lerp(side.x, corner.x, reach), y: lerp(side.y, corner.y, reach) }, reach);
        });
      } else {
        const progress = rise.at((ms - T.goo) / 1_000);
        handsHolding(heldAtGoo).forEach((from, index) => {
          const to = grips[index]!;
          placeHand(index, { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress) - Math.sin(Math.PI * clamp(progress, 0, 1)) * 18 });
        });
      }

      // Goo: the card oozes out from behind the shot in the robot's hands, jiggling as it
      // settles. It starts smaller than the shot, so it has no edge to pop in with.
      if (ms >= T.goo - 30) {
        const t = Math.max(0, ms - T.goo) / 1_000;
        const start = inflate(heldAtGoo, -8);
        const from = center(start);
        const to = center(target);
        const move = rise.at(t);
        const width = lerp(start.width, target.width, gooWidth.at(t));
        const height = lerp(start.height, target.height, gooHeight.at(t));
        const middle = { x: lerp(from.x, to.x, move), y: lerp(from.y, to.y, move) };
        const grip = { x: lerp(robot.x + MASCOT / 2, perch.x + MASCOT / 2, move), y: robot.y + MASCOT * 0.74 };
        placeGoo(
          { x: middle.x - width / 2, y: middle.y - height / 2, width, height },
          { ...grip, r: MASCOT * 0.3 * Math.sin(Math.PI * clamp(t / 0.42, 0, 1)) },
          // The goo stays opaque until the glass over it is too, then drops out from under it.
          // Fading both at once would leave the card part see-through mid-crossfade.
          smooth(window01(ms, T.goo - 30, T.goo + 60)) * (1 - smooth(window01(ms, T.glass + 160, T.end)))
        );
      }

      setCardLayers(smooth(window01(ms, T.glass, T.glass + 160)), smooth(window01(ms, T.content, T.content + 220)));
    }, signal);
    if (!signal.aborted) finishIntro();
  };

  const COLLAPSE_MS = 300;
  const HANDOVER_MS = 60;

  /** Shared by send, close and a failed send: the card is drawn back into the robot's hands.
   * For its first frames the real card tracks the goo's shape while it fades, so there is
   * never a second outline. */
  const collapse = (from: { rect: Rect; slot: Rect; perch: { x: number; y: number }; grips: Array<{ x: number; y: number }> }) => {
    const loaded = shotRef.current!;
    const heldWidth = 54;
    const held: Rect = {
      x: from.perch.x + MASCOT / 2 - heldWidth / 2,
      y: from.perch.y + MASCOT * 0.6,
      width: heldWidth,
      height: heldWidth / loaded.aspect,
    };
    const shrinkWidth = spring(380, 30);
    const shrinkHeight = spring(300, 25);
    const pull = spring(360, 32);
    const knot: Rect = { x: from.perch.x + MASCOT / 2 - 36, y: from.perch.y + MASCOT * 0.5, width: 72, height: 34 };
    /** Where the shot is at `ms`, continuing the same spring past the collapse, so later
     * scenes pick it up without a jump. */
    const shotAt = (ms: number): Rect => {
      const along = clamp(pull.at(ms / 1_000), 0, 1);
      const shot = lerpRect(from.slot, held, pull.at(ms / 1_000));
      shot.y -= Math.sin(Math.PI * along) * 26;
      return shot;
    };
    const handsAt = (ms: number) => {
      const progress = pull.at(ms / 1_000);
      const corners = [
        { x: held.x + 7, y: held.y + 3 },
        { x: held.x + held.width - 7, y: held.y + 3 },
      ];
      return from.grips.map((grip, index) => ({
        x: lerp(grip.x, corners[index]!.x, progress),
        y: lerp(grip.y, corners[index]!.y, progress),
      }));
    };
    const rotateAt = (ms: number) => 6 * Math.sin(Math.PI * clamp(pull.at(ms / 1_000), 0, 1));
    return {
      held,
      shotAt,
      handsAt,
      rotateAt,
      frame(ms: number) {
        const t = ms / 1_000;
        // The shape holds still until the card has handed over to the goo, so the two never
        // show as separate outlines; the shot lifts off from the first frame.
        const shapeT = Math.max(0, ms - HANDOVER_MS) / 1_000;
        const progress = pull.at(t);
        const along = clamp(progress, 0, 1);
        const shapeProgress = pull.at(shapeT);
        const width = lerp(from.rect.width, knot.width, shrinkWidth.at(shapeT));
        const height = lerp(from.rect.height, knot.height, shrinkHeight.at(shapeT));
        const middle = { x: lerp(center(from.rect).x, center(knot).x, shapeProgress), y: lerp(center(from.rect).y, center(knot).y, shapeProgress) };
        const shape = { x: middle.x - width / 2, y: middle.y - height / 2, width, height };
        placeGoo(
          shape,
          { x: from.perch.x + MASCOT / 2, y: from.perch.y + MASCOT * 0.72, r: MASCOT * 0.28 * Math.sin(Math.PI * clamp(shapeT / 0.28, 0, 1)) },
          1 - smooth(window01(ms, COLLAPSE_MS - 100, COLLAPSE_MS))
        );
        // Glass and text hand over to the goo while both have the card's exact shape.
        setCardLayers(1 - smooth(window01(ms, 0, HANDOVER_MS)), 1 - smooth(window01(ms, 0, HANDOVER_MS)));
        const shot = lerpRect(from.slot, held, progress);
        shot.y -= Math.sin(Math.PI * along) * 26;
        // Starts exactly like the card's thumbnail (thin rim, soft shadow), then lifts.
        placeFly(shot, lerp(10, 6, along), 6 * Math.sin(Math.PI * along), lerp(0.5, 1.2, along), lerp(0.1, 0.2, along));
        const corners = [
          { x: held.x + 7, y: held.y + 3 },
          { x: held.x + held.width - 7, y: held.y + 3 },
        ];
        from.grips.forEach((grip, index) => {
          const to = corners[index]!;
          placeHand(index, { x: lerp(grip.x, to.x, progress), y: lerp(grip.y, to.y, progress) });
        });
        mascot.current?.look(center(shot), { x: from.perch.x + MASCOT / 2, y: from.perch.y + MASCOT * 0.45 });
      },
    };
  };

  const snapshotRest = () => {
    const rect = cardRect();
    return { rect, slot: toRect(thumb.current!.getBoundingClientRect()), perch: perchFor(rect), grips: gripFor(rect) };
  };

  const burstSparks = (origin: { x: number; y: number }) => {
    const container = sparks.current;
    if (!container || prefersReducedMotion()) return;
    [...container.children].forEach((child, index) => {
      const angle = (Math.PI * 2 * index) / SPARKS + Math.random() * 0.4;
      const distance = 34 + Math.random() * 26;
      (child as HTMLElement).animate(
        [
          { transform: `translate(${origin.x}px, ${origin.y}px) scale(1)`, opacity: 1 },
          {
            transform: `translate(${origin.x + Math.cos(angle) * distance}px, ${origin.y + Math.sin(angle) * distance + 12}px) scale(0.2)`,
            opacity: 0,
          },
        ],
        { duration: 520 + Math.random() * 180, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "both" }
      );
    });
  };

  const playSend = async (
    signal: AbortSignal,
    result: Promise<AppshotSendResult>,
    onAway: (outcome: AppshotSendResult) => void
  ): Promise<AppshotSendResult> => {
    const rest = snapshotRest();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (prefersReducedMotion()) {
      const outcome = await result;
      // A newer shot took over meanwhile: its card and robot must stay visible.
      if (signal.aborted) return outcome;
      if (outcome.ok && card.current) card.current.style.opacity = "0";
      if (outcome.ok) {
        const root = mascot.current?.root;
        if (root) root.style.opacity = "0";
        hands.current.forEach((hand) => hand && (hand.style.opacity = "0"));
        if (fly.current) fly.current.style.opacity = "0";
        if (!signal.aborted) onAway(outcome);
      }
      return outcome;
    }
    let known: AppshotSendResult | null = null;
    void result.then((value) => { known = value; });
    const pullIn = collapse(rest);
    const CROUCH = 0.14;
    await timeline(COLLAPSE_MS, (ms) => {
      pullIn.frame(ms);
      // Anticipation: the robot crouches before it jumps.
      const crouch = CROUCH * smooth(window01(ms, 140, COLLAPSE_MS));
      placeMascot(rest.perch.x, rest.perch.y + crouch * 18, 1 + crouch * 0.6, 1 - crouch);
    }, signal);
    if (signal.aborted) return result;
    placeGoo({ x: 0, y: 0, width: 0, height: 0 }, null, 0);

    // Delivery is a local, journaled enqueue, so the robot leaves at once. If it does fail,
    // the robot brings the shot back and the card reopens with the reason.
    mascot.current?.setHappy(true);
    mascot.current?.boing(1.4);
    const launchFrom = { x: rest.perch.x, y: rest.perch.y + CROUCH * 18 };
    burstSparks({ x: launchFrom.x + MASCOT / 2, y: launchFrom.y + MASCOT * 0.9 });
    const exit = { x: viewport.width + 140, y: -MASCOT - 220 };
    let carried = COLLAPSE_MS;
    const carry = (x: number, y: number, scaleX: number, scaleY: number, rotate: number) => {
      const dx = x - launchFrom.x;
      const dy = y - launchFrom.y;
      placeMascot(x, y, scaleX, scaleY, rotate);
      // The shot and hands keep settling on the collapse's own spring while carried.
      const shot = pullIn.shotAt(carried);
      placeFly({ ...shot, x: shot.x + dx, y: shot.y + dy }, 6, rotate * 0.4, 1.2, 0.2);
      pullIn.handsAt(carried).forEach((point, index) => placeHand(index, { x: point.x + dx, y: point.y + dy }));
    };
    const LAUNCH_MS = 540;
    // A real jump: it leaves the card with upward speed at once (the crouch releasing), then
    // accelerates away up and to the right.
    // The upward speed builds over the first ~3 frames (t - tau(1 - e^(-t/tau))), so the
    // take-off is quick but never a velocity step.
    const TAU = 0.09;
    const ramp = (t: number) => (t - TAU * (1 - Math.exp(-t / TAU))) / (1 - TAU * (1 - Math.exp(-1 / TAU)));
    const path = (t: number) => ({
      x: lerp(launchFrom.x, exit.x, Math.pow(t, 2.3)),
      y: lerp(launchFrom.y, exit.y, 0.55 * ramp(t) + 0.45 * t * t * t),
    });
    let stretch = 0;
    let lastMs = 0;
    let announced = false;
    await timeline(LAUNCH_MS, (ms) => {
      const dt = ms - lastMs;
      lastMs = ms;
      carried = COLLAPSE_MS + ms;
      const t = ms / LAUNCH_MS;
      const point = path(t);
      const ahead = path(Math.min(1, t + 0.02));
      const speed = Math.hypot(ahead.x - point.x, ahead.y - point.y) / (0.02 * LAUNCH_MS) * 1_000;
      stretch = follow(stretch, softClamp(speed / 6_000, -0.1, 0.22), 26, dt);
      const release = CROUCH * (1 - smooth(window01(ms, 0, 90)));
      carry(point.x, point.y, 1 - stretch * 0.5 + release * 0.6, 1 + stretch - release, 20 * smooth(window01(ms, 0, 260)));
      mascot.current?.look({ x: exit.x, y: exit.y }, { x: launchFrom.x + MASCOT / 2, y: launchFrom.y + MASCOT * 0.45 });
      // The "sent" pill arrives while the robot is still on its way out, not after.
      if (!announced && ms >= LAUNCH_MS * 0.45 && known?.ok) {
        announced = true;
        onAway(known);
      }
    }, signal);
    if (signal.aborted) return result;
    const settled = await result;
    // A newer shot took over while this one was delivering: its pill must not cover it.
    if (signal.aborted) return settled;
    if (settled.ok) {
      if (!announced) onAway(settled);
      return settled;
    }

    mascot.current?.setHappy(false);
    const back = spring(200, 19);
    stretch = 0;
    lastMs = 0;
    await timeline(560, (ms) => {
      const dt = ms - lastMs;
      lastMs = ms;
      const t = ms / 1_000;
      const progress = back.at(t);
      stretch = follow(stretch, softClamp(back.velocity(t) * 0.05, -0.1, 0.16), 24, dt);
      carry(lerp(exit.x, launchFrom.x, progress), lerp(exit.y, launchFrom.y, progress), 1 - stretch * 0.5, 1 + stretch, 18 * (1 - clamp(progress, 0, 1)));
      mascot.current?.look(center(rest.rect), { x: rest.perch.x + MASCOT / 2, y: rest.perch.y + MASCOT * 0.45 });
    }, signal);
    return settled;
  };

  const restoreAfterFailure = async (signal: AbortSignal) => {
    const rest = snapshotRest();
    mascot.current?.setHappy(false);
    if (prefersReducedMotion()) {
      finishIntro();
      return;
    }
    const pullIn = collapse(rest);
    const back = spring(240, 18);
    await timeline(520, (ms) => {
      const t = ms / 1_000;
      const progress = clamp(1 - back.at(t), 0, 1);
      // Run the collapse backwards on a bouncy spring: the card squelches back out.
      pullIn.frame(progress * COLLAPSE_MS);
      placeMascot(rest.perch.x, rest.perch.y);
    }, signal);
    if (!signal.aborted) finishIntro();
  };

  const playClose = async (signal: AbortSignal) => {
    const rest = snapshotRest();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (prefersReducedMotion()) return;
    const pullIn = collapse(rest);
    // The duck starts exactly when the collapse ends, so the shot and hands hand over from the
    // collapse to the robot without a jump; the anticipation hop happens just before.
    const DUCK = { start: COLLAPSE_MS, end: COLLAPSE_MS + 340 };
    await timeline(DUCK.end, (ms) => {
      if (ms <= COLLAPSE_MS) pullIn.frame(ms);
      else placeGoo({ x: 0, y: 0, width: 0, height: 0 }, null, 0);
      const duck = easeInCubic(window01(ms, DUCK.start, DUCK.end));
      const dy = duck * (viewport.height - rest.perch.y + 40);
      const hop = Math.sin(Math.PI * smooth(window01(ms, DUCK.start - 150, DUCK.start))) * 8;
      placeMascot(rest.perch.x, rest.perch.y + dy - hop, 1, 1 + duck * 0.08);
      if (ms > COLLAPSE_MS) {
        const shot = pullIn.shotAt(ms);
        placeFly({ ...shot, y: shot.y + dy }, 6, pullIn.rotateAt(ms), 1.2, 0.2);
        pullIn.handsAt(ms).forEach((point, index) => placeHand(index, { x: point.x, y: point.y + dy }));
      }
      mascot.current?.look({ x: rest.perch.x + MASCOT / 2, y: viewport.height }, { x: rest.perch.x + MASCOT / 2, y: rest.perch.y + MASCOT * 0.45 });
    }, signal);
  };

  /** Leaving mid-intro: the whole stage fades out together (160 ms), then resets. */
  const fadeAway = async (signal: AbortSignal) => {
    const element = stage.current;
    if (!element) return;
    if (!prefersReducedMotion()) {
      await timeline(160, (ms) => { element.style.opacity = (1 - smooth(ms / 160)).toFixed(3); }, signal);
    }
    element.style.opacity = "0";
    if (signal.aborted) element.style.opacity = "";
  };

  const startScene = () => {
    scene.current?.abort();
    const controller = new AbortController();
    scene.current = controller;
    return controller.signal;
  };

  // ---- Lifecycle -----------------------------------------------------------------------

  const close = useCallback(async () => {
    const from = phaseRef.current;
    // Esc works from the first frame: mid-intro there's no settled card to pull back in, so
    // everything just fades away from wherever it is.
    if (from !== "compose" && from !== "intro") return;
    endDrag();
    setMenuOpen(false);
    setPhase("closing");
    setInteractive(false);
    flushDraft(textRef.current);
    const shotId = shotRef.current?.id ?? "";
    const signal = startScene();
    if (from === "intro") await fadeAway(signal);
    else await playClose(signal);
    if (signal.aborted) return;
    bridge()?.close(shotId);
    setPhase("idle");
    releaseShot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishSent = useCallback(() => {
    setSent((current) => (current ? { ...current, leaving: true } : current));
    window.clearTimeout(sentLeaveTimer.current);
    sentLeaveTimer.current = window.setTimeout(() => {
      if (phaseRef.current !== "sent") return;
      setInteractive(false);
      bridge()?.close(shotRef.current?.id ?? "");
      setSent(null);
      setPhase("idle");
      releaseShot();
      // After the pill's 200 ms fade has presented its last frame.
    }, 280);
  }, [setPhase]);

  const sentTimer = useRef(0);
  const scheduleSentExit = useCallback((delay = SENT_PILL_MS) => {
    window.clearTimeout(sentTimer.current);
    sentTimer.current = window.setTimeout(finishSent, delay);
  }, [finishSent]);

  const send = useCallback(async () => {
    // Sending while dictating finishes the dictation first, then sends with its words. Too
    // early to have said anything (still starting, or under the minimum): drop it and send.
    const dictation = voiceRef.current;
    if (dictation.state === "requesting" || (dictation.state === "recording" && dictation.elapsedMs < MIN_VOICE_NOTE_MS)) {
      dictation.cancel();
    } else if (dictation.active) {
      sendAfterDictation.current = true;
      if (dictation.state === "recording") dictation.stop();
      return;
    }
    const loaded = shotRef.current;
    const target = roster.bots.find((candidate) => candidate.id === botId);
    if (phaseRef.current !== "compose" || !loaded || !target || !bridge()) return;
    setMenuOpen(false);
    setError(null);
    setPhase("sending");
    setInteractive(false);
    writeStorage(BOT_KEY, target.id);
    // The words leave with the shot: a retake mid-send must not offer them to send again.
    const sentText = text;
    setText("");
    flushDraft("");
    const result = bridge()!.send({ shotId: loaded.id, botId: target.id, content: sentText }).catch(
      (): AppshotSendResult => ({ ok: false, error: "This appshot couldn’t be sent." })
    );
    const signal = startScene();
    const outcome = await playSend(signal, result, () => {
      setSent({ bot: target, leaving: false });
      setPhase("sent");
      scheduleSentExit();
    });
    if (signal.aborted) {
      // A retake took over mid-send. If the send then failed, the words come back to the new
      // composer with the reason, rather than vanishing as if they'd gone.
      if (!outcome.ok) {
        setText((current) => current || sentText);
        setError(outcome.error);
      }
      return;
    }
    if (!outcome.ok) {
      setText((current) => current || sentText);
      setPhase("intro");
      await restoreAfterFailure(signal);
      setError(outcome.error);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, roster.bots, text, scheduleSentExit, setPhase]);

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    const stopShot = api.onShot(async (incoming: AppshotShot) => {
      const signal = startScene();
      window.clearTimeout(sentTimer.current);
      window.clearTimeout(sentLeaveTimer.current);
      // The window comes back click-through; keep the local state in step.
      interactive.current = false;
      // A retake while dictating keeps the words: finish the recording instead of dropping it
      // (unless it's too short to hold any). A pending "send when transcribed" belonged to the
      // old shot, and an old error (with its retry of the old audio) doesn't carry over.
      sendAfterDictation.current = false;
      endDrag();
      const dictation = voiceRef.current;
      if (dictation.state === "recording") {
        if (dictation.elapsedMs < MIN_VOICE_NOTE_MS) dictation.cancel();
        else dictation.stop();
      } else if (dictation.state === "requesting" || dictation.state === "error") dictation.cancel();
      refreshAppshotTheme(incoming.roster.theme);
      const { blob, url } = await decodeShot(incoming.image);
      if (signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      const previous = shotRef.current;
      const next: LoadedShot = {
        id: incoming.id,
        url,
        // Until the small copies are ready: the full image stands in for the thumbnail.
        thumb: url,
        texture: "",
        frame: { x: incoming.offsetX, y: incoming.offsetY, width: incoming.width, height: incoming.height },
        aspect: incoming.width / Math.max(1, incoming.height),
        workArea: incoming.workArea,
      };
      shotRef.current = next;
      // Coming from another display, the card starts in its usual place there.
      const size = `${next.frame.width}x${next.frame.height}`;
      if (lastDisplay.current && lastDisplay.current !== size) position.current = null;
      lastDisplay.current = size;
      if (incoming.rosterVersion >= rosterVersion.current) {
        rosterVersion.current = incoming.rosterVersion;
        setRoster(incoming.roster);
        setBotId((current) => pickBot(incoming.roster, current));
      }
      setText((current) => current || incoming.draft);
      setError(null);
      setSent(null);
      setMenuOpen(false);
      setShot(next);
      setPhase("intro");
      if (previous) window.setTimeout(() => revokeShot(previous), 2_000);
      void shotDerivatives(blob, incoming.width * (window.devicePixelRatio || 1)).then((made) => {
        if (shotRef.current !== next) {
          revokeShot({ url: "", texture: made.texture, thumb: made.thumb || "x" });
          return;
        }
        const ready: LoadedShot = { ...next, texture: made.texture, thumb: made.thumb || url };
        shotRef.current = ready;
        setShot(ready);
      });
    });
    const stopRoster = api.onRoster((next) => {
      // An older list (from a shot that was already in flight) never replaces a newer one.
      if ((next.version ?? 0) < rosterVersion.current) return;
      rosterVersion.current = next.version ?? rosterVersion.current;
      refreshAppshotTheme(next.theme);
      setRoster(next);
      setBotId((current) => pickBot(next, current));
    });
    return () => {
      stopShot();
      stopRoster();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new shot: lay out its first frame (the screen, unchanged), show the window, play.
  useLayoutEffect(() => {
    if (!shot) return;
    resetPieces();
    resizeInput(false);
    applyCardPosition();
    placeFly(shot.frame, 0, 0, 0, 0);
    placeMascot(0, window.innerHeight + 200);
    hands.current.forEach((_, index) => placeHand(index, { x: -50, y: -50 }, 0));
    placeGoo({ x: 0, y: 0, width: 0, height: 0 }, null, 0);
    input.current?.focus();
    bridge()?.ready();
    bridge()?.focus();
    const signal = scene.current?.signal ?? startScene();
    let started = false;
    // Give the window a frame to come on screen, so the flash isn't missed.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      started = true;
      void playIntro(signal);
    }));
    return () => {
      if (!started) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Keyed on the shot's id: its texture and thumbnail arriving later must not restart it.
  }, [shot?.id]);

  useLayoutEffect(() => {
    // Sending clears the text, but the card being pulled in must keep the size it was
    // measured at, or it snaps to one line under the goo.
    if (phaseRef.current === "sending") return;
    resizeInput(phaseRef.current === "compose" || phaseRef.current === "intro");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, error, botId, voice.error, voice.notice, voice.canRetry]);

  useLayoutEffect(() => {
    syncGlass();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, sent, phase, shot?.texture]);

  // The draft survives the overlay being released; sync it lazily, not per keystroke.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!shot) return;
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => bridge()?.saveDraft(text), DRAFT_SYNC_MS);
  }, [shot, text]);

  // Click-through everywhere except the card, its menu and the sent pill.
  useEffect(() => {
    const update = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y) as Element | null;
      // After a send the card is gone (only faded): just the pill takes clicks.
      const hit = phaseRef.current === "compose" ? !!target?.closest("[data-hit]")
        : phaseRef.current === "sent" ? !!target?.closest(".appshot-sent")
        : false;
      setInteractive(hit || !!dragging.current);
    };
    rehit.current = () => {
      const at = pointer.current;
      if (at) update(at.x, at.y);
    };
    // Mouse moves are forwarded from anywhere on screen while the card is open; coalesce them
    // to one hit-test (and one glance from the robot) per frame.
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const at = pointer.current;
        if (!at) return;
        update(at.x, at.y);
        // The robot only follows the pointer while the composer has focus.
        if (phaseRef.current === "compose" && !dragging.current && document.hasFocus()) {
          const robot = mascot.current?.root?.getBoundingClientRect();
          const near = robot && Math.hypot(at.x - (robot.left + robot.width / 2), at.y - (robot.top + robot.height / 2)) < 520;
          mascot.current?.look(near ? at : center(toRect(input.current!.getBoundingClientRect())));
        }
      });
    };
    const onFocus = () => {
      setFocused(true);
      const active = document.activeElement;
      if ((phaseRef.current === "intro" || phaseRef.current === "compose") && (!active || active === document.body || active.classList.contains("appshot-close"))) {
        input.current?.focus();
      }
    };
    const onBlur = () => setFocused(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (phase !== "compose" && phase !== "sent") setInteractive(false);
    // Entering compose (or the pill) under a resting pointer: hit-test it now, not on the
    // next mouse move, so the first click lands.
    else rehit.current();
  }, [phase]);

  useEffect(() => {
    const onResize = () => layoutCompose();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sendAfterDictation.current || voice.active) return;
    sendAfterDictation.current = false;
    // Only when the words arrived: a failed transcription leaves the message for review.
    if (voice.state === "idle") void send();
  }, [send, voice.active, voice.state]);

  // Leaving the composer (sending, closing, a new shot) always releases the microphone.
  useEffect(() => {
    // A retake ("intro") finishes a recording in onShot; anything else releases the mic.
    if (phase !== "compose" && phase !== "intro" && (voiceRef.current.active || voiceRef.current.state === "error")) {
      sendAfterDictation.current = false;
      voiceRef.current.cancel();
    }
  }, [phase]);

  const toggleDictation = useCallback(() => {
    const current = voiceRef.current;
    if (!current.available) return;
    // A quick on/off (or a spammed ⌘D) cancels quietly instead of reporting "too short".
    if (current.state === "requesting" || (current.state === "recording" && current.elapsedMs < MIN_VOICE_NOTE_MS)) current.cancel();
    else if (current.state === "recording") current.stop();
    else if (current.state !== "processing") {
      input.current?.focus();
      current.start();
    }
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // Esc during IME composition dismisses the candidates, not the composer.
      if (event.isComposing || event.keyCode === 229) return;
      // Esc leaves early too: mid-intro, and on the "Sent" pill (which otherwise waits).
      if (event.key === "Escape" && !event.defaultPrevented && !event.repeat) {
        if (phaseRef.current === "intro") {
          event.preventDefault();
          void close();
          return;
        }
        if (phaseRef.current === "sent") {
          event.preventDefault();
          window.clearTimeout(sentTimer.current);
          finishSent();
          return;
        }
      }
      if (phaseRef.current !== "compose") return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        if (menuOpen) setMenuOpen(false);
        else if (voiceRef.current.active) {
          sendAfterDictation.current = false;
          voiceRef.current.cancel();
        } else void close();
        return;
      }
      // The app's shortcuts (Settings › Keyboard), matched on physical keys, so they work on any
      // keyboard layout.
      if (isShortcut(event, "dictate")) {
        event.preventDefault();
        if (!event.repeat) toggleDictation();
        return;
      }
      const step = menuOpen ? 0 : isShortcut(event, "nextBot") ? 1 : isShortcut(event, "previousBot") ? -1 : 0;
      if (step && roster.bots.length > 1) {
        event.preventDefault();
        setBotId((current) => {
          const index = roster.bots.findIndex((candidate) => candidate.id === current);
          return roster.bots[((index < 0 ? 0 : index) + step + roster.bots.length) % roster.bots.length]!.id;
        });
        mascot.current?.boing(0.8);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && /^Digit[1-9]$/.test(event.code)) {
        const chosen = roster.bots[Number(event.code.slice(5)) - 1];
        if (chosen) {
          event.preventDefault();
          setBotId(chosen.id);
          setMenuOpen(false);
          mascot.current?.boing(0.8);
          input.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // Dictation on Fn: only main sees that key (through the native helper) and forwards it.
    const stopShortcut = bridge()?.onShortcut((action) => {
      if (action === "dictate" && phaseRef.current === "compose" && shortcutBinding("dictate") === FN_KEY) toggleDictation();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      stopShortcut?.();
    };
  }, [close, finishSent, menuOpen, roster.bots, toggleDictation]);

  // ---- Interaction ---------------------------------------------------------------------

  const onInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    // Keys typed while the card is leaving would come back as the next appshot's draft.
    if (phaseRef.current !== "compose" && phaseRef.current !== "intro") return;
    setText(event.target.value);
    setError(null);
    const now = performance.now();
    if (now - lastBoing.current > 140) {
      lastBoing.current = now;
      mascot.current?.boing(0.32);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // Return while dictating stops and inserts the words, like the system's dictation; too
      // soon to have said anything, it just stops.
      if (voice.state === "requesting" || (voice.state === "recording" && voice.elapsedMs < MIN_VOICE_NOTE_MS)) voice.cancel();
      else if (voice.state === "recording") voice.stop();
      else void send();
    }
  };

  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || phaseRef.current !== "compose") return;
    const target = event.target as HTMLElement;
    if (target.closest("textarea, button, input, [role=option], .appshot-menu")) return;
    event.preventDefault();
    dragging.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    card.current?.setPointerCapture(event.pointerId);
    card.current?.setAttribute("data-dragging", "");
    setMenuOpen(false);
  };
  const dragFrame = useRef(0);
  const onCardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== event.pointerId || !position.current) return;
    position.current = {
      x: position.current.x + event.clientX - drag.x,
      bottom: position.current.bottom + event.clientY - drag.y,
    };
    drag.x = event.clientX;
    drag.y = event.clientY;
    // Pointer events can outpace the display: lay out at most once per frame.
    if (!dragFrame.current) {
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = 0;
        layoutCompose();
      });
    }
  };
  const onCardPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || dragging.current.pointerId !== event.pointerId) return;
    dragging.current = null;
    card.current?.removeAttribute("data-dragging");
    if (position.current) {
      writeStorage(POSITION_KEY, JSON.stringify({
        x: position.current.x / window.innerWidth,
        bottom: position.current.bottom / window.innerHeight,
      }));
    }
    input.current?.focus();
  };

  const viewport = shot?.frame;
  const stageWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const stageHeight = typeof window === "undefined" ? 0 : window.innerHeight;

  return (
    <div
      ref={stage}
      className="appshot-stage"
      data-phase={phase}
      data-inactive={!focused || undefined}
      style={shot ? undefined : { visibility: "hidden" }}
    >
      <div className="appshot-mascot-layer">
        <Mascot ref={mascot} size={MASCOT} />
      </div>

      <svg ref={goo} className="appshot-goo" width={stageWidth} height={stageHeight} aria-hidden="true">
        <defs>
          <filter id="appshot-goo" ref={(element) => { gooFilters.current[0] = element; }} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" />
            <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -12" />
          </filter>
          {/* The card's own shadow (--shadow: two layers, each offset, blurred and pulled in
              by its spread), drawn under the goo's shape, so the two hand over as one. A box
              shadow's blur radius is two standard deviations. */}
          <filter id="appshot-goo-shadow" ref={(element) => { gooFilters.current[1] = element; }} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="soft" />
            <feColorMatrix in="soft" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 26 -12" result="shape" />
            <feMorphology in="shape" operator="erode" radius="14" result="farShape" />
            <feGaussianBlur in="farShape" stdDeviation="32" result="farBlur" />
            <feOffset in="farBlur" dy="26" result="farOffset" />
            <feFlood className="appshot-goo-shadow-far" result="farColor" />
            <feComposite in="farColor" in2="farOffset" operator="in" result="far" />
            <feMorphology in="shape" operator="erode" radius="8" result="nearShape" />
            <feGaussianBlur in="nearShape" stdDeviation="11" result="nearBlur" />
            <feOffset in="nearBlur" dy="10" result="nearOffset" />
            <feFlood className="appshot-goo-shadow-near" result="nearColor" />
            <feComposite in="nearColor" in2="nearOffset" operator="in" result="near" />
            <feMerge><feMergeNode in="far" /><feMergeNode in="near" /></feMerge>
          </filter>
          <mask ref={gooMask} id="appshot-goo-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="0" height="0" style={{ maskType: "alpha" }}>
            <g filter="url(#appshot-goo)">
              <rect ref={(element) => { gooShapes.current[0] = element; }} fill="#fff" />
              <circle ref={(element) => { gooDrops.current[0] = element; }} fill="#fff" />
            </g>
          </mask>
        </defs>
        <g ref={gooShadow} filter="url(#appshot-goo-shadow)">
          <rect ref={(element) => { gooShapes.current[1] = element; }} fill="#fff" />
          <circle ref={(element) => { gooDrops.current[1] = element; }} fill="#fff" />
        </g>
        <g mask="url(#appshot-goo-mask)">
          {shot?.texture && (
            <image href={shot.texture} x="0" y="0" width={stageWidth} height={stageHeight} preserveAspectRatio="none" />
          )}
          <rect ref={gooTint} className="appshot-goo-tint" x="0" y="0" width="0" height="0" />
        </g>
      </svg>

      <div
        ref={card}
        className="appshot-card"
        data-hit=""
        data-voice-mode={voiceMode ?? undefined}
        style={{ width: CARD_WIDTH, ...(bot ? { ["--send" as string]: bot.color } : {}) }}
        onPointerDown={onCardPointerDown}
        onPointerMove={onCardPointerMove}
        onPointerUp={onCardPointerUp}
        onPointerCancel={onCardPointerUp}
        onLostPointerCapture={onCardPointerUp}
      >
        <div
          ref={glass}
          className="appshot-card-glass"
          aria-hidden="true"
          // Until the blurred texture is ready, a solid fill: the card is never see-through.
          style={shot?.texture ? { backgroundImage: `url(${shot.texture})`, backgroundSize: `${stageWidth}px ${stageHeight}px` } : { backgroundColor: "var(--glass-solid)" }}
        />
        <div ref={body} className="appshot-card-body">
          <div
            ref={thumb}
            className="appshot-thumb"
            style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10" }}
          >
            {shot && <img alt="Screenshot" src={shot.thumb} draggable={false} />}
          </div>
          <textarea
            ref={input}
            className="appshot-input appshot-in"
            rows={1}
            value={text}
            readOnly={phase === "sending" || phase === "sent" || phase === "closing"}
            maxLength={MAX_TEXT}
            placeholder={bot ? `Ask ${bot.name} about your screen…` : "Ask about your screen…"}
            spellCheck
            onChange={onInput}
            onKeyDown={onInputKeyDown}
            onScroll={(event) => { if (growingPinned.current) event.currentTarget.scrollTop = 0; }}
            aria-label={bot ? `Message to ${bot.name}` : "Message"}
          />
          {/* The notice ("Using the system default microphone") shows here too, as in the chat. */}
          {(error || voice.error || voice.notice) && (
            <div className="appshot-error appshot-in" role="alert">
              {error ?? voice.error ?? voice.notice}
              {!error && voice.canRetry && (
                <button type="button" className="appshot-error-retry" onClick={voice.retry}>Try again</button>
              )}
            </div>
          )}
          {/* Under the voice bar it's hidden: inert, so Tab can't reach its buttons either. */}
          <div className="appshot-footer appshot-in" inert={voiceMode !== null}>
            {bot && (
              <BotPicker
                bots={roster.bots}
                selected={bot}
                open={menuOpen}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (!open) input.current?.focus();
                }}
                onSelect={(chosen) => {
                  setBotId(chosen.id);
                  mascot.current?.boing(0.8);
                }}
              />
            )}
            <span className="appshot-hint" aria-hidden="true">
              <kbd>↩</kbd> send <span className="appshot-hint-dot">·</span> <kbd>⇧↩</kbd> new line
              {voice.available && <><span className="appshot-hint-dot">·</span> <kbd>{dictateText}</kbd> dictate</>}
            </span>
            {voice.available && (
              <DictationButton
                state={voice.state}
                disabled={phase !== "compose"}
                onStart={toggleDictation}
                onStop={toggleDictation}
                shortcut={dictateText}
              />
            )}
            <button
              type="button"
              className="appshot-send"
              aria-label={bot ? `Send to ${bot.name}` : "Send"}
              disabled={!bot || phase !== "compose"}
              onClick={() => void send()}
            >
              <ArrowUp size={15} strokeWidth={2.6} />
            </button>
          </div>
        </div>
        {voiceLayerMode && (
          <div className="appshot-voice">
            <div className="appshot-voice-bar">
            <Suspense fallback={null}>
              <VoiceMemoLayer
                anchor={VOICE_ANCHOR}
                elapsedMs={voice.elapsedMs}
                exiting={voiceExiting}
                mode={voiceLayerMode}
                onCancelProcessing={cancelDictation}
                onDiscard={cancelDictation}
                onLevel={onListenLevel}
                onSend={() => {
                  if (voiceRef.current.state === "requesting") cancelDictation();
                  else void send();
                }}
                radius={VOICE_RADIUS}
                stream={voice.stream}
              />
            </Suspense>
            </div>
          </div>
        )}
        {/* After the text field in the markup: when the panel regains focus, Chromium focuses the
            first focusable element, and that must be the composer, not the close badge. */}
        <button type="button" className="appshot-close" data-glass="" aria-label="Close" tabIndex={phase === "compose" ? 0 : -1} onClick={() => void close()}>
          <X size={9} strokeWidth={3.2} />
        </button>
      </div>

      <div ref={fly} className="appshot-fly" aria-hidden="true">
        {shot && <img alt="" src={shot.url} draggable={false} />}
      </div>
      <i ref={(element) => { hands.current[0] = element; }} className="appshot-hand" />
      <i ref={(element) => { hands.current[1] = element; }} className="appshot-hand" />
      <div ref={sparks} className="appshot-sparks" aria-hidden="true">
        {Array.from({ length: SPARKS }, (_, index) => <i key={index} data-tone={index % 3} />)}
      </div>
      <div ref={flash} className="appshot-flash" />

      {sent && position.current && card.current && (
        <SentPill
          bot={sent.bot}
          leaving={sent.leaving}
          anchor={{
            x: position.current.x + CARD_WIDTH / 2,
            y: position.current.bottom - 28,
          }}
          onOpen={() => {
            window.clearTimeout(sentTimer.current);
            window.clearTimeout(sentLeaveTimer.current);
            setInteractive(false);
            bridge()?.openChat(sent.bot.id);
            setSent(null);
            setPhase("idle");
            releaseShot();
          }}
          onHold={(hold) => (hold ? window.clearTimeout(sentTimer.current) : scheduleSentExit(1_400))}
        />
      )}
    </div>
  );
}

function SentPill({
  bot,
  leaving,
  anchor,
  onOpen,
  onHold,
}: {
  bot: AppshotBot;
  leaving: boolean;
  anchor: { x: number; y: number };
  onOpen: () => void;
  onHold: (hold: boolean) => void;
}) {
  return (
    <div
      className="appshot-sent"
      data-hit=""
      data-centered=""
      data-leaving={leaving || undefined}
      role="status"
      style={{ left: anchor.x, top: anchor.y }}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
    >
      <span className="appshot-sent-glass" data-glass="" aria-hidden="true" />
      <AppshotBotAvatar bot={bot} size={20} />
      <span className="appshot-sent-text">
        Sent to <strong>{bot.name}</strong>
      </span>
      <button type="button" className="appshot-sent-open" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}
