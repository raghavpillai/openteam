import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";

const TRANSITION_MS = 320;

function pose(element: Element) {
  const style = getComputedStyle(element);
  return { transform: style.transform, opacity: style.opacity };
}

/** Bridge CSS loops from the live pose, including an interrupted transition. */
export function createRobotAvatarMotion(svg: SVGSVGElement) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let bridges: Animation[] = [];
  let paused: Animation[] = [];

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
  reducedMotion.addEventListener("change", clear);

  return {
    setMode(mode: BotAvatarMode, animate = true) {
      if (svg.dataset.avatarMode === mode && animate) return;
      const elements = [...svg.querySelectorAll(".robot-avatar-body, [data-p]")];
      const shouldAnimate = animate && !reducedMotion.matches;
      // Read before cancelling: a second state change starts where the first left off.
      const before = shouldAnimate ? elements.map(pose) : [];
      clear();
      svg.dataset.avatarMode = mode;
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
        const bridge = element.animate([from, to], {
          duration: TRANSITION_MS,
          easing: "ease-in-out",
          fill: "both",
        });
        bridge.onfinish = () => {
          for (const animation of loops[index]!) animation.play();
          bridge.cancel();
          bridges = bridges.filter((active) => active !== bridge);
        };
        return [bridge];
      });
    },
    dispose() {
      reducedMotion.removeEventListener("change", clear);
      clear();
      svg.dataset.avatarMode = "still";
    },
  };
}
