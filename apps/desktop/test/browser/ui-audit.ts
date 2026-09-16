// Read-only motion instrumentation for manual computer-use QA of the real app.
// It records native DOM animation/transition events; it never drives the UI.
for (const type of [
  "animationstart",
  "animationend",
  "animationcancel",
  "transitionrun",
  "transitionend",
  "transitioncancel",
]) {
  document.addEventListener(
    type,
    (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const style = getComputedStyle(event.target);
      const animation = event as AnimationEvent;
      const transition = event as TransitionEvent;
      console.debug(
        "UI_AUDIT_MOTION",
        JSON.stringify({
          type,
          at: performance.now(),
          name: animation.animationName ?? transition.propertyName,
          elapsed: animation.elapsedTime,
          role: event.target.getAttribute("role"),
          className: event.target.className,
          state: event.target.dataset.state,
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
          transitionDuration: style.transitionDuration,
          transitionEasing: style.transitionTimingFunction,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        })
      );
    },
    true
  );
}
await import("../../src/renderer/index");
