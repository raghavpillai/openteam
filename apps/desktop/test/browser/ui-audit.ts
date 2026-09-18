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
// Observe real wheel input and its resulting frames without synthesizing input.
let peekObservation = 0;
document.addEventListener("wheel", (event) => {
  console.debug("UI_AUDIT_MOTION", JSON.stringify({ type: "wheel-input", at: performance.now(), deltaX: event.deltaX, deltaY: event.deltaY, target: event.target instanceof Element ? event.target.className : null }));
}, { capture: true, passive: true });
document.addEventListener("wheel", (event) => {
  const viewport = event.target instanceof Element ? event.target.closest<HTMLElement>(".conversation-scroll") : null;
  if (!viewport || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  const observation = ++peekObservation;
  const started = performance.now();
  const frame = () => {
    if (observation !== peekObservation || !viewport.isConnected) return;
    const style = getComputedStyle(viewport);
    const time = viewport.querySelector<HTMLElement>(".message-timestamp");
    const user = viewport.querySelector<HTMLElement>('[data-from="user"] > .timestamp-peek-content');
    console.debug("UI_AUDIT_MOTION", JSON.stringify({
      type: "timestamp-peek-frame",
      at: performance.now(),
      sinceWheel: performance.now() - started,
      deltaX: event.deltaX,
      prevented: event.defaultPrevented,
      offset: style.getPropertyValue("--timestamp-peek"),
      progress: style.getPropertyValue("--timestamp-peek-progress"),
      peeking: viewport.hasAttribute("data-timestamp-peeking"),
      timeOpacity: time ? getComputedStyle(time).opacity : null,
      userTransform: user ? getComputedStyle(user).transform : null,
      animations: viewport.getAnimations().map((animation) => animation.effect?.getTiming()),
    }));
    if (performance.now() - started < 650) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}, { passive: true });
await import("../../src/renderer/index");
