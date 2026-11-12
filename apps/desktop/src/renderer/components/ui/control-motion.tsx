import { Slot } from "radix-ui";
import { Component, type ReactElement } from "react";

type ControlMotionProps = { children: ReactElement; enabled?: boolean };
type Snapshot = {
  width: number;
  text: string | null;
  children: number;
  className: string;
  style: string | null;
  busy: string | null;
};

/**
 * Read the old width before React changes the label, then animate to its new
 * natural width. The snapshot lifecycle avoids observers and extra DOM wrappers,
 * so custom buttons and Radix controls keep their layout, refs and semantics.
 */
export class ControlMotion extends Component<ControlMotionProps> {
  private element: HTMLElement | null = null;
  private animation: Animation | undefined;
  private removeMotionListener: (() => void) | undefined;

  private setElement = (element: HTMLElement | null) => {
    this.element = element;
  };

  private stop = () => {
    this.removeMotionListener?.();
    this.removeMotionListener = undefined;
    if (this.animation) {
      this.animation.onfinish = null;
      this.animation.oncancel = null;
      this.animation.cancel();
      this.animation = undefined;
    }
  };

  getSnapshotBeforeUpdate(previous: ControlMotionProps): Snapshot | null {
    const element = this.element;
    if (
      previous.children === this.props.children ||
      this.props.enabled === false ||
      !element?.getClientRects().length ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return null;
    return {
      width: Number.parseFloat(getComputedStyle(element).width),
      text: element.textContent,
      children: element.childElementCount,
      className: element.className,
      style: element.getAttribute("style"),
      busy: element.getAttribute("aria-busy"),
    };
  }

  componentDidUpdate(_previous: ControlMotionProps, _state: unknown, snapshot: Snapshot | null) {
    const element = this.element;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Streaming and polling can rerender a whole panel. Let an unchanged
    // control finish its current transition instead of restarting it each time.
    if (
      this.animation &&
      snapshot &&
      element &&
      !motion.matches &&
      snapshot.text === element.textContent &&
      snapshot.children === element.childElementCount &&
      snapshot.className === element.className &&
      snapshot.style === element.getAttribute("style") &&
      snapshot.busy === element.getAttribute("aria-busy")
    )
      return;
    // Cancel first so measuring the destination never reads an in-flight width.
    this.stop();
    if (!snapshot || !element || motion.matches) return;
    const { width } = snapshot;
    const next = Number.parseFloat(getComputedStyle(element).width);
    if (!Number.isFinite(width) || !Number.isFinite(next) || Math.abs(next - width) < 0.5) return;
    this.animation = element.animate(
      [
        { width: `${width}px`, overflow: "clip" },
        { width: `${next}px`, overflow: "clip" },
      ],
      { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    this.animation.onfinish = this.stop;
    this.animation.oncancel = this.stop;
    const onMotionChange = () => {
      if (motion.matches) this.stop();
    };
    motion.addEventListener("change", onMotionChange);
    this.removeMotionListener = () => motion.removeEventListener("change", onMotionChange);
  }

  componentWillUnmount() {
    this.stop();
  }

  render() {
    return this.props.enabled === false ? (
      this.props.children
    ) : (
      <Slot.Root ref={this.setElement}>{this.props.children}</Slot.Root>
    );
  }
}
