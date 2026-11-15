// Resolves the desktop robot stylesheet against each robot's real element tree, so the Swift
// engine plays exactly what the desktop shows. The output is data: per element and mode, the
// resting pose, how a change of mode bridges into it, and the loop that runs there.
import { BOT_AVATAR_MODES, type RobotAvatarShape } from "../../../packages/contracts/src/robot-avatar";
import { robotAvatarTempo } from "../../../packages/design-tokens/src/robot-avatar-artwork";
import {
  ROBOT_AVATAR_GLYPHS,
  robotAvatarLayers,
  type RobotAvatarLayerNode,
} from "../../../packages/design-tokens/src/robot-avatar-expressions";

type Attributes = Record<string, string | number | Readonly<Record<string, string>>>;
/** One element of the tree the desktop renders. */
export interface Element {
  tag: string;
  classes: string[];
  attributes: Attributes;
  children: Element[];
  parent: Element | null;
  /** Position in the exported tree: "rig", "body", "glyph", or a path such as "3/1". */
  id: string;
}
export type Op = ["t", number, number] | ["s", number, number] | ["r", number];
type Easing = string;
interface Bridge { duration: number; delay: number; easing: Easing }
export interface Loop {
  keyframes: string;
  duration: number;
  delay: number;
  /** Adds the avatar's own phase offset to the delay. */
  phased: boolean;
  easing: Easing;
  /** 0 repeats forever. */
  iterations: number;
  fill: string;
  alternate: boolean;
}
export interface State {
  transform: Op[];
  opacity: number;
  visible: boolean;
  bridge: Bridge;
  bridgeFromGlyph: Bridge;
  loop: Loop | null;
}
interface Track<T> { offset: number; value: T | null; easing: Easing | null }
export interface Keyframes { transform: Track<Op[]>[]; opacity: Track<number>[]; dash: Track<number>[] }

// ---- CSS parsing ---------------------------------------------------------------------------
interface Rule { selectors: Selector[]; declarations: [string, string][]; motion: boolean; order: number }
type Simple =
  | { kind: "class" | "tag"; name: string }
  | { kind: "attr"; name: string; op: "" | "=" | "~="; value: string }
  | { kind: "is"; options: Selector[] }
  | { kind: "nth"; a: number; b: number }
  | { kind: "first" | "last" };
type Selector = Simple[][];

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && (separator === " " ? /\s/.test(char) : char === separator)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseCompound(text: string): Simple[] {
  const out: Simple[] = [];
  let rest = text;
  while (rest) {
    let match: RegExpMatchArray | null;
    if ((match = rest.match(/^\.([\w-]+)/))) out.push({ kind: "class", name: match[1]! });
    else if ((match = rest.match(/^\[([\w-]+)(?:(~?=)"([^"]*)")?\]/)))
      out.push({ kind: "attr", name: match[1]!, op: (match[2] ?? "") as "" | "=" | "~=", value: match[3] ?? "" });
    else if (rest.startsWith(":is(")) {
      let depth = 0;
      let end = 3;
      for (; end < rest.length; end++) {
        if (rest[end] === "(") depth++;
        if (rest[end] === ")" && --depth === 0) break;
      }
      out.push({ kind: "is", options: splitTop(rest.slice(4, end), ",").map(parseSelector) });
      match = [rest.slice(0, end + 1)] as unknown as RegExpMatchArray;
    } else if ((match = rest.match(/^:nth-child\((\d+)(n?)\)/)))
      out.push(match[2] ? { kind: "nth", a: Number(match[1]), b: 0 } : { kind: "nth", a: 0, b: Number(match[1]) });
    else if ((match = rest.match(/^:first-child/))) out.push({ kind: "first" });
    else if ((match = rest.match(/^:last-child/))) out.push({ kind: "last" });
    else if ((match = rest.match(/^[a-z]+/))) out.push({ kind: "tag", name: match[0] });
    else throw new Error(`Unsupported selector: ${text}`);
    rest = rest.slice(match[0].length);
  }
  return out;
}
const parseSelector = (text: string): Selector => splitTop(text, " ").map(parseCompound);

export function parseStylesheet(css: string): { rules: Rule[]; keyframes: Map<string, [string, [string, string][]][]> } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const keyframes = new Map<string, [string, [string, string][]][]>();
  const declarations = (body: string): [string, string][] =>
    splitTop(body, ";").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/\s+/g, " ")];
    });
  let order = 0;
  const walk = (source: string, motion: boolean) => {
    let index = 0;
    while (index < source.length) {
      const open = source.indexOf("{", index);
      if (open < 0) break;
      const prelude = source.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      for (; close < source.length && depth > 0; close++) {
        if (source[close] === "{") depth++;
        if (source[close] === "}") depth--;
      }
      const body = source.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude.includes("no-preference"));
      else if (prelude.startsWith("@keyframes")) {
        const frames: [string, [string, string][]][] = [];
        for (const match of body.matchAll(/([^{}]+)\{([^}]*)\}/g))
          for (const offset of match[1]!.split(",")) frames.push([offset.trim(), declarations(match[2]!)]);
        keyframes.set(prelude.replace("@keyframes", "").trim(), frames);
      } else rules.push({ selectors: splitTop(prelude, ",").map(parseSelector), declarations: declarations(body), motion, order: order++ });
      index = close;
    }
  };
  walk(text, false);
  return { rules, keyframes };
}

// ---- matching and cascade ------------------------------------------------------------------
function matchesCompound(element: Element, compound: Simple[]): boolean {
  return compound.every((simple) => {
    switch (simple.kind) {
      case "class": return element.classes.includes(simple.name);
      case "tag": return element.tag === simple.name;
      case "attr": {
        const value = element.attributes[simple.name];
        if (value === undefined) return false;
        if (simple.op === "") return true;
        return simple.op === "=" ? String(value) === simple.value : String(value).split(/\s+/).includes(simple.value);
      }
      case "is": return simple.options.some((option) => matches(element, option));
      case "nth": {
        const position = (element.parent?.children.indexOf(element) ?? 0) + 1;
        return simple.a ? position % simple.a === simple.b % simple.a : position === simple.b;
      }
      case "first": return element.parent?.children[0] === element;
      case "last": return element.parent?.children.at(-1) === element;
    }
  });
}
function matches(element: Element, selector: Selector, at = selector.length - 1): boolean {
  if (!matchesCompound(element, selector[at]!)) return false;
  if (at === 0) return true;
  for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent)
    if (matches(ancestor, selector, at - 1)) return true;
  return false;
}
function specificity(selector: Selector): number {
  let classes = 0;
  let tags = 0;
  for (const compound of selector)
    for (const simple of compound) {
      if (simple.kind === "tag") tags++;
      else if (simple.kind === "is") {
        const best = Math.max(...simple.options.map(specificity));
        classes += Math.floor(best / 1000);
        tags += best % 1000;
      } else classes++;
    }
  return classes * 1000 + tags;
}

const ANIMATION_LONGHANDS = ["name", "duration", "easing", "delay", "count", "direction", "fill"] as const;
function expandAnimation(value: string): [string, string][] {
  if (value === "none") return [["animation-name", "none"]];
  const tokens = splitTop(value, " ");
  const out: Record<string, string> = { name: "", duration: "0s", easing: "ease", delay: "0s", count: "1", direction: "normal", fill: "none" };
  let times = 0;
  for (const token of tokens) {
    if (/^(cubic-bezier|steps)\(|^(ease|linear|ease-in|ease-out|ease-in-out)$/.test(token)) out.easing = token;
    else if (/^(calc|var)\(|^-?[\d.]+m?s$/.test(token)) out[times++ === 0 ? "duration" : "delay"] = token;
    else if (token === "infinite" || /^\d+$/.test(token)) out.count = token;
    else if (token === "alternate") out.direction = token;
    else if (["both", "forwards", "backwards"].includes(token)) out.fill = token;
    else out.name = token;
  }
  return ANIMATION_LONGHANDS.map((key) => [`animation-${key}`, out[key]!]);
}

/** Cascaded declarations for one element: property → value. Custom properties inherit. */
function cascade(element: Element, rules: Rule[], inherited: Map<string, string>): Map<string, string> {
  const winners = new Map<string, { weight: number; order: number; value: string }>();
  for (const rule of rules) {
    let weight = -1;
    for (const selector of rule.selectors)
      if (matches(element, selector)) weight = Math.max(weight, specificity(selector));
    if (weight < 0) continue;
    for (const [property, raw] of rule.declarations)
      for (const [name, value] of property === "animation" ? expandAnimation(raw) : [[property, raw] as [string, string]]) {
        const current = winners.get(name);
        if (!current || weight > current.weight || (weight === current.weight && rule.order > current.order))
          winners.set(name, { weight, order: rule.order, value: rule.motion || !name.startsWith("animation") ? value : value });
      }
  }
  const out = new Map<string, string>();
  // Custom properties inherit. Visibility is left as each element's own value: the layer
  // tree hides a hidden element's children for us, and lets them show again with it.
  for (const [name, value] of inherited) if (name.startsWith("--")) out.set(name, value);
  for (const [name, { value }] of winners) out.set(name, value);
  // Inline styles from the artwork win over the stylesheet.
  const style = element.attributes.style;
  if (style && typeof style === "object")
    for (const [name, value] of Object.entries(style))
      out.set(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value);
  return out;
}

// ---- values --------------------------------------------------------------------------------
function substitute(value: string, style: Map<string, string>): string {
  let out = value;
  for (let guard = 0; guard < 8 && out.includes("var("); guard++)
    out = out.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_all, name: string, fallback?: string) => style.get(name) ?? fallback ?? "0");
  return out;
}
/** A length or time as a number: px and plain numbers stay, seconds stay, ms become seconds. */
function number(value: string, style: Map<string, string>): number {
  let text = substitute(value, style).trim();
  text = text.replace(/(-?[\d.]+)ms/g, (_all, n: string) => String(Number(n) / 1000)).replace(/(-?[\d.]+)(px|s|deg)/g, "$1");
  for (let guard = 0; guard < 8 && text.includes("calc("); guard++) text = text.replace(/calc\(([^()]*)\)/g, "($1)");
  if (!/^[-+*/().\d\s]+$/.test(text)) throw new Error(`Cannot evaluate ${value}`);
  return Number(new Function(`return (${text})`)());
}
function parseTransform(value: string | undefined, style: Map<string, string>): Op[] {
  if (!value || value === "none") return [];
  const ops: Op[] = [];
  for (const match of substitute(value, style).matchAll(/([a-zA-Z]+)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const args = splitTop(match[2]!, ",").map((arg) => number(arg, style));
    const [a = 0, b] = args;
    switch (match[1]) {
      case "translate": ops.push(["t", a, b ?? 0]); break;
      case "translateX": ops.push(["t", a, 0]); break;
      case "translateY": ops.push(["t", 0, a]); break;
      case "scale": ops.push(["s", a, b ?? a]); break;
      case "scaleX": ops.push(["s", a, 1]); break;
      case "scaleY": ops.push(["s", 1, a]); break;
      case "rotate": ops.push(["r", a]); break;
      default: throw new Error(`Unsupported transform function ${match[1]}`);
    }
  }
  return ops;
}

// ---- the element tree ------------------------------------------------------------------------
function build(node: RobotAvatarLayerNode, parent: Element, id: string): Element {
  const element: Element = { tag: node.tag, classes: [], attributes: node.attributes as Attributes, children: [], parent, id };
  element.children = (node.children ?? []).map((child, index) => build(child as RobotAvatarLayerNode, element, `${id}/${index}`));
  return element;
}
export function robotTree(shape: RobotAvatarShape, mode: string, from: "robot" | "glyph") {
  const svg: Element = { tag: "svg", classes: ["robot-avatar"], attributes: { "data-avatar-mode": mode, "data-avatar-from": from }, children: [], parent: null, id: "svg" };
  const frame: Element = { tag: "g", classes: [], attributes: {}, children: [], parent: svg, id: "frame" };
  const rig: Element = { tag: "g", classes: ["robot-avatar-rig"], attributes: {}, children: [], parent: frame, id: "rig" };
  const body: Element = { tag: "g", classes: ["robot-avatar-body"], attributes: {}, children: [], parent: rig, id: "body" };
  const glyph: Element = { tag: "g", classes: ["robot-avatar-glyph"], attributes: {}, children: [], parent: rig, id: "glyph" };
  svg.children = [frame];
  frame.children = [rig];
  rig.children = [body, glyph];
  body.children = robotAvatarLayers(shape).map((node, index) => build(node, body, String(index)));
  glyph.children = ROBOT_AVATAR_GLYPHS.map((node, index) => build(node, glyph, `g${index}`));
  return { svg, rig, body, glyph };
}
const walk = (element: Element, visit: (element: Element) => void) => {
  visit(element);
  for (const child of element.children) walk(child, visit);
};

// ---- resolving states --------------------------------------------------------------------------
const BRIDGED: Selector[] = ".robot-avatar-body, [data-p], [data-g], [data-sat], [data-track]".split(",").map((s) => parseSelector(s.trim()));
const isBridged = (element: Element) => BRIDGED.some((selector) => matches(element, selector));

export interface Spec {
  keyframes: Record<string, Keyframes>;
  states: State[];
  /** element id → one state index per mode, in BOT_AVATAR_MODES order. */
  modes: Record<string, number[]>;
  transitions: Record<string, { transform?: Bridge; opacity?: Bridge }>;
  origins: Record<string, { box: "fill" | "view"; x: number; y: number }>;
  bridged: string[];
}

export function resolveShape(shape: RobotAvatarShape, sheet: ReturnType<typeof parseStylesheet>, reduced: boolean, shared: { keyframes: Record<string, Keyframes>; states: State[]; index: Map<string, number> }) {
  // Reduce Motion drops everything inside the motion media query, loops and all.
  const css = reduced ? { ...sheet, rules: sheet.rules.filter((rule) => !rule.motion) } : sheet;
  const tempo = robotAvatarTempo(shape);
  const modes: Spec["modes"] = {};
  const transitions: Spec["transitions"] = {};
  const origins: Spec["origins"] = {};
  const bridged = new Set<string>();

  const resolveKeyframes = (name: string, style: Map<string, string>): string => {
    const source = css.keyframes.get(name);
    if (!source) throw new Error(`Missing keyframes ${name}`);
    const usesVars = source.some(([, declarations]) => declarations.some(([, value]) => value.includes("var(")));
    const key = usesVars ? `${name}|${["--gaze-x", "--gaze-y", "--gx", "--gy"].map((v) => style.get(v) ?? "").join("|")}` : name;
    if (shared.keyframes[key]) return key;
    const frames: Keyframes = { transform: [], opacity: [], dash: [] };
    for (const [offsetText, declarations] of source) {
      const offset = offsetText === "from" ? 0 : offsetText === "to" ? 1 : Number.parseFloat(offsetText) / 100;
      const easing = declarations.find(([property]) => property === "animation-timing-function")?.[1] ?? null;
      for (const [property, value] of declarations) {
        if (property === "transform") frames.transform.push({ offset, value: parseTransform(value, style), easing });
        else if (property === "opacity") frames.opacity.push({ offset, value: number(value, style), easing });
        else if (property === "stroke-dashoffset") frames.dash.push({ offset, value: number(value, style), easing });
      }
    }
    for (const track of [frames.transform, frames.opacity, frames.dash] as Track<unknown>[][]) {
      if (!track.length) continue;
      track.sort((a, b) => a.offset - b.offset);
      // A missing first or last keyframe animates from or to the element's own resting value.
      if (track[0]!.offset > 0) track.unshift({ offset: 0, value: null, easing: null });
      if (track.at(-1)!.offset < 1) track.push({ offset: 1, value: null, easing: null });
    }
    shared.keyframes[key] = frames;
    return key;
  };

  const bridgeOf = (style: Map<string, string>): Bridge => ({
    duration: style.has("--robot-bridge") ? number(style.get("--robot-bridge")!, style) : 0.32,
    delay: style.has("--robot-bridge-delay") ? number(style.get("--robot-bridge-delay")!, style) : 0,
    easing: style.get("--robot-bridge-ease") ?? "ease-in-out",
  });

  BOT_AVATAR_MODES.forEach((mode, modeIndex) => {
    const trees = { robot: robotTree(shape, mode, "robot"), glyph: robotTree(shape, mode, "glyph") };
    const styles = { robot: new Map<Element, Map<string, string>>(), glyph: new Map<Element, Map<string, string>>() };
    for (const from of ["robot", "glyph"] as const) {
      const root = new Map<string, string>([["--robot-tempo", `${tempo}s`], ["--robot-delay", "0s"]]);
      const visit = (element: Element, inherited: Map<string, string>) => {
        const style = cascade(element, css.rules, inherited);
        styles[from].set(element, style);
        for (const child of element.children) visit(child, style);
      };
      visit(trees[from].svg, root);
    }
    const glyphById = new Map<string, Element>();
    walk(trees.glyph.svg, (element) => glyphById.set(element.id, element));
    walk(trees.robot.svg, (element) => {
      if (element.id === "svg" || element.id === "frame" || element.id === "glyph") return;
      const style = styles.robot.get(element)!;
      const fromGlyph = styles.glyph.get(glyphById.get(element.id)!)!;
      const name = style.get("animation-name");
      let loop: Loop | null = null;
      if (name && name !== "none") {
        const delayText = style.get("animation-delay") ?? "0s";
        const count = style.get("animation-count") ?? "1";
        loop = {
          keyframes: resolveKeyframes(name, style),
          duration: number(style.get("animation-duration") ?? "0s", style),
          delay: number(delayText, style),
          phased: delayText.includes("--robot-delay"),
          easing: style.get("animation-easing") ?? "ease",
          iterations: count === "infinite" ? 0 : Number(count),
          fill: style.get("animation-fill") ?? "none",
          alternate: style.get("animation-direction") === "alternate",
        };
      }
      const state: State = {
        transform: element.attributes.style && typeof element.attributes.style === "object" && "transform" in element.attributes.style
          ? [] // The face plate's perspective tilt is applied by the projection, not as a pose.
          : parseTransform(style.get("transform"), style),
        opacity: style.has("opacity") ? number(style.get("opacity")!, style) : Number(element.attributes.opacity ?? 1),
        visible: style.get("visibility") !== "hidden",
        bridge: bridgeOf(style),
        bridgeFromGlyph: bridgeOf(fromGlyph),
        loop,
      };
      const key = JSON.stringify(state);
      let index = shared.index.get(key);
      if (index === undefined) {
        index = shared.states.push(state) - 1;
        shared.index.set(key, index);
      }
      (modes[element.id] ??= [])[modeIndex] = index;
      if (isBridged(element)) bridged.add(element.id);
      const transition = style.get("transition");
      if (transition) {
        const entry: { transform?: Bridge; opacity?: Bridge } = {};
        for (const part of splitTop(transition, ",")) {
          const [property, duration, ...easing] = splitTop(part, " ");
          if (property === "transform" || property === "opacity")
            entry[property] = { duration: number(duration!, style), delay: 0, easing: easing.join(" ") || "ease" };
        }
        transitions[element.id] = entry;
      }
      const percent = (token: string) => (token === "center" ? 50 : token === "left" || token === "top" ? 0 : Number.parseFloat(token));
      const [x = "0", y = x === "center" ? "center" : "0"] = (style.get("transform-origin") ?? "0 0").split(/\s+/);
      origins[element.id] = { box: style.get("transform-box") === "fill-box" ? "fill" : "view", x: percent(x), y: percent(y) };
    });
  });
  return { modes, transitions, origins, bridged: [...bridged] };
}
