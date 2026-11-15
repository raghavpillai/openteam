import { BOT_AVATAR_GLYPH_MODES, type BotAvatarMode } from "@openteam/contracts/robot-avatar";

const TRANSITION_MS = 320;
const BRIDGED = ".robot-avatar-body, [data-p], [data-g], [data-sat], [data-track]";

/** A face a reaction swaps in for a moment, or rosy cheeks. */
export type RobotAvatarExpression = "joy" | "squint" | "dizzy" | "blush";

/** One part of the robot moving on its own clock inside a reaction. */
export type RobotAvatarPartMotion = {
  readonly selector: string;
  readonly delay?: number;
  readonly duration: number;
  readonly easing?: string;
  readonly keyframes: Keyframe[];
};

/** A one-shot reaction. It plays on the rig's `transform`, starting from the live pose and
 * taking over from the pose loop for as long as it runs.
 * Keyframes that leave out offsets 0 and 1 start from and land on the live pose, gaze
 * included, so a reaction never jumps. `antenna` adds a follow-through wobble on the
 * antenna, glow and pins; `parts` move other pieces; `expressions` swap the face. */
export type RobotAvatarReaction = {
  readonly duration: number;
  readonly keyframes?: Keyframe[];
  readonly delay?: number;
  readonly easing?: string;
  readonly antenna?: { readonly delay: number; readonly duration: number; readonly keyframes: Keyframe[] };
  readonly parts?: readonly RobotAvatarPartMotion[];
  readonly expressions?: readonly {
    readonly name: RobotAvatarExpression;
    readonly delay?: number;
    readonly duration: number;
  }[];
};

/** Fired on the svg when a robot does something its neighbours may turn to look at. */
export const ROBOT_AVATAR_CUE = "robotavatarcue";
export type RobotAvatarCue = "cheer" | "fail" | "poke";

/** The antenna lags the body, overshoots, and settles. */
export const ROBOT_AVATAR_ANTENNA_WOBBLE: { duration: number; keyframes: Keyframe[] } = {
  duration: 700,
  keyframes: [
    { offset: 0.25, scale: "1.32" },
    { offset: 0.5, scale: "0.88" },
    { offset: 0.72, scale: "1.08" },
  ],
};

/**
 * A pose turned about the vertical axis in perspective, for a real spin rather than a flat
 * card flip. Every spin keyframe shares this function list, so the turn interpolates as an angle.
 */
export const robotAvatarSpin = (lift: number, turn: number, sx = 1, sy = 1): string =>
  `perspective(340px) translate(0px, ${lift}px) rotateY(${turn}deg) scale(${sx}, ${sy})`;

/** Played once when a watched run finishes: a hop with a full spin in the air. */
export const ROBOT_AVATAR_CELEBRATE: RobotAvatarReaction = {
  duration: 1080,
  keyframes: [
    { offset: 0.09, transform: robotAvatarSpin(0, 0, 1.1, 0.88), easing: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
    { offset: 0.38, transform: robotAvatarSpin(-18, 210, 1, 1.06), easing: "cubic-bezier(0.45, 0, 0.75, 0.4)" },
    { offset: 0.62, transform: robotAvatarSpin(0, 360), easing: "ease-out" },
    { offset: 0.74, transform: robotAvatarSpin(0, 360, 1.07, 0.93), easing: "ease-out" },
    { offset: 0.88, transform: robotAvatarSpin(-4, 360, 0.98, 1.02), easing: "ease-in" },
  ],
  antenna: { delay: 380, ...ROBOT_AVATAR_ANTENNA_WOBBLE },
};

/** Before folding into a glyph the robot stretches up for a beat (anticipation). */
export const ROBOT_AVATAR_FOLD: RobotAvatarReaction = {
  duration: 300,
  keyframes: [{ offset: 0.35, scale: "0.9 1.12", easing: "ease-out" }],
};
/** Coming back out of a glyph, the robot lands with a squash and a small rebound. */
export const ROBOT_AVATAR_LAND: RobotAvatarReaction = {
  delay: 330,
  duration: 520,
  keyframes: [
    { offset: 0.3, scale: "1.1 0.9", easing: "ease-out" },
    { offset: 0.62, scale: "0.97 1.04", easing: "ease-in-out" },
  ],
};
/** A failed run: a wince, a short "no" shake, and the slump. */
export const ROBOT_AVATAR_SHAKE: RobotAvatarReaction = {
  duration: 620,
  keyframes: [
    { offset: 0.16, rotate: "-9deg" },
    { offset: 0.38, rotate: "8deg" },
    { offset: 0.6, rotate: "-5deg" },
    { offset: 0.8, rotate: "2deg" },
  ],
  expressions: [{ name: "squint", duration: 560 }],
};

/**
 * Reactions are written with translate, rotate and scale, and played as one transform list
 * in that order. Chromium animates an SVG element's transform cheaply, while animating the
 * individual properties costs a full style and layout pass for every avatar on every frame.
 * A fixed list also interpolates function by function, so a turn stays a turn.
 */
const unit = (value: string, suffix: string) => (/^-?[\d.]+$/.test(value) ? `${value}${suffix}` : value);
function asTransform(frame: Keyframe): Keyframe {
  const { translate, rotate, scale, ...rest } = frame;
  if (translate == null && rotate == null && scale == null) return frame;
  const [tx = "0", ty = "0"] = String(translate ?? "0 0").trim().split(/\s+/);
  const [sx = "1", sy = sx] = String(scale ?? "1").trim().split(/\s+/);
  return {
    ...rest,
    transform: `translate(${unit(tx, "px")}, ${unit(ty, "px")}) rotate(${unit(String(rotate ?? "0"), "deg")}) scale(${sx}, ${sy})`,
  };
}

const isGlyphMode = (mode: string | undefined) =>
  (BOT_AVATAR_GLYPH_MODES as readonly string[]).includes(mode ?? "");

function pose(element: Element) {
  const style = getComputedStyle(element);
  return { transform: style.transform, opacity: style.opacity };
}

/** Each destination pose can retime its own bridge, e.g. pop a glyph in after the robot folds. */
function timing(element: Element): KeyframeAnimationOptions {
  const style = getComputedStyle(element);
  const duration = Number.parseFloat(style.getPropertyValue("--robot-bridge"));
  const delay = Number.parseFloat(style.getPropertyValue("--robot-bridge-delay"));
  const easing = style.getPropertyValue("--robot-bridge-ease").trim();
  return {
    duration: Number.isFinite(duration) ? duration : TRANSITION_MS,
    delay: Number.isFinite(delay) ? delay : 0,
    easing: easing || "ease-in-out",
    fill: "both",
  };
}

const BLINK_COOLDOWN_MS = 1_200;
/**
 * Gaze layers, from fastest to slowest: eyes, face plate, body. Each writes its own
 * individual transform properties inline, which restyles only that element; a custom
 * property would restyle every child of the face on every pointer frame.
 */
type LookLayer = {
  readonly selector: string;
  /** The transform that points this layer toward (x, y); `widen` opens the eyes up. */
  readonly format: (element: SVGElement, x: number, y: number, widen?: number) => string;
  readonly clear: (element: SVGElement) => void;
  /** How a scripted look-around moves this layer: eyes snap, the face and body follow. */
  readonly glance: { readonly move: number; readonly lag: number; readonly easing: string };
};
const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const deg = (value: number) => `${Math.round(value * 100) / 100}deg`;
const eyeRange = new WeakMap<Element, number>();
/** The face plate's own tilt from the artwork, which a head turn adds to. */
const faceTilt = new WeakMap<Element, string>();
const clearTransform = (element: SVGElement) => element.style.removeProperty("transform");
/**
 * Gaze writes plain transforms on elements no CSS loop animates: the eye group's wrapper
 * ([data-look]), the face plate (on top of its artwork tilt) and the rig.
 */
const LOOK_LAYERS: readonly LookLayer[] = [
  {
    selector: "[data-look]",
    format(element, x, y, widen = 0) {
      let range = eyeRange.get(element);
      if (range === undefined) {
        range = Number.parseFloat(getComputedStyle(element).getPropertyValue("--gaze-x")) || 3;
        eyeRange.set(element, range);
      }
      const move = `translate(${px(x * range)}, ${px(y * range * 0.75)})`;
      return widen ? `${move} scale(${Math.round((1 + widen * 0.12) * 1000) / 1000})` : move;
    },
    clear: clearTransform,
    glance: { move: 120, lag: 0, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
  },
  {
    // The face plate turns in perspective toward the look, so the head reads as round.
    selector: "[data-face]",
    format(element, x, y) {
      let tilt = faceTilt.get(element);
      if (tilt === undefined) {
        tilt = element.style.transform;
        faceTilt.set(element, tilt);
      }
      return `translate(${px(x * 2.4)}, ${px(y * 1.8)}) ${tilt} rotateY(${deg(x * 17)}) rotateX(${deg(-y * 13)})`;
    },
    glance: { move: 280, lag: 40, easing: "cubic-bezier(0.3, 1.3, 0.6, 1)" },
    clear(element) {
      const tilt = faceTilt.get(element);
      if (tilt !== undefined) element.style.transform = tilt;
    },
  },
  {
    selector: ".robot-avatar-rig",
    // The same function list reactions use, so a reaction blends in and out of the lean.
    format: (_element, x, y) => `translate(${px(x * 1.5)}, ${px(y)}) rotate(${deg(x * 4)}) scale(1, 1)`,
    clear: clearTransform,
    glance: { move: 420, lag: 90, easing: "cubic-bezier(0.3, 1.5, 0.55, 1)" },
  },
];
export type RobotAvatarLook = readonly [eyes: readonly [number, number], face: readonly [number, number], body: readonly [number, number]];
const round = (value: number) => Math.round(Math.max(-1.2, Math.min(1.2, value)) * 200) / 200;

/** Bridge CSS loops from the live pose, including an interrupted transition. */
export function createRobotAvatarMotion(svg: SVGSVGElement) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let bridges: Animation[] = [];
  let paused: Animation[] = [];
  let reactions: Animation[] = [];
  let lastBlink = -Infinity;
  let layers: SVGElement[][] | null = null;
  const written = ["", "", ""];
  const expressionTimers = new Set<number>();
  const expressionEnds = new Map<RobotAvatarExpression, number>();
  const shown = new Set<RobotAvatarExpression>();
  const syncExpressions = () => {
    if (shown.size) svg.dataset.avatarExpr = [...shown].join(" ");
    else delete svg.dataset.avatarExpr;
  };
  const clearExpressions = () => {
    for (const timer of expressionTimers) window.clearTimeout(timer);
    expressionTimers.clear();
    expressionEnds.clear();
    shown.clear();
    syncExpressions();
  };
  const later = (ms: number, run: () => void) => {
    const timer = window.setTimeout(() => {
      expressionTimers.delete(timer);
      run();
    }, ms);
    expressionTimers.add(timer);
  };
  const cue = (kind: RobotAvatarCue) =>
    svg.dispatchEvent(new CustomEvent<RobotAvatarCue>(ROBOT_AVATAR_CUE, { detail: kind }));

  const clear = () => {
    for (const bridge of bridges) {
      bridge.onfinish = null;
      bridge.cancel();
    }
    // A media-query change can cancel the CSS loops before this cleanup runs.
    // Playing a cancelled CSS animation would restart it despite Reduce Motion.
    for (const animation of paused) {
      if (animation.playState === "paused") animation.play();
    }
    bridges = [];
    paused = [];
  };
  const stopReactions = () => {
    for (const reaction of reactions) reaction.cancel();
    reactions = [];
  };
  const onReducedMotion = () => {
    clear();
    stopReactions();
    clearExpressions();
  };
  reducedMotion.addEventListener("change", onReducedMotion);
  const rig = () => svg.querySelector<SVGGElement>(".robot-avatar-rig");
  const react = (target: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    if (!target || reducedMotion.matches) return;
    options = { fill: "backwards", ...options };
    const reaction = target.animate(keyframes, options);
    reactions.push(reaction);
    reaction.onfinish = () => {
      reactions = reactions.filter((active) => active !== reaction);
    };
  };

  const controller = {
    setMode(mode: BotAvatarMode, animate = true) {
      const previous = svg.dataset.avatarMode;
      if (previous === mode && animate) return;
      const elements = [...svg.querySelectorAll(BRIDGED)];
      const shouldAnimate = animate && !reducedMotion.matches;
      // Read before cancelling: a second state change starts where the first left off.
      const before = shouldAnimate ? elements.map(pose) : [];
      clear();
      svg.dataset.avatarMode = mode;
      svg.dataset.avatarFrom = isGlyphMode(previous) ? "glyph" : "robot";
      if (!shouldAnimate) return;

      // Hold the destination loops at their current frames until the bridge lands.
      // This also preserves loops shared by both modes, such as the blinking cursor.
      const loops = elements.map((element) => element.getAnimations());
      paused = loops.flat();
      for (const animation of paused) animation.pause();
      const after = elements.map(pose);
      bridges = elements.flatMap((element, index) => {
        const from = before[index]!;
        const to = after[index]!;
        if (from.transform === to.transform && from.opacity === to.opacity) {
          for (const animation of loops[index]!) animation.play();
          return [];
        }
        const bridge = element.animate([from, to], timing(element));
        bridge.onfinish = () => {
          for (const animation of loops[index]!) animation.play();
          bridge.cancel();
          bridges = bridges.filter((active) => active !== bridge);
        };
        return [bridge];
      });
      const awake = previous !== undefined && previous !== "still";
      // A run this client watched just finished: cheer once on the way into "done".
      if (mode === "done" && awake && previous !== "idle") {
        controller.play(ROBOT_AVATAR_CELEBRATE);
        cue("cheer");
      } else if (mode === "failed" && awake) {
        controller.play(ROBOT_AVATAR_SHAKE);
        cue("fail");
      }
      else if (isGlyphMode(mode) && !isGlyphMode(previous) && awake) controller.play(ROBOT_AVATAR_FOLD);
      else if (isGlyphMode(previous) && !isGlyphMode(mode) && mode !== "still") controller.play(ROBOT_AVATAR_LAND);
    },
    /** Play a one-shot reaction on the whole robot, for example a poke when it is clicked. */
    /**
     * `interrupt` replaces whatever reaction is playing: the new one starts from the pose
     * the robot is in right now, mid-hop or mid-turn, instead of stacking on top of it.
     */
    play(
      { duration, keyframes, delay = 0, easing, antenna, parts, expressions }: RobotAvatarReaction,
      { interrupt = false }: { interrupt?: boolean } = {}
    ) {
      const target = rig();
      // Where the interrupted reaction has the robot right now.
      let from: Keyframe | null = null;
      if (interrupt) {
        const live = target && reactions.length ? getComputedStyle(target).transform : "none";
        if (live !== "none") from = { offset: 0, transform: live };
        stopReactions();
        clearExpressions();
      }
      if (keyframes) {
        const frames = keyframes.map(asTransform);
        react(target, from ? [from, ...frames] : frames, { duration, delay, ...(easing ? { easing } : {}) });
      }
      if (antenna)
        for (const part of svg.querySelectorAll('[data-p="antenna"], [data-p="glow"], [data-p="pin"]'))
          react(part, antenna.keyframes.map(asTransform), {
            duration: antenna.duration,
            delay: delay + antenna.delay,
            easing: "ease-out",
          });
      for (const part of parts ?? [])
        for (const element of svg.querySelectorAll(part.selector))
          react(element, part.keyframes.map(asTransform), {
            duration: part.duration,
            delay: delay + (part.delay ?? 0),
            ...(part.easing ? { easing: part.easing } : {}),
          });
      for (const expression of expressions ?? [])
        controller.express(expression.name, expression.duration, delay + (expression.delay ?? 0));
    },
    /** Show a face (or blush) for a while; overlapping calls extend it. */
    express(name: RobotAvatarExpression, duration: number, delay = 0) {
      if (reducedMotion.matches) return;
      later(delay, () => {
        const ends = performance.now() + duration;
        expressionEnds.set(name, Math.max(expressionEnds.get(name) ?? 0, ends));
        if (!shown.has(name)) {
          shown.add(name);
          syncExpressions();
        }
        later(duration, () => {
          if (performance.now() + 1 < (expressionEnds.get(name) ?? 0)) return;
          expressionEnds.delete(name);
          shown.delete(name);
          syncExpressions();
        });
      });
    },
    /** Tell neighbouring robots something happened here. */
    cue,
    /** A quick blink; repeated calls within a second are dropped. */
    blink() {
      const now = performance.now();
      if (now - lastBlink < BLINK_COOLDOWN_MS) return;
      lastBlink = now;
      // On the eye wrapper, so a blink keeps wherever the eyes are looking.
      for (const look of svg.querySelectorAll<SVGElement>("[data-look]"))
        react(look, [{ offset: 0.45, transform: `${look.style.transform} scale(1.06, 0.08)`.trim() }], {
          duration: 210,
          easing: "ease-in-out",
        });
    },
    /**
     * Point the eyes, face plate and body toward directions in [-1, 1]; (0, 0) faces front.
     * `widen` (0 to 1) opens the eyes a little, for a robot that is being looked at.
     */
    setLook(look: RobotAvatarLook, widen = 0) {
      layers ??= LOOK_LAYERS.map(({ selector }) => [...svg.querySelectorAll<SVGElement>(selector)]);
      const open = reducedMotion.matches ? 0 : Math.round(Math.max(0, widen) * 100) / 100;
      look.forEach(([x, y], index) => {
        const rx = reducedMotion.matches ? 0 : round(x);
        const ry = reducedMotion.matches ? 0 : round(y);
        const wide = index === 0 ? open : 0;
        const key = rx === 0 && ry === 0 && !wide ? "" : `${rx} ${ry} ${wide}`;
        if (written[index] === key) return;
        written[index] = key;
        for (const element of layers![index]!) {
          if (key) element.style.transform = LOOK_LAYERS[index]!.format(element, rx, ry, wide);
          else LOOK_LAYERS[index]!.clear(element);
        }
      });
    },
    /**
     * Look at a few spots in turn, holding each for `hold` ms, then face front again. It runs
     * as transform animations rather than per-frame gaze, so an idle glance costs little.
     */
    lookAround(stops: readonly (readonly [x: number, y: number, hold: number])[]) {
      if (reducedMotion.matches || !stops.length) return;
      layers ??= LOOK_LAYERS.map(({ selector }) => [...svg.querySelectorAll<SVGElement>(selector)]);
      LOOK_LAYERS.forEach(({ format, glance: { move, lag, easing } }, index) => {
        const total = stops.reduce((sum, [, , hold]) => sum + move + hold, 0) + move;
        for (const element of layers![index]!) {
          const rest = format(element, 0, 0);
          const frames: Keyframe[] = [{ offset: 0, transform: rest, easing }];
          let at = 0;
          for (const [x, y, hold] of stops) {
            const pose = format(element, round(x), round(y));
            at += move;
            frames.push({ offset: at / total, transform: pose });
            at += hold;
            frames.push({ offset: at / total, transform: pose, easing });
          }
          frames.push({ offset: 1, transform: rest });
          react(element, frames, { duration: total, delay: lag });
        }
      });
    },
    look(x: number, y: number) {
      controller.setLook([[x, y], [x, y], [x, y]]);
    },
    setEngaged(engaged: boolean) {
      if (engaged === svg.hasAttribute("data-engaged")) return;
      svg.toggleAttribute("data-engaged", engaged);
      if (engaged) controller.blink();
    },
    dispose() {
      reducedMotion.removeEventListener("change", onReducedMotion);
      clear();
      stopReactions();
      clearExpressions();
      controller.look(0, 0);
      svg.removeAttribute("data-engaged");
      svg.dataset.avatarMode = "still";
      delete svg.dataset.avatarFrom;
    },
  };
  return controller;
}
