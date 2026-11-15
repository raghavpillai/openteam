import { ROBOT_AVATAR_VIEW_BOX, robotAvatarTempo } from '../../../packages/design-tokens/src/robot-avatar-artwork';
import { ROBOT_AVATAR_SHAPES, ROBOT_AVATAR_LABELS, BOT_AVATAR_MODES, BOT_AVATAR_GLYPH_MODES } from '../../../packages/contracts/src/robot-avatar';
import { BOT_AVATAR_COLORS } from '../../../packages/contracts/src/bot-avatar';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStylesheet, resolveShape, robotTree, type Element, type Keyframes, type State } from './robot-motion-spec';
import { ROBOT_AVATAR_ANTENNA_WOBBLE, ROBOT_AVATAR_CELEBRATE, ROBOT_AVATAR_FOLD, ROBOT_AVATAR_LAND, ROBOT_AVATAR_SHAKE, type RobotAvatarReaction } from '../../../packages/design-tokens/src/robot-avatar-motion';
import { ROBOT_AVATAR_DIZZY, ROBOT_AVATAR_FIDGETS, ROBOT_AVATAR_POKES } from '../../../packages/design-tokens/src/robot-avatar-pokes';

const root = resolve(import.meta.dir, '../../..');
type Bounds = [number, number, number, number];
// Chromium resolves a view-box transform origin against the view box's size from (0, 0),
// not from the view box's own corner.
const VIEW: Bounds = [0, 0, 108, 108];
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Path data as absolute M, L, Q, C and Z commands; arcs become cubic curves. */
function absolutePath(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0, x = 0, y = 0, startX = 0, startY = 0, command = '', lastQ: [number, number] | null = null;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase(), ox = relative ? x : 0, oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case 'M': x = ox + next(); y = oy + next(); startX = x; startY = y; out.push('M', x, y); command = relative ? 'l' : 'L'; lastQ = null; break;
      case 'L': x = ox + next(); y = oy + next(); out.push('L', x, y); lastQ = null; break;
      case 'H': x = ox + next(); out.push('L', x, y); lastQ = null; break;
      case 'V': y = oy + next(); out.push('L', x, y); lastQ = null; break;
      case 'Q': { const cx = ox + next(), cy = oy + next(); x = ox + next(); y = oy + next(); out.push('Q', cx, cy, x, y); lastQ = [cx, cy]; break; }
      case 'T': { const cx = lastQ ? 2 * x - lastQ[0] : x, cy = lastQ ? 2 * y - lastQ[1] : y; x = ox + next(); y = oy + next(); out.push('Q', cx, cy, x, y); lastQ = [cx, cy]; break; }
      case 'C': { const a = ox + next(), b = oy + next(), c = ox + next(), e = oy + next(); x = ox + next(); y = oy + next(); out.push('C', a, b, c, e, x, y); lastQ = null; break; }
      case 'A': {
        const rx = next(), ry = next(); next(); const large = next(), sweep = next(), ex = ox + next(), ey = oy + next();
        // Endpoint to centre parameterisation (no axis rotation is used by the artwork).
        const dx = (x - ex) / 2, dy = (y - ey) / 2;
        const scale = Math.max(1, Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry)));
        const a = rx * scale, b = ry * scale;
        const sign = large === sweep ? -1 : 1;
        const k = sign * Math.sqrt(Math.max(0, (a * a * b * b - a * a * dy * dy - b * b * dx * dx) / (a * a * dy * dy + b * b * dx * dx)));
        const cx = (x + ex) / 2 + k * (a * dy) / b, cy = (y + ey) / 2 - k * (b * dx) / a;
        const t0 = Math.atan2((y - cy) / b, (x - cx) / a);
        let sweepAngle = Math.atan2((ey - cy) / b, (ex - cx) / a) - t0;
        if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;
        if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
        const pieces = Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2));
        for (let n = 0; n < pieces; n++) {
          const a0 = t0 + (sweepAngle * n) / pieces, a1 = t0 + (sweepAngle * (n + 1)) / pieces, h = (4 / 3) * Math.tan((a1 - a0) / 4);
          out.push('C', cx + a * (Math.cos(a0) - h * Math.sin(a0)), cy + b * (Math.sin(a0) + h * Math.cos(a0)), cx + a * (Math.cos(a1) + h * Math.sin(a1)), cy + b * (Math.sin(a1) - h * Math.cos(a1)), cx + a * Math.cos(a1), cy + b * Math.sin(a1));
        }
        x = ex; y = ey; lastQ = null; break;
      }
      case 'Z': x = startX; y = startY; out.push('Z'); lastQ = null; break;
      default: throw new Error(`Unsupported path command ${command}`);
    }
  }
  return out.map((value) => (typeof value === 'number' ? round(value) : value));
}
function pathBounds(path: (string | number)[]): Bounds {
  const xs: number[] = [], ys: number[] = [];
  let x = 0, y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i++] as string, n = (k: number) => path[i + k] as number;
    const sample = (points: [number, number][]) => {
      for (let s = 1; s <= 16; s++) {
        const t = s / 16; let work = [[x, y] as [number, number], ...points];
        while (work.length > 1) work = work.slice(1).map((p, j) => [work[j]![0] + (p[0] - work[j]![0]) * t, work[j]![1] + (p[1] - work[j]![1]) * t]);
        xs.push(work[0]![0]); ys.push(work[0]![1]);
      }
    };
    if (command === 'M' || command === 'L') { x = n(0); y = n(1); xs.push(x); ys.push(y); i += 2; }
    else if (command === 'Q') { sample([[n(0), n(1)], [n(2), n(3)]]); x = n(2); y = n(3); i += 4; }
    else if (command === 'C') { sample([[n(0), n(1)], [n(2), n(3)], [n(4), n(5)]]); x = n(4); y = n(5); i += 6; }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const isFace = (element: Element) => typeof element.attributes.style === 'object' && String((element.attributes.style as Record<string, string>).transform ?? '').includes('perspective');
function attributeTransform(box: Bounds, transform: string): Bounds {
  let m = [1, 0, 0, 1, 0, 0];
  for (const match of transform.matchAll(/(translate|scale)\(([^)]+)\)/g)) {
    const [a = 0, b] = match[2]!.split(/[\s,]+/).map(Number);
    const next = match[1] === 'translate' ? [1, 0, 0, 1, a, b ?? 0] : [a, 0, 0, b ?? a, 0, 0];
    m = [m[0]! * next[0]! + m[2]! * next[1]!, m[1]! * next[0]! + m[3]! * next[1]!, m[0]! * next[2]! + m[2]! * next[3]!, m[1]! * next[2]! + m[3]! * next[3]!, m[0]! * next[4]! + m[2]! * next[5]! + m[4]!, m[1]! * next[4]! + m[3]! * next[5]! + m[5]!];
  }
  const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  const xs = corners.map(([u, v]) => m[0]! * u! + m[2]! * v! + m[4]!), ys = corners.map(([u, v]) => m[1]! * u! + m[3]! * v! + m[5]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function bounds(element: Element): Bounds {
  const a = element.attributes, n = (k: string) => Number(a[k] ?? 0);
  let box: Bounds;
  switch (element.tag) {
    case 'rect': box = [n('x'), n('y'), n('x') + n('width'), n('y') + n('height')]; break;
    case 'circle': box = [n('cx') - n('r'), n('cy') - n('r'), n('cx') + n('r'), n('cy') + n('r')]; break;
    case 'ellipse': box = [n('cx') - n('rx'), n('cy') - n('ry'), n('cx') + n('rx'), n('cy') + n('ry')]; break;
    case 'line': box = [Math.min(n('x1'), n('x2')), Math.min(n('y1'), n('y2')), Math.max(n('x1'), n('x2')), Math.max(n('y1'), n('y2'))]; break;
    case 'polygon': { const p = String(a.points).split(/[\s,]+/).map(Number), xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1); box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; break; }
    case 'path': box = pathBounds(absolutePath(String(a.d))); break;
    default: {
      const boxes = element.children.map((child) => {
        const inner = bounds(child);
        if (!isFace(child)) return inner;
        // The face plate's flattened perspective tilt, as the desktop projects it.
        const x = (inner[0] + inner[2]) / 2, y = (inner[1] + inner[3]) / 2, c = Math.cos((14 * Math.PI) / 180), p = Math.sin((14 * Math.PI) / 180) / 300;
        const ma = c + x * p, mb = y * p, tx = 2 * c + x * (1 + 2 * p) - ma * x, ty = y * 2 * p - mb * x;
        const corners = [[inner[0], inner[1]], [inner[2], inner[1]], [inner[2], inner[3]], [inner[0], inner[3]]];
        const xs = corners.map(([u]) => ma * u! + tx), ys = corners.map(([u, v]) => mb * u! + v! + ty);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Bounds;
      });
      box = boxes.length ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))] : [50, 50, 50, 50];
    }
  }
  return a.transform ? attributeTransform(box, String(a.transform)) : box;
}

const ROLES = ['data-x', 'data-g', 'data-sat', 'data-core', 'data-ring', 'data-track', 'data-arc', 'data-spark', 'data-ink', 'data-pen', 'data-look', 'data-m'] as const;
type Paint = Record<string, string | number>;
function convert(element: Element, index: number, spec: ReturnType<typeof resolveShape>, reduced: ReturnType<typeof resolveShape>, paint: Paint): unknown {
  const a = element.attributes, box = bounds(element);
  const p = { ...paint };
  for (const key of Object.keys(p)) if (a[key] !== undefined) p[key] = a[key] as string | number;
  const geometry = Object.fromEntries(Object.entries(a).filter(([k]) => ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2'].includes(k)).map(([k, v]) => [k, Number(v)]));
  const origin = spec.origins[element.id]!, frame = origin.box === 'fill' ? box : VIEW;
  const roles = Object.fromEntries(ROLES.filter((key) => a[key] !== undefined).map((key) => [key.slice(5), String(a[key])]));
  return {
    id: element.id, tag: element.tag, geometry,
    points: String(a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
    path: element.tag === 'path' ? absolutePath(String(a.d)).join(' ') : '',
    ...p, strokeWidth: Number(p.strokeWidth), opacity: Number(a.opacity ?? 1),
    part: String(a['data-p'] ?? ''), roles, limit: Number(a['data-lim'] ?? 0),
    replacedBySmile: a['data-smile'] !== undefined, replacedByFrown: a['data-frown'] !== undefined,
    dashed: a.pathLength !== undefined, perspective: isFace(element), transform: String(a.transform ?? ''),
    origin: [round(frame[0] + (frame[2] - frame[0]) * origin.x / 100), round(frame[1] + (frame[3] - frame[1]) * origin.y / 100)],
    index, bridged: spec.bridged.includes(element.id), transition: spec.transitions[element.id] ?? {},
    modes: spec.modes[element.id], reducedModes: reduced.modes[element.id],
    children: element.children.map((child, i) => convert(child, i, spec, reduced, p)),
  };
}

/** A reaction keyframe as numbers: a translate/rotate/scale pose, or a spin in perspective. */
function reactionFrame(frame: Keyframe) {
  const out: Record<string, unknown> = { offset: Number(frame.offset), easing: frame.easing ?? null };
  const spin = String(frame.transform ?? '').match(/^perspective\(([-\d.]+)px\) translate\(0px, ([-\d.]+)px\) rotateY\(([-\d.]+)deg\) scale\(([-\d.]+), ([-\d.]+)\)$/);
  if (frame.transform && !spin) throw new Error(`Unsupported reaction transform ${frame.transform}`);
  if (spin) out.spin = { depth: Number(spin[1]), lift: Number(spin[2]), turn: Number(spin[3]), scaleX: Number(spin[4]), scaleY: Number(spin[5]) };
  else {
    const [tx = '0', ty = '0'] = String(frame.translate ?? '0 0').trim().split(/\s+/);
    const [sx = '1', sy = sx] = String(frame.scale ?? '1').trim().split(/\s+/);
    out.pose = { x: Number.parseFloat(tx), y: Number.parseFloat(ty), rotation: Number.parseFloat(String(frame.rotate ?? '0')), scaleX: Number(sx), scaleY: Number(sy) };
  }
  return out;
}
const reaction = (r: RobotAvatarReaction) => ({
  duration: r.duration / 1000, delay: (r.delay ?? 0) / 1000, easing: r.easing ?? 'linear',
  keyframes: (r.keyframes ?? []).map(reactionFrame),
  antenna: r.antenna ? { delay: r.antenna.delay / 1000, duration: r.antenna.duration / 1000, easing: 'ease-out', keyframes: r.antenna.keyframes.map(reactionFrame) } : null,
  parts: (r.parts ?? []).map((part) => ({ target: part.selector === '[data-look]' ? 'look' : 'mouth', delay: (part.delay ?? 0) / 1000, duration: part.duration / 1000, easing: part.easing ?? 'linear', keyframes: part.keyframes.map(reactionFrame) })),
  expressions: (r.expressions ?? []).map((e) => ({ name: e.name, delay: (e.delay ?? 0) / 1000, duration: e.duration / 1000 })),
});
const reactions = {
  celebrate: reaction(ROBOT_AVATAR_CELEBRATE), fold: reaction(ROBOT_AVATAR_FOLD), land: reaction(ROBOT_AVATAR_LAND), shake: reaction(ROBOT_AVATAR_SHAKE),
  dizzy: reaction(ROBOT_AVATAR_DIZZY), wobble: reaction({ duration: 0, antenna: { delay: 0, ...ROBOT_AVATAR_ANTENNA_WOBBLE } }),
  ...Object.fromEntries(ROBOT_AVATAR_POKES.map((poke, index) => [`poke${index}`, reaction(poke)])),
  ...Object.fromEntries(Object.entries(ROBOT_AVATAR_FIDGETS).map(([name, fidget]) => [`fidget.${name}`, reaction(fidget)])),
};
const sourceFiles = ['packages/design-tokens/src/robot-avatar-artwork.ts', 'packages/design-tokens/src/robot-avatar-expressions.ts', 'packages/design-tokens/src/robot-avatar.css', 'packages/design-tokens/src/robot-avatar-motion.ts', 'packages/design-tokens/src/robot-avatar-pokes.ts', 'packages/contracts/src/robot-avatar.ts', 'packages/contracts/src/bot-avatar.ts'];
const css = parseStylesheet(readFileSync(resolve(root, 'packages/design-tokens/src/robot-avatar.css'), 'utf8'));
const shared = { keyframes: {} as Record<string, Keyframes>, states: [] as State[], index: new Map<string, number>() };
const basePaint: Paint = { fill: 'currentColor', stroke: 'none', strokeWidth: 1, strokeLinecap: 'butt', strokeLinejoin: 'miter' };
const shapes = Object.fromEntries(ROBOT_AVATAR_SHAPES.map((shape) => {
  const spec = resolveShape(shape, css, false, shared), reduced = resolveShape(shape, css, true, shared);
  const tree = robotTree(shape, 'still', 'robot');
  const group = (element: Element) => ({ modes: spec.modes[element.id], reducedModes: reduced.modes[element.id], origin: [round(108 * spec.origins[element.id]!.x / 100), round(108 * spec.origins[element.id]!.y / 100)] });
  return [shape, {
    label: ROBOT_AVATAR_LABELS[shape], tempo: robotAvatarTempo(shape), rig: group(tree.rig), body: group(tree.body),
    nodes: tree.body.children.map((child, i) => convert(child, i, spec, reduced, basePaint)),
    // Glyph elements take the Bot's colour unless they say otherwise.
    glyphs: tree.glyph.children.map((child, i) => convert(child, i, spec, reduced, basePaint)),
  }];
}));
const data = {
  viewBox: ROBOT_AVATAR_VIEW_BOX, colors: BOT_AVATAR_COLORS, modes: BOT_AVATAR_MODES, glyphModes: BOT_AVATAR_GLYPH_MODES,
  sources: Object.fromEntries(sourceFiles.map((p) => [p, createHash('sha256').update(readFileSync(resolve(root, p))).digest('hex')])),
  keyframes: shared.keyframes, states: shared.states, reactions, pokes: ROBOT_AVATAR_POKES.length, shapes,
};
const path = resolve(import.meta.dir, '../Sources/Core/Resources/RobotArtwork.json');
const contents = JSON.stringify(data) + '\n';
if (process.argv.includes('--check')) { if (readFileSync(path, 'utf8') !== contents) throw new Error('RobotArtwork.json is stale; run bun apps/ios/scripts/export-robot-artwork.ts'); }
else writeFileSync(path, contents);
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Exported'} ${ROBOT_AVATAR_SHAPES.length} desktop robot designs.`);
