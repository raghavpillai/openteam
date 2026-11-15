import {
  ROBOT_AVATAR_DIZZY,
  ROBOT_AVATAR_FIDGETS,
  ROBOT_AVATAR_POKES,
  type RobotAvatarFidget,
} from "@openteam/design-tokens/robot-avatar-pokes";
import { ROBOT_AVATAR_CUE, type RobotAvatarCue } from "@openteam/design-tokens/robot-avatar-motion";
import type { RobotAvatarGaze } from "./robot-avatar-gaze-scope";
import type { createRobotAvatarMotion } from "./robot-avatar-motion";

type Motion = Pick<
  ReturnType<typeof createRobotAvatarMotion>,
  "setLook" | "setEngaged" | "play" | "blink" | "express" | "lookAround"
>;
type Spring = { x: number; y: number; vx: number; vy: number };
/** Somewhere to look for a while instead of at the pointer; `shy` applies even while hovered. */
type Glance = { x: number; y: number; from: number; until: number; shy?: boolean };
type Target = {
  svg: SVGSVGElement;
  motion: Motion;
  follow: boolean;
  /** Hover opens the eyes wide (surprised) instead of looking. */
  emphasis: boolean;
  hovered: boolean;
  springs: [Spring, Spring, Spring];
  /** How wide the eyes are open, 0 to 1; it pops open on hover with a little overshoot. */
  widen: { x: number; v: number };
  /** The avatar's box, re-read a few times a second instead of every frame. */
  box: { x: number; y: number; width: number; at: number } | null;
  glances: Glance[];
  nextFidget: number;
  lastFidget: RobotAvatarFidget | null;
};

/**
 * How far off centre, in avatar widths, the pointer turns the face all the way. A hovered row
 * looks fully toward a pointer at its edge; a follower turns gently across the whole window.
 */
const HOVER_REACH = 0.5;
const FOLLOW_REACH = 2;
/** A busy follower keeps working and watches with about half its attention. */
const BUSY_FOLLOW = 0.55;
/**
 * Eyes, face plate and body each chase their aim on their own spring, fastest first, so a
 * glance leads with the eyes and the body catches up with a little overshoot.
 */
const LAYERS = [
  { stiffness: 30, damping: 0.78 },
  { stiffness: 17, damping: 0.84 },
  { stiffness: 10, damping: 0.56 },
] as const;
/** Followers that have watched a resting pointer for a while start doing their own thing. */
const POINTER_REST_MS = 2_600;
const LOOKER_MODES = new Set(["idle", "waiting", "done", "failed"]);
/** Each robot fidgets every so often; across the screen, at most one starts at a time. */
const FIDGET_TICK_MS = 1_100;
const FIDGET_GAP_MS = 2_200;
const FIDGETS: readonly (readonly [RobotAvatarFidget, number])[] = [
  ["look", 4],
  ["doubleBlink", 2],
  ["tiltLeft", 1],
  ["tiltRight", 1],
  ["hop", 1],
  ["sleepy", 1],
  ["hum", 1],
  ["antenna", 1],
];
const DIZZY_POKES = 5;
const DIZZY_WINDOW_MS = 2_600;
/** Hovered this long without a click, a robot gets bashful: it blushes and looks away. */
const SHY_AFTER_MS = 1_900;

const targets = new Set<Target>();
let pointer: { x: number; y: number } | null = null;
let movedAt = 0;
let frame = 0;
let lastFrame = 0;
let listening = false;
let fidgetTimer = 0;
let lastFidgetAt = 0;

const spring = (): Spring => ({ x: 0, y: 0, vx: 0, vy: 0 });
const WIDEN = { stiffness: 24, damping: 0.5 };
const BOX_TTL_MS = 250;
const random = (min: number, max: number) => min + Math.random() * (max - min);
const center = (svg: SVGSVGElement) => {
  const box = svg.getBoundingClientRect();
  return box.width ? { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width } : null;
};

function aimOf(target: Target, now: number): [number, number] {
  while (target.glances.length && target.glances[0]!.until <= now) target.glances.shift();
  const glance = target.glances.find((entry) => entry.from <= now);
  if (glance && (!target.hovered || glance.shy)) return [glance.x, glance.y];
  if (target.emphasis) return [0, 0];
  const resting = target.svg.dataset.avatarMode === "idle";
  // Hover gaze is for a Bot at rest; a busy one keeps at its work.
  if (!target.follow && (!target.hovered || !resting)) return [0, 0];
  if (!pointer) return [0, 0];
  if (!target.box || now - target.box.at > BOX_TTL_MS) {
    const box = center(target.svg);
    target.box = box && { ...box, at: now };
  }
  const box = target.box;
  if (!box) return [0, 0];
  const reach = Math.max(box.width * (target.follow ? FOLLOW_REACH : HOVER_REACH), 12);
  const strength = target.follow && !resting ? BUSY_FOLLOW : 1;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value)) * strength;
  return [clamp((pointer.x - box.x) / reach), clamp((pointer.y - box.y) / reach)];
}

function step(now: number) {
  frame = 0;
  const dt = Math.min(0.034, lastFrame ? (now - lastFrame) / 1000 : 1 / 60);
  lastFrame = now;
  let moving = false;
  // Read every box before writing any style, so one frame never forces a second layout.
  const aims = [...targets].map((target) => [target, aimOf(target, now)] as const);
  for (const [target, [ax, ay]] of aims) {
    let unsettled = false;
    target.springs.forEach((s, index) => {
      const { stiffness: w, damping: z } = LAYERS[index]!;
      // Semi-implicit Euler on a damped spring: stable at display rates.
      s.vx += (w * w * (ax - s.x) - 2 * z * w * s.vx) * dt;
      s.vy += (w * w * (ay - s.y) - 2 * z * w * s.vy) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (Math.abs(ax - s.x) + Math.abs(ay - s.y) > 0.004 || Math.abs(s.vx) + Math.abs(s.vy) > 0.03)
        unsettled = true;
      else {
        s.x = ax;
        s.y = ay;
        s.vx = s.vy = 0;
      }
    });
    const widen = target.widen;
    const open = target.emphasis && target.hovered ? 1 : 0;
    widen.v += (WIDEN.stiffness ** 2 * (open - widen.x) - 2 * WIDEN.damping * WIDEN.stiffness * widen.v) * dt;
    widen.x += widen.v * dt;
    if (Math.abs(open - widen.x) > 0.005 || Math.abs(widen.v) > 0.05) unsettled = true;
    else {
      widen.x = open;
      widen.v = 0;
    }
    const [eyes, face, body] = target.springs;
    // The eyes stop at their sockets; only the face and body may overshoot.
    const socket = (value: number) => Math.max(-1, Math.min(1, value));
    target.motion.setLook(
      [
        [socket(eyes.x), socket(eyes.y)],
        [face.x, face.y],
        [body.x, body.y],
      ],
      widen.x
    );
    if (unsettled) moving = true;
  }
  if (moving) frame = requestAnimationFrame(step);
  else lastFrame = 0;
}
const wake = () => {
  frame ||= requestAnimationFrame(step);
};

/** Look somewhere for a while, starting `at` ms from now; the springs carry the face along. */
function glance(target: Target, x: number, y: number, at: number, hold: number, shy = false) {
  const now = performance.now();
  target.glances.push({ x, y, from: now + at, until: now + at + hold, shy });
  target.glances.sort((a, b) => a.from - b.from);
  window.setTimeout(wake, at);
  window.setTimeout(wake, at + hold + 16);
}

/** Neighbours turn to see what a robot just did, each a beat after the last. */
function lookAt(source: Target, kind: RobotAvatarCue) {
  const from = center(source.svg);
  if (!from) return;
  for (const target of targets) {
    if (target === source || target.hovered || !LOOKER_MODES.has(target.svg.dataset.avatarMode ?? "")) continue;
    const to = center(target.svg);
    if (!to) continue;
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1 || distance > 760) continue;
    const at = random(60, 260) + distance * 0.22;
    glance(target, (dx / distance) * 0.95, (dy / distance) * 0.95, at, (kind === "poke" ? 760 : 1_300) + random(0, 420));
    if (Math.random() < 0.4) window.setTimeout(() => target.motion.blink(), at + 80);
    if (kind === "cheer" && Math.random() < 0.55) target.motion.express("joy", 720, at + 420);
  }
}

function pickFidget(target: Target): RobotAvatarFidget {
  const antenna = target.svg.querySelector('[data-p="antenna"], [data-p="glow"], [data-p="pin"]');
  const options = FIDGETS.filter(
    ([name]) => name !== target.lastFidget && (name !== "antenna" || antenna)
  );
  let roll = Math.random() * options.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of options) if ((roll -= weight) <= 0) return name;
  return "look";
}

function fidget(now: number) {
  if (document.hidden || now - lastFidgetAt < FIDGET_GAP_MS) return;
  const due = [...targets].filter(
    (target) =>
      !target.hovered &&
      now >= target.nextFidget &&
      target.svg.dataset.avatarMode === "idle" &&
      !target.svg.dataset.avatarExpr &&
      (!target.follow || now - movedAt > POINTER_REST_MS)
  );
  const target = due[Math.floor(Math.random() * due.length)];
  if (!target) return;
  lastFidgetAt = now;
  target.nextFidget = now + (target.follow ? random(4_000, 9_000) : random(9_000, 22_000));
  const name = pickFidget(target);
  target.lastFidget = name;
  if (name !== "look") {
    target.motion.play(ROBOT_AVATAR_FIDGETS[name]);
    return;
  }
  const side = Math.random() < 0.5 ? 1 : -1;
  const first = random(620, 900);
  target.motion.lookAround([
    [-0.85 * side, random(0.05, 0.3), first],
    [0.8 * side, random(-0.35, 0), random(560, 820)],
  ]);
  if (Math.random() < 0.6) window.setTimeout(() => target.motion.blink(), first + 150);
}

function scheduleFidgets() {
  if (fidgetTimer || !targets.size) return;
  fidgetTimer = window.setTimeout(() => {
    fidgetTimer = 0;
    fidget(performance.now());
    scheduleFidgets();
  }, FIDGET_TICK_MS);
}

const onMove = (event: PointerEvent) => {
  pointer = { x: event.clientX, y: event.clientY };
  movedAt = performance.now();
  // The pointer moving again wins a follower's attention back.
  for (const target of targets) if (target.follow) target.glances = target.glances.filter((entry) => entry.shy);
  wake();
};
const onLeaveWindow = () => {
  pointer = null;
  wake();
};

/** One window listener serves every avatar, and only while one is hovered or following. */
function syncListening() {
  const wanted = [...targets].some((target) => target.follow || target.hovered);
  if (wanted !== listening) {
    listening = wanted;
    if (wanted) {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeaveWindow);
      window.addEventListener("blur", onLeaveWindow);
    } else {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
      window.removeEventListener("blur", onLeaveWindow);
    }
  }
  scheduleFidgets();
  wake();
}

/** The next poke per row survives avatar remounts, so repeated clicks keep stepping through. */
const pokeTurns = new WeakMap<Element, number>();
const pokeTimes = new WeakMap<Element, number[]>();

/**
 * Attach pointer gaze, pokes and idle life to one avatar. Hover mode looks at the pointer
 * while it is over the avatar's row; follow mode watches the pointer anywhere in the window.
 * A press on the avatar itself plays the next poke, and neighbours turn to look.
 */
export function attachRobotAvatarGaze(
  svg: SVGSVGElement,
  motion: Motion,
  {
    gaze,
    pokeable,
    scope,
    initial,
  }: {
    gaze: RobotAvatarGaze;
    pokeable: boolean;
    scope: Element;
    /** The event that woke this module, replayed once attached. */
    initial?: PointerEvent;
  }
): () => void {
  const now = performance.now();
  const target: Target = {
    svg,
    motion,
    follow: gaze === "follow",
    emphasis: gaze === "emphasis",
    hovered: false,
    springs: [spring(), spring(), spring()],
    widen: { x: 0, v: 0 },
    box: null,
    glances: [],
    nextFidget: now + random(1_500, 11_000),
    lastFidget: null,
  };
  let shyTimer = 0;
  const cancelShy = () => {
    window.clearTimeout(shyTimer);
    shyTimer = 0;
  };
  /** Stared at for a while: a blush, a bashful look away and down, then back at the pointer. */
  const getShy = () => {
    shyTimer = 0;
    if (!target.hovered || target.emphasis || svg.dataset.avatarMode !== "idle") return;
    const box = center(svg);
    const side = box && pointer ? Math.sign(pointer.x - box.x) || 1 : 1;
    motion.express("blush", 2_400);
    glance(target, -0.75 * side, 0.55, 0, 820, true);
    window.setTimeout(() => motion.blink(), 300);
  };
  // Rows that move under a resting pointer (a reorder, a list update) can report leave
  // and enter on alternate frames. Settle a leave one frame later so that churn never
  // reaches the avatar.
  let pendingLeave = 0;
  const enter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (pendingLeave) cancelAnimationFrame(pendingLeave);
    pendingLeave = 0;
    const arrived = !target.hovered;
    target.hovered = true;
    target.glances = [];
    target.box = null;
    // Only an emphasised avatar reacts to the pointer arriving: a blink and wide eyes.
    if (target.emphasis) motion.setEngaged(true);
    if (arrived) {
      cancelShy();
      shyTimer = window.setTimeout(getShy, SHY_AFTER_MS);
    }
    pointer = { x: event.clientX, y: event.clientY };
    syncListening();
  };
  const leave = () => {
    if (pendingLeave) return;
    pendingLeave = requestAnimationFrame(() => {
      pendingLeave = 0;
      cancelShy();
      target.hovered = false;
      motion.setEngaged(false);
      syncListening();
    });
  };
  const press = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const box = svg.getBoundingClientRect();
    const slop = 3;
    if (
      event.clientX < box.left - slop ||
      event.clientX > box.right + slop ||
      event.clientY < box.top - slop ||
      event.clientY > box.bottom + slop
    )
      return;
    const at = performance.now();
    cancelShy();
    const recent = (pokeTimes.get(scope) ?? []).filter((time) => at - time < DIZZY_WINDOW_MS);
    recent.push(at);
    if (recent.length >= DIZZY_POKES) {
      pokeTimes.set(scope, []);
      motion.play(ROBOT_AVATAR_DIZZY, { interrupt: true });
    } else {
      pokeTimes.set(scope, recent);
      const turn = pokeTurns.get(scope) ?? 0;
      pokeTurns.set(scope, turn + 1);
      motion.play(ROBOT_AVATAR_POKES[turn % ROBOT_AVATAR_POKES.length]!, { interrupt: true });
    }
    target.nextFidget = Math.max(target.nextFidget, at + 6_000);
    lookAt(target, "poke");
  };
  const onCue = (event: Event) => lookAt(target, (event as CustomEvent<RobotAvatarCue>).detail);
  targets.add(target);
  svg.addEventListener(ROBOT_AVATAR_CUE, onCue);
  if (gaze !== "off") {
    scope.addEventListener("pointerenter", enter as EventListener);
    scope.addEventListener("pointerleave", leave);
  }
  if (pokeable) scope.addEventListener("pointerdown", press as EventListener);
  syncListening();
  // The pointer may have left while the module loaded.
  if (initial?.type === "pointerenter" && gaze !== "off" && scope.matches(":hover")) enter(initial);
  if (initial?.type === "pointerdown" && pokeable) {
    if (gaze !== "off" && scope.matches(":hover")) enter(initial);
    press(initial);
  }
  return () => {
    if (pendingLeave) cancelAnimationFrame(pendingLeave);
    cancelShy();
    svg.removeEventListener(ROBOT_AVATAR_CUE, onCue);
    scope.removeEventListener("pointerenter", enter as EventListener);
    scope.removeEventListener("pointerleave", leave);
    scope.removeEventListener("pointerdown", press as EventListener);
    targets.delete(target);
    motion.setEngaged(false);
    motion.setLook([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    syncListening();
  };
}
