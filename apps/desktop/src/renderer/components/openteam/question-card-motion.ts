/** The question card's motion. A card that settles is replaced by its receipt in
    one commit; this makes that one continuous move. What was chosen stays on
    screen and becomes the receipt (a tile's checkbox turns into the green check,
    its label glides to its line), what was not melts away, and the frame closes
    around what is left. Skip itself travels up to become the "Skipped" chip.

    Everything is Web Animations on top of the DOM React rendered: the content is
    always in its final state, so ending early (unmount, Reduce Motion, a resize)
    is just cancelling. Loaded with the first question card, so it is not in
    startup. */
import "./question-card-motion.css";

type Kind = "pending" | "resolved" | "dismissed";
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** One part of a card as it looked, wherever its animation had got to. */
interface Shot {
  box: Box;
  opacity: number;
  fill: string;
  radius: number;
  ring: string;
  ink: string;
  weight: string;
  /** How much of its check was drawn, 0…1. */
  drawn: number;
  text: string;
  /** It was already on its way out, as a copy. */
  leaving: boolean;
}
interface Snapshot {
  kind: Kind;
  height: number;
  width: number;
  shots: Map<string, Shot>;
  /** The card as it was, to play what leaves. */
  copy: HTMLElement;
  /** Skip was pressed here, just now. */
  skipped: boolean;
}
interface Flight {
  animations: Animation[];
  nodes: Element[];
  copy: HTMLElement | null;
  /** Stand-ins for a part while it travels, by the part they will become. */
  actors: Map<string, { element: Element; fill: () => string }>;
}

/** A curve as a linear() easing: `at` over 0…`end`, in `steps` straight pieces. */
const curve = (at: (time: number) => number, end: number, steps = 28) =>
  `linear(${Array.from({ length: steps + 1 }, (_, step) => (step === steps ? 1 : +at((end * step) / steps).toFixed(3))).join(", ")})`;
/** The step response of an underdamped spring, until it has all but settled. */
const spring = (damping: number) => {
  const beat = Math.sqrt(1 - damping * damping);
  return curve(
    (time) => 1 - Math.exp(-damping * time) * (Math.cos(beat * time) + (damping / beat) * Math.sin(beat * time)),
    -Math.log(0.004) / damping
  );
};

// The curves and clocks, in milliseconds. Shared with the iOS card.
/** Overshoots by 16%: checks, blobs and chips landing. */
const POP = spring(0.5);
/** Overshoots by 8%: tiles arriving. */
const SOFT = spring(0.62);
/** The frame closing and everything riding it: two critically damped springs in
    a row, so it starts gently (22% of the way at 20% of the time), swoops, and
    has a spring's soft tail. No overshoot: the transcript above moves with it. */
const CLOSE = curve((time) => 1 - Math.exp(-time) * (1 + time + time ** 2 / 2 + time ** 3 / 6), 12, 32);
const EASE = "cubic-bezier(0.2, 0.8, 0.3, 1)";
/** The frame's height, the survivors' glide and the accordion all share this. */
const CLOSING = 460;
/** A part that leaves is gone by here, one after another this far apart. */
const MELT = 190;
const MELT_EACH = 10;
/** Skip: the card waits this long for the blob to get clear before it closes. */
const CLEAR = 90;
/** Single choice: the radio's dot fills before anything moves. */
const LEAD = 90;
/** A check's green burst and settle. */
const BURST = 520;
/** Skip: gathers into a blob, flies, lands as the chip. */
const LIFT = 70;
const FLY = 250;
const LAND = 200;
/** A chip with no button behind it buds out of the trailing edge. */
const BUD = 500;
/** Height changes that are not a settle: a taller answer, an error line. */
const RESIZE = 200;
const ARRIVE = { wait: 20, each: 30, duration: 460 };

const numbers = (value: string) => (value.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
/** [r, g, b, alpha] of a computed colour. */
const rgba = (color: string): [number, number, number, number] => {
  const [r = 0, g = 0, b = 0, a = 1] = numbers(color);
  return color.startsWith("color(") ? [r * 255, g * 255, b * 255, a] : [r, g, b, a];
};
const solid = (color: string) => {
  const [r, g, b] = rgba(color);
  return `rgb(${r} ${g} ${b})`;
};
const clear = (color: string) => {
  const [r, g, b] = rgba(color);
  return `rgb(${r} ${g} ${b} / 0)`;
};
const px = (value: number) => `${+value.toFixed(2)}px`;

const textOf = (element: Element) =>
  (element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "")).trim();
/** A spring's step response (damping 0.5) over 0…1: past the mark, back, settled. */
const bounce = (time: number) => {
  const t = Math.max(0, time) * 9;
  return time >= 1 ? 1 : 1 - Math.exp(-0.5 * t) * (Math.cos(0.866 * t) + 0.577 * Math.sin(0.866 * t));
};
const mix = (from: number, to: number, time: number) => from + (to - from) * Math.max(0, Math.min(1, time));

const kindOf = (card: Element | null) => (card as HTMLElement | null)?.dataset.richWidgetState as Kind | undefined;

/** A card's parts by a name that is the same before and after it settles:
    option 2's control is `ctl:2` as a checkbox and as the receipt's check. */
const partsOf = (card: Element) => {
  const parts = new Map<string, HTMLElement>();
  const put = (key: string, element: Element | null | undefined) => {
    if (element) parts.set(key, element as HTMLElement);
  };
  put("prompt", card.querySelector(".question-prompt"));
  put("help", card.querySelector(".question-help"));
  card.querySelectorAll("button.widget-option").forEach((tile, index) => {
    put(`opt:${index}`, tile);
    put(`ctl:${index}`, tile.querySelector(".question-control"));
    put(`lbl:${index}`, tile.querySelector(".widget-option-label"));
  });
  const custom = card.querySelector(".widget-custom");
  put("opt:c", custom);
  put("ctl:c", custom?.querySelector(".question-control"));
  put("lbl:c", custom?.querySelector("textarea"));
  put("error", card.querySelector(".question-error"));
  put("hint", card.querySelector(".question-hint"));
  put("skip", card.querySelector(".question-skip"));
  put("submit", card.querySelector(".widget-submit"));
  card.querySelectorAll<HTMLElement>(".question-answer").forEach((row) => {
    const index = row.dataset.option ?? "c";
    put(`ctl:${index}`, row.querySelector(".question-answer-check"));
    put(`lbl:${index}`, row.querySelector(".widget-option-label"));
  });
  put("chip", card.querySelector(".widget-dismissed-pill"));
  return parts;
};

let serial = 0;

export function attachQuestionMotion(frame: HTMLElement) {
  const inner = frame.firstElementChild as HTMLElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const card = () => inner.firstElementChild as HTMLElement | null;
  let height = inner.offsetHeight;
  let width = inner.offsetWidth;
  let tween: Animation | null = null;
  let flight: Flight | null = null;
  let pressed: { skip: boolean; at: number } | null = null;
  let error = inner.querySelector(".question-error");

  // The card's row may still be scaled by its entrance: measure in the frame's
  // own pixels.
  const lens = () => {
    const origin = frame.getBoundingClientRect();
    const zoom = origin.width / frame.offsetWidth || 1;
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      // A field's text starts inside its padding.
      const pad = element instanceof HTMLTextAreaElement ? Number.parseFloat(getComputedStyle(element).paddingTop) : 0;
      return {
        x: (rect.left - origin.left) / zoom,
        y: (rect.top - origin.top) / zoom + pad,
        w: rect.width / zoom,
        h: rect.height / zoom - 2 * pad,
      };
    };
    return { height: origin.height / zoom, box };
  };

  const resize = (from: number, to: number, duration: number, easing: string, delay = 0) => {
    tween?.cancel();
    tween = null;
    if (Math.abs(from - to) < 0.5) return;
    const current = frame.animate([{ height: px(from) }, { height: px(to) }], { duration, easing, delay, fill: "backwards" });
    tween = current;
    current.onfinish = current.oncancel = () => {
      if (tween === current) tween = null;
    };
  };

  const land = () => {
    if (!flight) return;
    const { animations, nodes } = flight;
    flight = null;
    delete frame.dataset.flying;
    for (const animation of animations) animation.cancel();
    for (const node of nodes) node.remove();
  };
  const fly = () => {
    land();
    const current: Flight = { animations: [], nodes: [], copy: null, actors: new Map() };
    flight = current;
    frame.dataset.flying = "";
    const play = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = element.animate(frames, { fill: "both", ...options });
      current.animations.push(animation);
      return animation;
    };
    // The flight ends on its animations' own clock, so nothing here depends on timers.
    const settled = () =>
      void Promise.all(current.animations.map((animation) => animation.finished)).then(
        () => flight === current && land(),
        () => undefined
      );
    return { current, play, settled };
  };

  const shown = (element: Element) => {
    let opacity = 1;
    for (let node: Element | null = element; node && node !== frame; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node === element && style.visibility === "hidden") return 0;
      opacity *= Number(style.opacity);
    }
    return opacity;
  };
  const shoot = (element: HTMLElement, box: Box, opacity: number, leaving: boolean): Shot => {
    const style = getComputedStyle(element);
    const blob = getComputedStyle(element, "::before");
    const filled = blob.content !== "none" && blob.content !== "normal" && (numbers(blob.transform)[0] ?? 1) > 0.5;
    const check = element.matches(".question-answer-check, .question-control:not(.question-control-pencil)")
      ? element.querySelector("path")
      : null;
    return {
      box,
      opacity,
      leaving,
      fill: filled ? blob.backgroundColor : style.backgroundColor,
      radius: Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, box.h / 2),
      ring: !filled && Number.parseFloat(style.borderTopWidth) > 0 ? style.borderTopColor : "transparent",
      ink: style.color,
      weight: style.fontWeight,
      drawn: check ? 1 - Math.min(1, Number.parseFloat(getComputedStyle(check).strokeDashoffset) || 0) : 0,
      text: textOf(element),
    };
  };

  /** A copy of the card that can be shown in its place: inert, anonymous, and
      looking the way the card did under the pointer. */
  const copyOf = (now: HTMLElement, cardWidth: number) => {
    const copy = now.cloneNode(true) as HTMLElement;
    copy.classList.add("question-fx");
    copy.removeAttribute("data-rich-widget-state");
    copy.removeAttribute("aria-labelledby");
    copy.removeAttribute("title");
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    copy.style.width = px(cardWidth);
    for (const named of copy.querySelectorAll("[id]")) named.removeAttribute("id");
    const fields = now.querySelectorAll("textarea");
    copy.querySelectorAll("textarea").forEach((field, index) => (field.value = fields[index]?.value ?? ""));
    const twins = partsOf(copy);
    for (const [key, element] of partsOf(now)) {
      const twin = twins.get(key);
      if (!twin || !/^(opt|skip|submit)/.test(key)) continue;
      const style = getComputedStyle(element);
      twin.style.backgroundColor = style.backgroundColor;
      twin.style.borderColor = style.borderTopColor;
      twin.style.color = style.color;
      twin.style.transition = "none";
    }
    return copy;
  };

  /** Called before React replaces the card: what everything looks like now. */
  const before = (): Snapshot | null => {
    const now = card();
    const kind = kindOf(now);
    if (!now || !kind || reduced.matches) return null;
    const { height: tall, box } = lens();
    const shots = new Map<string, Shot>();
    const take = (root: Element, leaving: boolean) => {
      for (const [key, element] of partsOf(root)) {
        const opacity = shown(element);
        if (opacity > 0.02) shots.set(key, shoot(element, box(element), opacity, leaving));
      }
    };
    if (flight?.copy) take(flight.copy, true);
    take(now, false);
    for (const [key, actor] of flight?.actors ?? []) {
      const shot = shots.get(key);
      if (shot) shots.set(key, { ...shot, box: box(actor.element), fill: actor.fill(), leaving: true });
    }
    return {
      kind,
      height: tall,
      width: now.offsetWidth,
      shots,
      copy: copyOf(now, now.offsetWidth),
      skipped: Boolean(pressed?.skip && performance.now() - pressed.at < 1000),
    };
  };

  /** Called once React has replaced the card: play from the snapshot to here. */
  const after = (value: unknown) => {
    const shot = value as Snapshot | null;
    const now = card();
    const kind = kindOf(now);
    const from = shot?.height ?? lens().height;
    land();
    height = inner.offsetHeight;
    width = inner.offsetWidth;
    error = inner.querySelector(".question-error");
    pressed = null;
    if (!now || !kind) return;
    if (reduced.matches) {
      tween?.cancel();
      // No travel: the new card fades up in place.
      inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "linear" });
      return;
    }
    if (!shot || shot.kind === kind) {
      resize(from, height, RESIZE, EASE);
      return;
    }
    const lead = kind === "pending" ? reopen(shot, now) : settle(shot, now, kind);
    resize(from, height, CLOSING, CLOSE, lead);
  };

  /** Where a part starts, as a move and stretch from its resting box. */
  const pose = (from: Box, rest: Box) => ({
    translate: `${px(from.x + from.w / 2 - rest.x - rest.w / 2)} ${px(from.y + from.h / 2 - rest.y - rest.h / 2)}`,
    scale: `${+(from.w / (rest.w || 1)).toFixed(4)} ${+(from.h / (rest.h || 1)).toFixed(4)}`,
  });
  const offset = (from: Box, rest: Box) => `${px(from.x - rest.x)} ${px(from.y - rest.y)}`;

  /** Pending → answered or closed. Returns how long the card holds before it moves. */
  const settle = (shot: Snapshot, now: HTMLElement, kind: Kind) => {
    const { current, play, settled } = fly();
    const copy = shot.copy;
    frame.append(copy);
    current.copy = copy;
    current.nodes.push(copy);
    const { box } = lens();
    const old = partsOf(copy);
    const fresh = partsOf(now);
    const styles = getComputedStyle(now);
    const single = copy.dataset.questionMode === "single";
    const hide = (key: string) => old.get(key)?.style.setProperty("visibility", "hidden");

    // Who survives: a receipt line whose words were on the card.
    const survivors: string[] = [];
    for (const [key, label] of fresh) {
      if (!key.startsWith("lbl:")) continue;
      const was = shot.shots.get(key);
      if (was && was.text === textOf(label) && old.has(key)) survivors.push(key.slice(4));
    }
    const picked = survivors.some((index) => index !== "c");
    const flown = kind === "dismissed" && shot.skipped && shot.shots.has("skip") && fresh.has("chip");
    // `hold`: how long the card stays as it was (the radio's dot fills first).
    // `lead`: how long before it starts to close.
    const hold = single && picked && kind === "resolved" ? LEAD : 0;
    const lead = flown ? CLEAR : hold;

    // As the card closes, everything between two survivors is squeezed out
    // between them. `drift` is how far the closing carries a point of the old card.
    const ties: [number, number][] = [[0, 0]];
    const tie = (key: string) => {
      const was = shot.shots.get(key);
      const part = fresh.get(key);
      if (!was || !part) return;
      const rest = box(part);
      ties.push([was.box.y + was.box.h / 2, rest.y + rest.h / 2]);
    };
    tie("prompt");
    for (const index of survivors) tie(`lbl:${index}`);
    ties.push([Math.max(shot.height, ...ties.map(([y]) => y + 1)), height]);
    ties.sort((a, b) => a[0] - b[0]);
    const drift = (y: number) => {
      const next = ties.findIndex(([from]) => from >= y);
      if (next <= 0) {
        const [from, to] = ties.at(next)!;
        return to - from;
      }
      const [fromA, toA] = ties[next - 1]!;
      const [fromB, toB] = ties[next]!;
      const along = (y - fromA) / (fromB - fromA || 1);
      return toA + (toB - toA) * along - y;
    };

    /** A part of the old card leaves: carried by the closing, squeezed, gone. */
    const melt = (key: string, order: number, squeeze = "0.95 0.5") => {
      const part = old.get(key);
      if (!part) return;
      const rest = box(part);
      const was = shot.shots.get(key);
      const start = was ? pose(was.box, rest) : { translate: "0px 0px", scale: "1 1" };
      play(part, [{ translate: start.translate }, { translate: `0px ${px(drift(rest.y + rest.h / 2))}` }], {
        duration: CLOSING,
        easing: CLOSE,
        delay: lead,
      });
      play(
        part,
        [
          { scale: start.scale, opacity: was?.opacity ?? 0, filter: "blur(0px)" },
          { scale: squeeze, opacity: 0, filter: "blur(4px)" },
        ],
        { duration: MELT, easing: "cubic-bezier(0.3, 0.5, 0.5, 1)", delay: hold + order * MELT_EACH }
      );
    };

    /** A part that is on both cards glides from where it was. */
    const glide = (part: Element, from: Box, rest: Box) =>
      play(part, [{ translate: offset(from, rest) }, { translate: "0px 0px" }], {
        duration: CLOSING,
        easing: CLOSE,
        delay: lead,
      });
    /** Words that survive: they glide, unless they wrap differently now, in
        which case the old lines hand over to the new ones on the way. */
    const carry = (key: string, restyle?: (part: HTMLElement, was: Shot) => void) => {
      const part = fresh.get(key);
      const was = shot.shots.get(key);
      const ghost = old.get(key);
      if (!part) return;
      if (!was) {
        play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: hold + 120, easing: "ease-out" });
        return;
      }
      const rest = box(part);
      glide(part, was.box, rest);
      if (ghost && Math.abs(was.box.h - rest.h) > 1) {
        play(ghost, [{ translate: "0px 0px" }, { translate: offset(rest, box(ghost)) }], {
          duration: CLOSING,
          easing: CLOSE,
          delay: lead,
        });
        play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: hold, easing: "ease-in" });
        play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: hold + 60, easing: "ease-out" });
      } else {
        ghost?.style.setProperty("visibility", "hidden");
        restyle?.(part, was);
      }
    };

    // The prompt stays where it is and takes its settled colour and weight.
    carry("prompt", (part, was) => {
      const rest = getComputedStyle(part);
      play(part, [{ color: was.ink, fontWeight: was.weight }, { color: rest.color, fontWeight: rest.fontWeight }], {
        duration: 300,
        delay: hold,
        easing: "ease",
      });
    });

    // What leaves goes from the bottom up, the way the card closes; the help
    // line right away, since the survivors are headed for its place.
    melt("help", 0, "0.98 0.6");
    let order = 0;
    for (const key of ["submit", "skip", "hint", "error"]) {
      if (key === "skip" && flown) continue;
      melt(key, order, "0.8 0.6");
      if (old.has(key)) order += 1;
    }
    const tiles = [...old.keys()].filter((key) => key.startsWith("opt:")).reverse();
    for (const key of tiles) {
      const index = key.slice(4);
      if (!survivors.includes(index)) {
        melt(key, order++);
        continue;
      }
      // A chosen tile: its control and label go on to the receipt, the tile
      // itself lets go of them.
      const check = fresh.get(`ctl:${index}`);
      const tile = old.get(key)!;
      const surface = shot.shots.get(key);
      // It lets go from however it was pressed.
      const pressedPose = surface ? pose(surface.box, box(tile)) : { translate: "0px 0px", scale: "1 1" };
      play(tile, [{ ...pressedPose, opacity: surface?.opacity ?? 1 }, { translate: "0px 0px", scale: "0.99 0.86", opacity: 0 }], {
        duration: 130,
        easing: "cubic-bezier(0.3, 0.5, 0.5, 1)",
        delay: hold,
      });
      if (hold) {
        // The tap is acknowledged first: the tile takes its chosen look.
        play(
          tile,
          [
            { backgroundColor: tile.style.backgroundColor, borderColor: tile.style.borderColor },
            { backgroundColor: styles.getPropertyValue("--question-fill-selected"), borderColor: styles.getPropertyValue("--question-outline") },
          ],
          { duration: hold, easing: "ease-out" }
        );
      }
      carry(`lbl:${index}`);
      const control = shot.shots.get(`ctl:${index}`);
      if (!check || !control) continue;
      const place = box(check);
      const pencil = index === "c";
      if (pencil) {
        // The pencil hands over to the check on the way up.
        const ghost = old.get("ctl:c");
        if (ghost) {
          ghost.style.visibility = "visible";
          play(ghost, [{ translate: "0px 0px" }, { translate: offset(place, box(ghost)) }], { duration: CLOSING, easing: CLOSE, delay: lead });
          play(ghost, [{ opacity: 1, scale: 1, rotate: "0deg" }, { opacity: 0, scale: 0.4, rotate: "-40deg" }], {
            duration: 170,
            easing: "ease-in",
          });
        }
      } else hide(`ctl:${index}`);
      glide(check, control.box, place);
      burst(check, control, pencil, hold, play, styles);
      if (hold) dot(check, control, place, play, current, styles);
    }

    for (const [key, part] of fresh) {
      // An answer that was not on this card (it came from elsewhere) fades in.
      if (key.startsWith("ctl:") && !survivors.includes(key.slice(4)))
        play(part, [{ opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1 }], { duration: 360, delay: 140, easing: POP });
      if (key.startsWith("lbl:") && !survivors.includes(key.slice(4)))
        play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 140, easing: "ease-out" });
    }

    const chip = fresh.get("chip");
    if (chip) {
      const button = shot.shots.get("skip");
      if (flown && button) skipFlight(chip, button, old.get("skip"), play, current);
      else bud(chip, play, current);
    }
    settled();
    return lead;
  };

  /** The checkbox (or radio, or pencil) becomes the receipt's check: it rounds,
      floods solid green with a pop, and relaxes into the tinted check. */
  const burst = (
    check: HTMLElement,
    was: Shot,
    seed: boolean,
    lead: number,
    play: ReturnType<typeof fly>["play"],
    styles: CSSStyleDeclaration
  ) => {
    const rest = getComputedStyle(check);
    const green = styles.getPropertyValue("--question-green").trim();
    const round = px(check.offsetHeight / 2);
    const ring = (color: string, width: number) => `inset 0 0 0 ${width}px ${color}`;
    const empty = rgba(was.fill)[3] < 0.05;
    play(
      check,
      [
        {
          backgroundColor: empty ? clear(green) : was.fill,
          borderRadius: px(was.radius),
          boxShadow: ring(was.ring, 1.5),
          color: seed ? clear(green) : was.ink,
          scale: seed ? 0.4 : 1,
          easing: "cubic-bezier(0.3, 0, 0.4, 1)",
        },
        { backgroundColor: green, borderRadius: round, boxShadow: ring(clear(was.ring), 0), color: "#fff", scale: 1.24, offset: 0.24, easing: "ease-in-out" },
        { backgroundColor: green, color: "#fff", scale: 0.93, offset: 0.48, easing: "ease-in-out" },
        { scale: 1.04, offset: 0.72, easing: "ease-in-out" },
        { backgroundColor: rest.backgroundColor, borderRadius: round, boxShadow: ring(clear(was.ring), 0), color: rest.color, scale: 1 },
      ],
      // After the radio's lead-in it is a little quicker, so the card is done on time.
      { duration: lead ? BURST - 60 : BURST, delay: lead }
    );
    const glyph = check.querySelector("svg");
    const path = check.querySelector("path");
    // The checkbox's glyph is a hair larger than the receipt's.
    if (glyph && !seed) play(glyph, [{ scale: 14 / (glyph.clientWidth || 14) }, { scale: 1 }], { duration: 200, delay: lead, easing: "ease" });
    if (path && was.drawn < 1)
      play(path, [{ strokeDasharray: 1, strokeDashoffset: 1 - was.drawn }, { strokeDasharray: 1, strokeDashoffset: 0 }], {
        duration: 220,
        delay: lead + 90,
        easing: "cubic-bezier(0.3, 0.8, 0.3, 1)",
      });
  };

  /** Single choice: the radio fills with a dot of goo before it turns green. */
  const dot = (
    check: HTMLElement,
    was: Shot,
    place: Box,
    play: ReturnType<typeof fly>["play"],
    current: Flight,
    styles: CSSStyleDeclaration
  ) => {
    const blob = document.createElement("span");
    blob.className = "question-fx question-fx-blob";
    blob.style.cssText = `z-index:2;transform-origin:50% 50%;width:${px(place.w)};height:${px(place.h)};left:${px(place.x)};top:${px(place.y)};background:${styles.getPropertyValue("--permission-text")}`;
    frame.append(blob);
    current.nodes.push(blob);
    play(blob, [{ translate: offset(was.box, place) }, { translate: "0px 0px" }], { duration: CLOSING, easing: CLOSE, delay: LEAD });
    play(
      blob,
      [
        { scale: 0.4, opacity: 0.35, easing: "cubic-bezier(0.3, 0, 0.3, 1)" },
        { scale: 1.12, opacity: 1, offset: 0.55, easing: "ease-in-out" },
        { scale: 1, opacity: 1, offset: 0.75 },
        { scale: 1, opacity: 0 },
      ],
      { duration: LEAD + 70 }
    );
  };

  /** A stage for goo: blobs in it run together where they touch. Its tint is
      what the blobs' colour is seen through, so they can be a faint fill. */
  const stage = (area: Box, current: Flight, color: string) => {
    const id = `question-goo-${++serial}`;
    const tint = document.createElement("div");
    tint.className = "question-fx";
    tint.style.cssText = `left:${px(area.x)};top:${px(area.y)};width:${px(area.w)};height:${px(area.h)}`;
    tint.innerHTML = `<svg aria-hidden="true" width="0" height="0"><filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -9.5"/></filter></svg><div class="question-fx-goo" style="filter:url(#${id})"></div>`;
    frame.append(tint);
    current.nodes.push(tint);
    const goo = tint.lastElementChild as HTMLElement;
    const blob = () => {
      const element = document.createElement("span");
      element.className = "question-fx-blob";
      element.style.background = color;
      goo.append(element);
      return element;
    };
    return { tint, blob };
  };

  /** Skip becomes the chip: the button gathers into a blob, arcs up to the
      chip's place while the card closes under it, and lands as the chip. */
  const skipFlight = (
    chip: HTMLElement,
    button: Shot,
    ghost: HTMLElement | undefined,
    play: ReturnType<typeof fly>["play"],
    current: Flight
  ) => {
    const { box } = lens();
    const rest = getComputedStyle(chip);
    const target = box(chip);
    const [, , , faint] = rgba(rest.backgroundColor);
    const color = solid(rest.backgroundColor);
    const from = { x: button.box.x + button.box.w / 2, y: button.box.y + button.box.h / 2 };
    const to = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    const reach = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    // A slight arc, bowed into the card.
    const bow = Math.min(46, reach * 0.22);
    const normal = { x: (to.y - from.y) / reach, y: -(to.x - from.x) / reach };
    const side = normal.x > 0 ? -1 : 1;
    const bend = { x: (from.x + to.x) / 2 + normal.x * bow * side, y: (from.y + to.y) / 2 + normal.y * bow * side };
    const along = (u: number) => ({
      x: (1 - u) ** 2 * from.x + 2 * (1 - u) * u * bend.x + u * u * to.x,
      y: (1 - u) ** 2 * from.y + 2 * (1 - u) * u * bend.y + u * u * to.y,
    });
    // Slow off the button, fastest two thirds of the way, still moving as it lands.
    const pace = (time: number) => {
      const t = Math.max(0, Math.min(1, time));
      return t * t * (2.2 - 1.2 * t);
    };
    const total = LIFT + FLY + LAND;
    const core = 28;
    const ease = (t: number) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;
    const at = (time: number) => {
      const flown = (time - LIFT) / FLY;
      const point = along(pace(flown));
      const speed = flown > 0 && flown < 1 ? (pace(flown + 0.02) - pace(flown - 0.02)) / 0.04 / 1.4 : 0;
      const ahead = along(pace(Math.min(1, flown + 0.03)));
      const heading = flown > 0 && flown < 1 ? Math.atan2(ahead.y - point.y, ahead.x - point.x) : -Math.PI / 2;
      const landed = (time - LIFT - FLY) / LAND;
      // Gather: the pill pulls in to a ball, dipping away from where it is headed.
      const gather = ease(time / (LIFT + 40));
      // The landing rings like a spring: wide and flat, then the chip's own shape.
      const wide = landed > 0 ? core + (target.w - core) * bounce(landed) : mix(button.box.w, core, gather);
      const tall = landed > 0 ? core - 2 + (target.h - core + 2) * bounce(landed * 1.15) : mix(button.box.h, core - 2, gather);
      const dip = time < LIFT ? Math.sin((time / LIFT) * Math.PI) * 3 : 0;
      // Round while it flies, so turning it to face its heading shows only as stretch.
      const turn = landed > 0 ? 0 : heading + Math.PI / 2;
      return {
        point: { x: point.x, y: point.y + dip },
        wide,
        tall,
        turn: flown > 0 ? turn : 0,
        stretch: 1 + 0.42 * speed,
        pinch: 1 - 0.2 * speed,
      };
    };
    // The goo is bounded to the path, with room for the blob at either end.
    const room = Math.max(button.box.w, target.w) + 30;
    const left = Math.min(from.x, to.x, bend.x) - room;
    const top = Math.min(from.y, to.y, bend.y) - 50;
    const reachBox: Box = {
      x: left,
      y: top,
      w: Math.max(from.x, to.x, bend.x) + room - left,
      h: Math.max(from.y, to.y, bend.y) + 50 - top,
    };
    const { tint, blob } = stage(reachBox, current, color);
    const steps = 30;
    const frames = (shape: (time: number) => Keyframe) =>
      Array.from({ length: steps + 1 }, (_, step) => ({ offset: step / steps, ...shape((step / steps) * total) }));
    const local = (point: { x: number; y: number }) => `translate(${px(point.x - reachBox.x)}, ${px(point.y - reachBox.y)})`;
    const head = blob();
    play(
      head,
      frames((time) => {
        const { point, wide, tall, turn, stretch, pinch } = at(time);
        return {
          width: px(wide),
          height: px(tall),
          // Stretched along its heading (it faces up at rest, so "along" is its height).
          transform: `${local(point)} rotate(${turn.toFixed(3)}rad) scale(${pinch.toFixed(3)}, ${stretch.toFixed(3)}) translate(-50%, -50%)`,
        };
      }),
      { duration: total }
    );
    // What it leaves behind: a strand from where it was a moment ago, which
    // thins and snaps as it gets away.
    const cling = 70;
    const tail = blob();
    tail.style.width = tail.style.height = "20px";
    play(
      tail,
      frames((time) => {
        // Only while it is in the air: before that there is nothing to trail, and
        // the last of it is drawn in as the blob lands.
        const aloft = Math.max(LIFT, Math.min(LIFT + FLY, time));
        const front = at(aloft).point;
        const rear = at(Math.max(LIFT, aloft - cling)).point;
        const length = Math.hypot(front.x - rear.x, front.y - rear.y);
        const angle = length > 0.5 ? Math.atan2(front.y - rear.y, front.x - rear.x) : Math.atan2(bend.y - from.y, bend.x - from.x);
        const middle = { x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2 };
        const thick =
          Math.max(0.25, 0.9 - length / 90) * Math.min(1, Math.max(0, (time - LIFT) / 24)) * Math.min(1, Math.max(0, (LIFT + FLY - time) / 70));
        return {
          transform: `${local(middle)} rotate(${angle.toFixed(3)}rad) scale(${((length + 14) / 20).toFixed(3)}, ${thick.toFixed(3)}) translate(-50%, -50%)`,
        };
      }),
      { duration: total }
    );
    // The blob is brighter than the chip while it travels, so it can be followed.
    const bright = Math.max(0.2, faint * 4);
    const [, , , pressedFill] = rgba(button.fill);
    play(
      tint,
      [
        { opacity: pressedFill, easing: "ease-out" },
        { opacity: bright, offset: (LIFT + 30) / total },
        { opacity: bright, offset: (LIFT + FLY) / total, easing: "ease-in-out" },
        { opacity: faint, offset: (total - 60) / total },
        { opacity: 0 },
      ],
      { duration: total }
    );
    current.actors.set("chip", {
      element: head,
      fill: () => {
        const [r, g, b] = rgba(color);
        return `rgb(${r} ${g} ${b} / ${Number(getComputedStyle(tint).opacity).toFixed(3)})`;
      },
    });
    // The button's own label goes as the blob gathers; the blob is its pill.
    if (ghost) {
      ghost.style.backgroundColor = "transparent";
      play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: LIFT, easing: "ease-in" });
    }
    // The chip's words resolve inside the blob as it lands, and the chip takes
    // over from the blob once they are the same shape.
    play(
      chip,
      [
        { backgroundColor: clear(rest.backgroundColor), color: clear(rest.color), offset: 0 },
        { backgroundColor: clear(rest.backgroundColor), color: clear(rest.color), offset: (LIFT + FLY + 20) / total },
        { backgroundColor: clear(rest.backgroundColor), color: rest.color, offset: (total - 60) / total },
        { backgroundColor: rest.backgroundColor, color: rest.color, offset: 1 },
      ],
      { duration: total }
    );
    play(chip, [{ scale: 0.7 }, { scale: 1 }], { duration: LAND + 60, delay: LIFT + FLY, easing: POP });
  };

  /** A chip nobody pressed for (the chat moved on, or a newer question took
      over) grows out of the card's trailing edge as a bud of goo. */
  const bud = (chip: HTMLElement, play: ReturnType<typeof fly>["play"], current: Flight) => {
    const { box } = lens();
    const rest = getComputedStyle(chip);
    const target = box(chip);
    const [, , , faint] = rgba(rest.backgroundColor);
    const edge = frame.offsetWidth;
    const area: Box = { x: target.x - 40, y: target.y - 30, w: edge - target.x + 80, h: target.h + 60 };
    const { tint, blob } = stage(area, current, solid(rest.backgroundColor));
    const middle = target.y + target.h / 2 - area.y;
    const home = target.x + target.w / 2 - area.x;
    const place = (x: number, wide: number, tall: number) =>
      `translate(${px(x)}, ${px(middle)}) scale(${wide.toFixed(3)}, ${tall.toFixed(3)}) translate(-50%, -50%)`;
    const steps = 26;
    const frames = (shape: (time: number) => Keyframe) =>
      Array.from({ length: steps + 1 }, (_, step) => ({ offset: step / steps, ...shape(step / steps) }));
    const ease = (time: number) => 1 - (1 - Math.max(0, Math.min(1, time))) ** 3;
    const lip = edge - area.x;
    const end = home + target.w / 2;
    // Where the chip's trailing end is: it starts just past the edge and is drawn
    // in to its place.
    const round = (target.h * 1.3) / target.w;
    // Where the chip's trailing end is: it swells on the edge first, then is
    // drawn in to its place, ahead of the chip reaching its length.
    const trail = (time: number) => mix(lip + target.h * 0.3, end, ease((time - 0.12) / 0.3));
    // The chip is a drop: a round lump on the edge that lengthens past the
    // chip's size and settles into it.
    const head = blob();
    head.style.width = px(target.w);
    head.style.height = px(target.h);
    play(
      head,
      frames((time) => {
        const swell = ease(time / 0.18);
        const long = round * mix(0.3, 1, swell) + (1 - round) * bounce((time - 0.2) / 0.8);
        const tall = mix(0.6, 1.3, swell) - 0.3 * ease((time - 0.2) / 0.4);
        return { transform: place(trail(time) - (target.w * long) / 2, long, tall) };
      }),
      { duration: BUD }
    );
    // It hangs from the edge by a neck, thinner than the drop, which draws out
    // to a thread and lets go.
    const neck = blob();
    neck.style.width = px(target.w);
    neck.style.height = px(target.h);
    play(
      neck,
      frames((time) => {
        const from = trail(time) - target.h * 0.6;
        const thick = mix(0.62, 0, Math.max(0, (time - 0.22) / 0.26) ** 1.6);
        return { transform: place((from + lip + 24) / 2, (lip + 24 - from) / target.w, thick) };
      }),
      { duration: BUD }
    );
    const bright = Math.max(0.18, faint * 3.5);
    play(
      tint,
      [
        { opacity: bright },
        { opacity: bright, offset: 0.6, easing: "ease-in-out" },
        { opacity: faint, offset: 0.86 },
        { opacity: 0 },
      ],
      { duration: BUD }
    );
    const filled = rest.backgroundColor;
    current.actors.set("chip", { element: head, fill: () => filled });
    play(
      chip,
      [
        { backgroundColor: clear(rest.backgroundColor), color: clear(rest.color), offset: 0 },
        { backgroundColor: clear(rest.backgroundColor), color: clear(rest.color), offset: 0.5 },
        { backgroundColor: clear(rest.backgroundColor), color: rest.color, offset: 0.86 },
        { backgroundColor: rest.backgroundColor, color: rest.color, offset: 1 },
      ],
      { duration: BUD }
    );
  };

  /** Answered or closed → pending again: the request failed. Everything goes
      back from wherever it had got to. */
  const reopen = (shot: Snapshot, now: HTMLElement) => {
    const { current, play, settled } = fly();
    const copy = shot.copy;
    copy.style.visibility = "hidden";
    frame.append(copy);
    current.nodes.push(copy);
    const { box } = lens();
    const old = partsOf(copy);
    const fresh = partsOf(now);
    const back = (part: Element, from: Box, rest: Box) =>
      play(part, [{ translate: offset(from, rest) }, { translate: "0px 0px" }], { duration: CLOSING, easing: CLOSE });
    const enter = (part: Element, order: number) =>
      play(
        part,
        [
          { opacity: 0, translate: "0px 6px", scale: 0.97 },
          { opacity: 1, translate: "0px 0px", scale: 1 },
        ],
        { duration: 320, delay: 60 + order * 22, easing: EASE }
      );
    let order = 0;
    for (const [key, part] of fresh) {
      const was = shot.shots.get(key);
      const rest = box(part);
      if (key === "prompt" && was) {
        const style = getComputedStyle(part);
        back(part, was.box, rest);
        play(part, [{ color: was.ink, fontWeight: was.weight }, { color: style.color, fontWeight: style.fontWeight }], {
          duration: 260,
          easing: "ease",
        });
      } else if (key.startsWith("opt:")) {
        const index = key.slice(4);
        const label = shot.shots.get(`lbl:${index}`);
        const words = fresh.get(`lbl:${index}`);
        if (label && !label.leaving && words && label.text === textOf(words)) {
          // A chosen tile closes around its answer again.
          const style = getComputedStyle(part);
          play(
            part,
            [
              { backgroundColor: clear(style.backgroundColor), borderColor: clear(style.borderTopColor) },
              { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor },
            ],
            { duration: 260, delay: 80, easing: "ease-out" }
          );
          for (const child of part.querySelectorAll(".widget-option-description, .widget-option-key, .question-send-inline"))
            play(child, [{ opacity: 0 }, { opacity: getComputedStyle(child).opacity }], { duration: 220, delay: 140, easing: "ease-out" });
        } else if (was) {
          const start = pose(was.box, rest);
          play(part, [{ ...start, opacity: was.opacity }, { translate: "0px 0px", scale: "1 1", opacity: 1 }], {
            duration: 320,
            easing: EASE,
          });
        } else enter(part, order++);
      } else if (key.startsWith("lbl:")) {
        if (was && !was.leaving) back(part, was.box, rest);
      } else if (key.startsWith("ctl:")) {
        if (!was || was.leaving) continue;
        // The green check hands back to the control on the way.
        back(part, was.box, rest);
        play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 40, easing: "ease-out" });
        const ghost = old.get(key);
        if (ghost) {
          ghost.style.visibility = "visible";
          play(ghost, [{ translate: offset(was.box, box(ghost)) }, { translate: offset(rest, box(ghost)) }], {
            duration: CLOSING,
            easing: CLOSE,
          });
          play(ghost, [{ opacity: was.opacity }, { opacity: 0 }], { duration: 180, easing: "ease-in" });
        }
      } else if (key === "skip" && shot.shots.has("chip")) {
        // The chip goes back down into the Skip button.
        const chip = shot.shots.get("chip")!;
        const style = getComputedStyle(part);
        const start = pose(chip.box, rest);
        play(
          part,
          [
            { ...start, backgroundColor: chip.fill, color: clear(style.color) },
            // A blob that had only just left gets its label straight back; a chip
            // that had landed keeps the shape clear until its own words have gone.
            { color: clear(style.color), offset: chip.leaving ? 0 : 0.4 },
            { translate: "0px 0px", scale: "1 1", backgroundColor: style.backgroundColor, color: style.color },
          ],
          { duration: 380, easing: EASE }
        );
        const ghost = old.get("chip");
        if (ghost && !chip.leaving) {
          ghost.style.visibility = "visible";
          ghost.style.backgroundColor = "transparent";
          play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "ease-in" });
        }
      } else if (was) {
        const start = pose(was.box, rest);
        play(part, [{ ...start, opacity: was.opacity }, { translate: "0px 0px", scale: "1 1", opacity: Number(getComputedStyle(part).opacity) }], {
          duration: 320,
          easing: EASE,
        });
      } else if (key === "error") {
        // The reason comes in last, once the card is back.
        play(part, [{ opacity: 0, translate: "0px -4px" }, { opacity: 1, translate: "0px 0px" }], {
          duration: 260,
          delay: 200,
          easing: EASE,
        });
      } else enter(part, order++);
    }
    settled();
    return 0;
  };

  /** A question that arrives live: its tiles rise into place one after another,
      the footer last. Never for history. */
  const arrive = () => {
    const now = card();
    if (!now || kindOf(now) !== "pending" || reduced.matches || !frame.closest('[data-enter="new"]')) return;
    const { play, settled } = fly();
    const rise = (part: Element, order: number) =>
      play(
        part,
        [
          { opacity: 0, translate: "0px 12px", scale: 0.955 },
          { opacity: 1, offset: 0.22 },
          { opacity: 1, translate: "0px 0px", scale: 1 },
        ],
        { duration: ARRIVE.duration, delay: ARRIVE.wait + order * ARRIVE.each, easing: SOFT }
      );
    const tiles = now.querySelectorAll(".widget-option");
    tiles.forEach(rise);
    const footer = now.querySelector(".question-footer");
    if (footer)
      play(footer, [{ opacity: 0, translate: "0px 6px" }, { opacity: 1, translate: "0px 0px" }], {
        duration: 320,
        delay: ARRIVE.wait + tiles.length * ARRIVE.each + 40,
        easing: EASE,
      });
    settled();
  };

  // Resize observations arrive after layout and before paint, so the frame
  // that would have shown the new height starts from the old one instead.
  const observer = new ResizeObserver(() => {
    const next = inner.offsetHeight;
    if (inner.offsetWidth !== width) {
      // The window was resized: nothing that was measured still holds.
      width = inner.offsetWidth;
      land();
    }
    if (next === height) return;
    const from = tween ? lens().height : height;
    height = next;
    if (reduced.matches) {
      tween?.cancel();
      return;
    }
    resize(from, next, RESIZE, EASE);
    const line = inner.querySelector(".question-error");
    if (line && line !== error && !flight)
      line.animate([{ opacity: 0, translate: "0px -4px" }, { opacity: 1, translate: "0px 0px" }], { duration: 260, easing: EASE });
    error = line;
  });
  observer.observe(inner);
  const calm = () => {
    if (!reduced.matches) return;
    land();
    tween?.cancel();
  };
  reduced.addEventListener("change", calm);
  const press = (event: Event) => {
    const button = (event.target as Element | null)?.closest?.("button");
    if (button) pressed = { skip: button.classList.contains("question-skip"), at: performance.now() };
  };
  frame.addEventListener("click", press, true);
  frame.dataset.live = "";
  arrive();

  return {
    before,
    after,
    detach() {
      observer.disconnect();
      reduced.removeEventListener("change", calm);
      frame.removeEventListener("click", press, true);
      land();
      tween?.cancel();
      delete frame.dataset.live;
    },
  };
}
