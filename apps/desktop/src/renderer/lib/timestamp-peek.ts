export const TIMESTAMP_PEEK_WIDTH = 82;
export const TIMESTAMP_PEEK_RELEASE_MS = 90;
export const TIMESTAMP_PEEK_RETURN_MS = 435;
export const TIMESTAMP_PEEK_EASING = "linear(0, 0.03866 4%, 0.133 8%, 0.2566 12%, 0.3901 15%, 0.5206 19%, 0.6396 23%, 0.7426 27%, 0.8278 31%, 0.8954 35%, 0.9467 38%, 0.9837 42%, 1.009 46%, 1.024 50%, 1.033 54%, 1.036 58%, 1.035 62%, 1.032 65%, 1.028 69%, 1.023 73%, 1.019 77%, 1.014 81%, 1.01 85%, 1.007 88%, 1.004 92%, 1.002 96%, 1.001)";

export const clampTimestampPeek = (offset: number) => Math.max(0, Math.min(TIMESTAMP_PEEK_WIDTH, offset));
export const isTimestampPeekGesture = (deltaX: number, deltaY: number) =>
  Math.abs(deltaX) >= 1.5 && Math.abs(deltaX) > Math.abs(deltaY);

// A gesture that starts inside a code block/table belongs to that scroller for
// its entire duration, including when it reaches the end of its scroll range.
function hasHorizontalScroller(target: EventTarget | null, viewport: HTMLElement) {
  for (let element = target instanceof Element ? target : null; element && element !== viewport; element = element.parentElement) {
    if (element.scrollWidth - element.clientWidth <= 1) continue;
    const overflow = getComputedStyle(element).overflowX;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

export function attachTimestampPeek(viewport: HTMLElement) {
  let offset = 0;
  let gesture: "idle" | "peek" | "scroller" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let returning: Animation | null = null;
  const setOffset = (value: number) => {
    offset = value;
    viewport.style.setProperty("--timestamp-peek", `${value}px`);
    viewport.style.setProperty("--timestamp-peek-progress", `${value / TIMESTAMP_PEEK_WIDTH}`);
  };
  const finish = () => {
    returning = null;
    viewport.removeAttribute("data-timestamp-peeking");
  };
  const interrupt = () => {
    if (!returning) return;
    const current = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--timestamp-peek"));
    returning.cancel();
    returning = null;
    setOffset(clampTimestampPeek(Number.isFinite(current) ? current : offset));
  };
  const release = () => {
    gesture = "idle";
    if (!offset) { if (!returning) finish(); return; }
    const previous = offset;
    setOffset(0);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    returning = viewport.animate([
      { "--timestamp-peek": `${previous}px`, "--timestamp-peek-progress": `${previous / TIMESTAMP_PEEK_WIDTH}` },
      { "--timestamp-peek": "0px", "--timestamp-peek-progress": "0" },
    ], { duration: TIMESTAMP_PEEK_RETURN_MS, easing: TIMESTAMP_PEEK_EASING });
    returning.onfinish = finish;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.defaultPrevented) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (gesture === "idle") {
      if (!isTimestampPeekGesture(event.deltaX, event.deltaY)) return;
      gesture = hasHorizontalScroller(event.target, viewport) ? "scroller" : "peek";
      if (gesture === "peek") viewport.setAttribute("data-timestamp-peeking", "");
    } else if (!horizontal) return;
    clearTimeout(timer);
    timer = setTimeout(release, TIMESTAMP_PEEK_RELEASE_MS);
    if (gesture === "scroller") return;
    event.preventDefault();
    interrupt();
    const sign = getComputedStyle(viewport).direction === "rtl" ? -1 : 1;
    setOffset(clampTimestampPeek(offset + event.deltaX * sign));
  };
  viewport.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    clearTimeout(timer);
    returning?.cancel();
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeAttribute("data-timestamp-peeking");
    viewport.style.removeProperty("--timestamp-peek");
    viewport.style.removeProperty("--timestamp-peek-progress");
  };
}
