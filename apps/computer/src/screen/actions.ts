import type { ComputerUseActionInput } from "@openteam/contracts";
import { run } from "./processes";

export async function performComputerUseAction(
  input: ComputerUseActionInput,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
  const modifiers = input.modifiers?.split("+") ?? [];
  const held = modifiers.flatMap((modifier) => ["keydown", modifier]);
  const released = [...modifiers].reverse().flatMap((modifier) => ["keyup", modifier]);
  const position =
    input.x === undefined || input.y === undefined
      ? []
      : ["mousemove", "--sync", String(input.x), String(input.y)];
  switch (input.action) {
    case "screenshot":
      return;
    case "move":
      if (position.length > 0) await run("xdotool", position, { env });
      return;
    case "click":
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
        { env }
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
        .flatMap((point) => ["mousemove", "--sync", String(point.x), String(point.y)]);
      await run(
        "xdotool",
        [
          "mousemove",
          "--sync",
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
        { env }
      );
      return;
    }
    case "type":
      await run("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", input.text!], {
        env,
      });
      return;
    case "key":
      await run("xdotool", ["key", "--clearmodifiers", input.key!], { env });
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
        { env }
      );
      return;
    }
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, input.durationMs!));
      return;
  }
}
