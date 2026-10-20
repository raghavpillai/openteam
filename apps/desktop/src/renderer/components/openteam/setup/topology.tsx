import {
  Cpu,
  Database,
  FolderOpen,
  Globe,
  Laptop,
  ListChecks,
  type LucideIcon,
  Server,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_BASE } from "../../../client/http";
import { shortHost } from "../../../lib/server-address";
import "./topology.css";

// The server check's picture: a live map of what was just connected. This computer reaches
// the server, which runs the database, the task queue and the bot computer; the bot computer
// gives bots a browser, files and a terminal, and will talk to the AI model (the next step).
// Edges draw in as each check passes, packets travel along them, and healthy links keep a
// gentle flow. Laid out on a 520 × 380 canvas that scales down to fit the stage.

/** "blocked": behind a server that can't be reached, so not known. */
export type CheckState = "pending" | "ready" | "failed" | "blocked";
type NodeState = CheckState | "next";

const WIDTH = 520;
const HEIGHT = 380;

type NodeSpec = {
  id: string;
  label: string;
  icon: LucideIcon;
  x: number;
  y: number;
  kind: "node" | "chip" | "ghost";
};

const NODES: NodeSpec[] = [
  { id: "here", label: "This Mac", icon: Laptop, x: 260, y: 34, kind: "node" },
  { id: "server", label: "Server", icon: Server, x: 260, y: 130, kind: "node" },
  { id: "database", label: "Database", icon: Database, x: 90, y: 238, kind: "node" },
  { id: "computer", label: "Bot computer", icon: Cpu, x: 260, y: 238, kind: "node" },
  { id: "queue", label: "Task queue", icon: ListChecks, x: 430, y: 238, kind: "node" },
  { id: "browser", label: "Browser", icon: Globe, x: 172, y: 338, kind: "chip" },
  { id: "files", label: "Files", icon: FolderOpen, x: 258, y: 338, kind: "chip" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, x: 344, y: 338, kind: "chip" },
  { id: "model", label: "AI model", icon: Sparkles, x: 458, y: 338, kind: "ghost" },
];
const HALF_HEIGHT: Record<string, number> = { node: 20, chip: 15, ghost: 15 };
const SERVER_HALF_HEIGHT = 27;

// Edges in the order they draw; a chip's edge follows the bot computer.
const EDGES = [
  ["here", "server"],
  ["server", "database"],
  ["server", "queue"],
  ["server", "computer"],
  ["computer", "browser"],
  ["computer", "files"],
  ["computer", "terminal"],
  ["computer", "model"],
] as const;

const node = (id: string) => NODES.find((candidate) => candidate.id === id) as NodeSpec;
const half = (spec: NodeSpec) =>
  spec.id === "server" ? SERVER_HALF_HEIGHT : (HALF_HEIGHT[spec.kind] ?? 20);

/** A vertical S-curve from the bottom of one node to the top of another. */
function edgeCurve(from: NodeSpec, to: NodeSpec) {
  const x0 = from.x;
  const y0 = from.y + half(from);
  const x1 = to.x;
  const y1 = to.y - half(to);
  const bend = (y1 - y0) * 0.55;
  const points: [number, number][] = [
    [x0, y0],
    [x0, y0 + bend],
    [x1, y1 - bend],
    [x1, y1],
  ];
  const d = `M${x0} ${y0}C${x0} ${y0 + bend} ${x1} ${y1 - bend} ${x1} ${y1}`;
  return { d, points };
}

const sample = ([p0, p1, p2, p3]: [number, number][], t: number): [number, number] => {
  const u = 1 - t;
  const at = (i: 0 | 1) =>
    u * u * u * (p0?.[i] ?? 0) +
    3 * u * u * t * (p1?.[i] ?? 0) +
    3 * u * t * t * (p2?.[i] ?? 0) +
    t * t * t * (p3?.[i] ?? 0);
  return [at(0), at(1)];
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A packet running along an edge: once as the link comes up, then every few seconds while
 * it stays healthy. Transform and opacity only, so it runs on the compositor.
 */
function Packet({
  points,
  live,
  order,
}: {
  points: [number, number][];
  live: boolean;
  order: number;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!live || !element || reducedMotion() || typeof element.animate !== "function") return;
    const period = 2_600 + (order % 3) * 280;
    const travel = 640 / period;
    const steps = 14;
    const frames: Keyframe[] = [];
    for (let index = 0; index <= steps; index++) {
      const [x, y] = sample(points, index / steps);
      frames.push({
        offset: (index / steps) * travel,
        opacity: index === 0 || index === steps ? 0 : 1,
        transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
      });
    }
    const [endX, endY] = sample(points, 1);
    frames.push({ offset: 1, opacity: 0, transform: `translate(${endX}px, ${endY}px)` });
    const animation = element.animate(frames, {
      duration: period,
      iterations: Number.POSITIVE_INFINITY,
      easing: "linear",
    });
    return () => animation.cancel();
  }, [live, order, points]);
  return <i aria-hidden="true" className="setup-topo-packet" ref={ref} />;
}

const CURVES = EDGES.map(([from, to]) => ({ from, to, ...edgeCurve(node(from), node(to)) }));

/**
 * The server check as a live topology. `states` follow the left-hand list: the server, the
 * database, the task queue and the bot computer. `unreachable`: the server didn't answer
 * at all, rather than answering that a part is down.
 */
export function TopologyVisual({
  states,
  unreachable = false,
}: {
  states: CheckState[];
  unreachable?: boolean;
}) {
  const [server, database, queue, computer] = states;
  const tool: NodeState =
    computer === "ready"
      ? "ready"
      : computer === "failed" || computer === "blocked"
        ? "blocked"
        : "pending";
  const nodeState: Record<string, NodeState> = {
    here: "ready",
    server: server ?? "pending",
    database: database ?? "pending",
    queue: queue ?? "pending",
    computer: computer ?? "pending",
    browser: tool,
    files: tool,
    terminal: tool,
    model: "next",
  };
  // An edge is up once both ends are; it shows a problem when its target failed.
  const edgeState = (from: string, to: string): NodeState => {
    const target = nodeState[to];
    if (target === "next") return "next";
    if (target === "failed") return "failed";
    return nodeState[from] === "ready" && target === "ready" ? "ready" : "pending";
  };
  const here = /Mac/i.test(typeof navigator === "undefined" ? "" : navigator.platform)
    ? "This Mac"
    : "This computer";

  // The canvas keeps its proportions and shrinks to the stage.
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = outer.current;
    if (!element) return;
    const measure = () => setScale(Math.min(1, element.clientWidth / WIDTH) || 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="setup-topo" ref={outer} style={{ height: HEIGHT * scale }}>
      <div
        className="setup-topo-canvas"
        style={{ width: WIDTH, height: HEIGHT, transform: `scale(${scale})` }}
      >
        <svg
          aria-hidden="true"
          className="setup-topo-edges"
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width={WIDTH}
        >
          {CURVES.map((curve, index) => (
            <g
              className="setup-topo-edge"
              data-state={edgeState(curve.from, curve.to)}
              key={`${curve.from}-${curve.to}`}
              style={{ "--i": index } as CSSProperties}
            >
              <path className="setup-topo-track" d={curve.d} />
              <path className="setup-topo-flow" d={curve.d} pathLength={1} />
            </g>
          ))}
        </svg>
        {CURVES.map((curve, index) =>
          curve.to === "model" ? null : (
            <Packet
              key={`${curve.from}-${curve.to}`}
              live={edgeState(curve.from, curve.to) === "ready"}
              order={index}
              points={curve.points}
            />
          )
        )}
        {NODES.map((spec, index) => {
          const state = nodeState[spec.id] ?? "pending";
          return (
            <div
              className="setup-topo-node"
              data-kind={spec.kind}
              data-node={spec.id}
              data-state={state}
              key={spec.id}
              style={{ left: spec.x, top: spec.y, "--i": index } as CSSProperties}
            >
              <spec.icon aria-hidden="true" className="setup-topo-icon" />
              <span className="setup-topo-text">
                <b>{spec.id === "here" ? here : spec.label}</b>
                {spec.id === "server" ? <small>{shortHost(hostOf(API_BASE))}</small> : null}
              </span>
              {spec.kind === "ghost" ? <span className="setup-topo-next">next</span> : null}
              {spec.kind === "node" ? <span className="setup-topo-dot" /> : null}
              {spec.kind === "node" && spec.id !== "here" ? (
                <span className="setup-topo-flag">
                  {spec.id === "server" && unreachable ? "No answer" : "Not running"}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
