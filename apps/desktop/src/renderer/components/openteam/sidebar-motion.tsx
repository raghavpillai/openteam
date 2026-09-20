import { Component, createRef, type ReactNode } from "react";
import { pinnedSpringFrames, sidebarSpring, sidebarSpringFrames } from "../../lib/sidebar-spring";

type Point = { x: number; y: number };
type RowSnapshot = Point & {
  node: HTMLElement;
  width: number;
  height: number;
  ghost?: HTMLElement;
};
type Snapshot = {
  rows: Map<string, RowSnapshot>;
  height: number;
  width: number;
  scrollTop: number;
};
type Props = { children: ReactNode; pinnedIds: ReadonlySet<string>; disabled?: boolean };
type Movement = { animation: Animation; x: number; y: number; vx: number; vy: number };

type CollapseProps = { compact: boolean; children: ReactNode };
type CollapseSnapshot = { top: number; velocity: number; scrollTop: number };

/** The compact and expanded rosters have different React trees. Keep their
 * search-space movement outside those trees so the layout spring survives the
 * handoff (and a reversal), instead of remounting at its final position. */
export class SidebarCollapseMotion extends Component<
  CollapseProps,
  Record<string, never>,
  CollapseSnapshot | null
> {
  private root = createRef<HTMLDivElement>();
  private movement?: { animation: Animation; y: number; velocity: number };

  private roster() {
    return this.root.current?.querySelector<HTMLElement>("[data-sidebar-motion-roster]");
  }

  getSnapshotBeforeUpdate(previous: CollapseProps): CollapseSnapshot | null {
    if (previous.compact === this.props.compact) return null;
    const roster = this.roster();
    if (!roster) return null;
    const motion = this.movement;
    const scrollTop = roster.parentElement?.scrollTop ?? 0;
    return {
      top: roster.getBoundingClientRect().top + scrollTop,
      scrollTop,
      velocity: motion
        ? sidebarSpring(motion.y, motion.velocity, Number(motion.animation.currentTime ?? 0)).velocity
        : 0,
    };
  }

  componentDidUpdate(
    _previous: CollapseProps,
    _state: Record<string, never>,
    snapshot: CollapseSnapshot | null
  ) {
    if (!snapshot) return;
    this.movement?.animation.cancel();
    this.movement = undefined;
    const roster = this.roster();
    if (!roster) return;
    const viewport = roster.parentElement;
    if (viewport) viewport.scrollTop = snapshot.scrollTop;
    // A scrolled list still moves only through the space occupied by Search.
    // Its scroll offset must not become part of the layout displacement.
    const y = snapshot.top - (roster.getBoundingClientRect().top + (viewport?.scrollTop ?? 0));
    if (Math.abs(y) < 0.5 && Math.abs(snapshot.velocity) < 0.1) return;
    const spring = sidebarSpringFrames(0, y, 0, snapshot.velocity);
    const animation = roster.animate(spring.frames, {
      duration: spring.duration,
      easing: "linear",
    });
    this.movement = { animation, y, velocity: snapshot.velocity };
    animation.onfinish = () => {
      if (this.movement?.animation === animation) this.movement = undefined;
    };
  }

  componentWillUnmount() {
    this.movement?.animation.cancel();
  }

  render() {
    return <div className="contents" ref={this.root}>{this.props.children}</div>;
  }
}

/** Capture before React moves keyed rows. Only mounted rows are measured, including
 * virtual rows. Scroll recycling never creates an entrance or a removal animation. */
export class SidebarMotion extends Component<Props, Record<string, never>, Snapshot | null> {
  private root = createRef<HTMLDivElement>();
  private movements = new Map<HTMLElement, Movement>();
  private effects = new Set<Animation>();
  private ghosts = new Set<HTMLElement>();
  private shellAnimation?: Animation;
  private shellFade?: Animation;
  private shellTarget = 0;

  private rows() {
    return Array.from(
      this.root.current?.querySelectorAll<HTMLElement>(
        "[data-channel-id], [data-pinned-channel-id], [data-compact-channel-id]"
      ) ?? []
    ).filter((node) => !node.closest("[data-motion-ghost]"));
  }
  private box(node: HTMLElement) {
    const rect = node.getBoundingClientRect();
    if (!node.dataset.pinnedChannelId) return rect;
    // FLIP and exit copies use the unscaled box; otherwise an interrupted tile
    // entrance would have its .85 scale applied twice.
    return {
      x: rect.x - (node.offsetWidth - rect.width) / 2,
      y: rect.y - (node.offsetHeight - rect.height) / 2,
      width: node.offsetWidth,
      height: node.offsetHeight,
    };
  }
  private clonePin(node: HTMLElement) {
    const ghost = node.cloneNode(true) as HTMLElement;
    const style = getComputedStyle(node);
    ghost.style.opacity = style.opacity;
    ghost.style.scale = style.scale;
    return ghost;
  }
  private key(node: HTMLElement) {
    return node.dataset.pinnedChannelId
      ? `pin:${node.dataset.pinnedChannelId}`
      : `row:${node.dataset.channelId ?? node.dataset.compactChannelId}`;
  }
  private track(animation: Animation, cleanup?: () => void) {
    this.effects.add(animation);
    animation.onfinish = () => {
      this.effects.delete(animation);
      cleanup?.();
    };
    return animation;
  }
  componentDidMount() {
    this.shellTarget =
      this.root.current?.querySelector<HTMLElement>("[data-pinned-shell]")?.offsetHeight ?? 0;
  }
  getSnapshotBeforeUpdate(): Snapshot | null {
    const viewport = this.root.current?.parentElement;
    if (!viewport || this.props.disabled) return null;
    const origin = viewport.getBoundingClientRect();
    const rows = new Map<string, RowSnapshot>();
    for (const node of this.rows()) {
      const rect = this.box(node);
      const pin = node.dataset.pinnedChannelId;
      rows.set(this.key(node), {
        node,
        x: rect.x - origin.x + viewport.scrollLeft,
        y: rect.y - origin.y + viewport.scrollTop,
        width: rect.width,
        height: rect.height,
        ghost: pin && !this.props.pinnedIds.has(pin) ? this.clonePin(node) : undefined,
      });
    }
    return {
      rows,
      height: Math.max(
        this.root.current
          ?.querySelector<HTMLElement>("[data-pinned-shell]")
          ?.getBoundingClientRect().height ?? 0,
        this.root.current
          ?.querySelector<HTMLElement>("[data-channel-transition-drop-zone]")
          ?.getBoundingClientRect().height ?? 0
      ),
      width: origin.width,
      scrollTop: viewport.scrollTop,
    };
  }
  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    const root = this.root.current,
      viewport = root?.parentElement;
    if (
      !root ||
      !viewport ||
      !snapshot ||
      this.props.disabled ||
      Math.abs(viewport.getBoundingClientRect().width - snapshot.width) > 1 ||
      viewport.scrollTop !== snapshot.scrollTop
    ) {
      this.cancel();
      return;
    }
    const shell = root.querySelector<HTMLElement>("[data-pinned-shell]");
    const naturalHeight =
      shell?.querySelector<HTMLElement>(":scope > [data-channel-group]")?.getBoundingClientRect()
        .height ?? 0;
    const shellOpacity = shell ? Number(getComputedStyle(shell).opacity) : 1;
    if (shell && Math.abs(naturalHeight - this.shellTarget) > 0.5) {
      if (this.shellAnimation) {
        this.shellAnimation.cancel();
        this.effects.delete(this.shellAnimation);
      }
      if (this.shellFade) {
        this.shellFade.cancel();
        this.effects.delete(this.shellFade);
      }
      if (naturalHeight === 0) {
        this.shellFade = this.track(
          shell.animate([{ opacity: shellOpacity }, { opacity: 0 }], {
            duration: 100,
            easing: "cubic-bezier(0.2, 0, 0.2, 1)",
            fill: "forwards",
          })
        );
      }
      this.shellTarget = naturalHeight;
      this.shellAnimation = this.track(
        shell.animate([{ height: `${snapshot.height}px` }, { height: `${naturalHeight}px` }], {
          duration: 300,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        })
      );
    }
    const origin = viewport.getBoundingClientRect();
    for (const node of this.rows()) {
      const key = this.key(node),
        before = snapshot.rows.get(key);
      const motion = this.movements.get(node);
      const ms = Number(motion?.animation.currentTime ?? 0);
      const sx = motion ? sidebarSpring(motion.x, motion.vx, ms) : { value: 0, velocity: 0 };
      const sy = motion ? sidebarSpring(motion.y, motion.vy, ms) : { value: 0, velocity: 0 };
      const rect = this.box(node);
      const x = rect.x - origin.x + viewport.scrollLeft - sx.value;
      const y = rect.y - origin.y + viewport.scrollTop - sy.value;
      if (before) {
        const dx = before.x - x,
          dy = before.y - y;
        // An unrelated data update must not restart an in-flight spring.
        if (Math.abs(dx - sx.value) < 0.5 && Math.abs(dy - sy.value) < 0.5) continue;
        if (motion) {
          motion.animation.cancel();
          this.effects.delete(motion.animation);
        }
        this.movements.delete(node);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          const spring = sidebarSpringFrames(dx, dy, sx.velocity, sy.velocity);
          const animation = this.track(
            node.animate(spring.frames, { duration: spring.duration, easing: "linear" }),
            () => this.movements.delete(node)
          );
          this.movements.set(node, { animation, x: dx, y: dy, vx: sx.velocity, vy: sy.velocity });
        }
      } else if (
        node.dataset.pinnedChannelId &&
        !previous.pinnedIds.has(node.dataset.pinnedChannelId)
      ) {
        const exiting = [...this.ghosts].find(
          (ghost) => ghost.dataset.motionExitId === node.dataset.pinnedChannelId
        );
        const visibility = exiting ? Number(getComputedStyle(exiting).opacity) * shellOpacity : 0;
        if (exiting) {
          for (const animation of exiting.getAnimations()) {
            animation.cancel();
            this.effects.delete(animation);
          }
          exiting.remove();
          this.ghosts.delete(exiting);
        }
        const spring = pinnedSpringFrames(false, visibility);
        this.track(
          node.animate(spring.frames, {
            duration: spring.duration,
            delay: !exiting && previous.pinnedIds.size === 0 ? 300 : 0,
            fill: "backwards",
            easing: "linear",
          })
        );
      }
    }
    for (const { ghost, x, y, width, height } of snapshot.rows.values()) {
      if (!ghost) continue;
      ghost.dataset.motionGhost = "";
      ghost.dataset.motionExitId = ghost.dataset.pinnedChannelId;
      ghost.removeAttribute("data-pinned-channel-id");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
        margin: "0",
        zIndex: "10",
        translate: "none",
      });
      // Keep exit visuals inside the reference's vertically clipped pinned shell.
      if (shell) {
        const shellRect = shell.getBoundingClientRect();
        ghost.style.left = `${x - (shellRect.x - origin.x + viewport.scrollLeft)}px`;
        ghost.style.top = `${y - (shellRect.y - origin.y + viewport.scrollTop)}px`;
      }
      (shell ?? root).appendChild(ghost);
      this.ghosts.add(ghost);
      const spring = pinnedSpringFrames(true, Number(getComputedStyle(ghost).opacity));
      this.track(
        ghost.animate(spring.frames, {
          duration: spring.duration,
          easing: "linear",
          fill: "forwards",
        }),
        () => {
          ghost.remove();
          this.ghosts.delete(ghost);
        }
      );
    }
    for (const [node, motion] of this.movements) {
      if (!node.isConnected) {
        motion.animation.cancel();
        this.effects.delete(motion.animation);
        this.movements.delete(node);
      }
    }
  }
  private cancel() {
    this.shellFade?.cancel();
    for (const animation of this.effects) animation.cancel();
    for (const ghost of this.ghosts) ghost.remove();
    this.effects.clear();
    this.ghosts.clear();
    this.movements.clear();
    this.shellAnimation = undefined;
    this.shellFade = undefined;
    this.shellTarget =
      this.root.current?.querySelector<HTMLElement>("[data-pinned-shell]")?.offsetHeight ?? 0;
  }
  componentWillUnmount() {
    this.cancel();
  }
  render() {
    return (
      <div className="relative flex w-full shrink-0 grow flex-col" data-sidebar-motion-roster="" ref={this.root}>
        {this.props.children}
      </div>
    );
  }
}
