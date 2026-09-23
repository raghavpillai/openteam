import { setTimeout as delay } from "node:timers/promises";
import type { ComputerUseActionInput } from "@openteam/contracts";
import { run } from "./processes";
import { typeText } from "./typing";

// Accept common browser/agent spellings while preserving case-sensitive X keysyms.
const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  space: "space",
  spacebar: "space",
  home: "Home",
  end: "End",
  insert: "Insert",
  pageup: "Prior",
  pagedown: "Next",
  arrowleft: "Left",
  left: "Left",
  arrowright: "Right",
  right: "Right",
  arrowup: "Up",
  up: "Up",
  arrowdown: "Down",
  down: "Down",
  control: "ctrl",
  controlormeta: "ctrl",
  command: "super",
  cmd: "super",
  meta: "super",
  "-": "minus",
  "=": "equal",
  "+": "plus",
  "[": "bracketleft",
  "]": "bracketright",
  ";": "semicolon",
  "'": "apostrophe",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "`": "grave",
};
export const normalizeKey = (key: string) =>
  (key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+"))
    .map((part) => KEY_ALIASES[part.toLowerCase()] ?? (/^f(?:[1-9]|[12]\d|3[0-5])$/i.test(part) ? part.toUpperCase() : part))
    .join("+");

/** A rejected batch may already have applied its prefix; never invite replay. */
export async function performComputerUseBatch(
  actions: readonly ComputerUseActionInput[],
  perform: (action: ComputerUseActionInput) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  for (const [index, action] of actions.entries()) {
    signal?.throwIfAborted();
    try {
      await perform(action);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(
        `Computer batch stopped at action ${index + 1} of ${actions.length} (${action.action}). ` +
        `${index} earlier action(s) completed; later actions were not executed. ` +
        `The failed action may have partly applied. Inspect the current screen before continuing; do not replay the completed actions. ` +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }
}

export async function performComputerUseAction(
  input: ComputerUseActionInput,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await performAction(input, env, signal);
  } finally {
    if (signal?.aborted && input.action !== "wait" && input.action !== "screenshot") {
      // A terminated xdotool may not have reached its keyup/mouseup commands.
      await run(
        "xdotool",
        [
          "keyup",
          "--delay",
          "0",
          // Numeric keycodes also release an interrupted character key, even
          // after its temporary Unicode mapping has already been restored.
          ...Array.from({ length: 248 }, (_, index) => String(index + 8).padStart(3, "0")),
          "mouseup",
          "1",
          "mouseup",
          "2",
          "mouseup",
          "3",
        ],
        { env }
      );
    }
  }
}

async function performAction(
  input: ComputerUseActionInput,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
  const modifiers = input.modifiers?.split("+") ?? [];
  const held = modifiers.flatMap((modifier) => ["keydown", modifier]);
  const released = [...modifiers].reverse().flatMap((modifier) => ["keyup", modifier]);
  const position =
    input.x === undefined || input.y === undefined
      ? []
      : // --sync waits for a motion event even when the pointer is already here.
        // X11 orders these requests before the click/key requests that follow.
        ["mousemove", String(input.x), String(input.y)];
  switch (input.action) {
    case "screenshot":
      return;
    case "move":
      if (position.length > 0) await run("xdotool", position, { env, signal });
      return;
    case "click":
      if (input.holdDurationMs !== undefined) {
        await run("xdotool", [...position, "mousedown", button], { env, signal });
        try { await delay(input.holdDurationMs, undefined, { signal }); }
        finally { await run("xdotool", ["mouseup", button], { env }); }
        return;
      }
      await run(
        "xdotool",
        [
          ...position,
          ...held,
          "click",
          "--repeat",
          String(input.count ?? 1),
          "--delay",
          "140",
          button,
          ...released,
        ],
        { env, signal }
      );
      return;
    case "drag": {
      const points = input.path?.length
        ? [...input.path]
        : [
            { x: input.x!, y: input.y! },
            { x: input.x2!, y: input.y2! },
          ];
      const first = points[0]!;
      const path = points
        .slice(1)
        .flatMap((point) => ["mousemove", String(point.x), String(point.y)]);
      await run(
        "xdotool",
        [
          "mousemove",
          String(first.x),
          String(first.y),
          ...held,
          "mousedown",
          button,
          ...path,
          "mouseup",
          button,
          ...released,
        ],
        { env, signal }
      );
      return;
    }
    case "type":
      await typeText(input.text!, env, signal);
      return;
    case "key":
      await run(
        "xdotool",
        ["key", "--clearmodifiers", normalizeKey([...modifiers, input.key!].join("+"))],
        {
          env,
          failOnStderr: true,
          signal,
        }
      );
      return;
    case "scroll": {
      const scrollButton = { up: "4", down: "5", left: "6", right: "7" }[input.direction!];
      await run(
        "xdotool",
        [
          ...position,
          ...held,
          "click",
          "--repeat",
          String(input.amount ?? 3),
          "--delay",
          "30",
          scrollButton,
          ...released,
        ],
        { env, signal }
      );
      return;
    }
    case "wait":
      await delay(input.durationMs!, undefined, { signal });
      return;
  }
}
