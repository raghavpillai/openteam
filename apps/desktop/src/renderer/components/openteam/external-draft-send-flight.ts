/** The send-off, once this device's send is confirmed: the Send blob swallows
    the letter, the card closes around it, and the blob slings at full speed
    into the "Sending" badge, where it bursts green and is the "Sent" badge.
    The summary is written in its wake.
    A discard is the quiet opposite: the grey Discard blob swallows the letter,
    the card closes, and the blob drips out through the bottom edge.
    Loaded on the first Send or Discard so it stays out of startup. */
const GULP = 150;
const CLOSE = { delay: 130, duration: 220 };
const WIND = 290;
const SLING = 370;
const HIT = 530;
// The solid green stamp holds this long after the hit, then relaxes into the badge.
const STAMP = 300;
const RELAX = 200;
const END = HIT + STAMP + RELAX + 10;
// A discard: the blob hops off its spot at HOP, is gone at DROPPED, and the
// receipt fades in behind it.
const HOP = 310;
const DROPPED = 560;
const RECEIPT = { delay: 470, duration: 190 };
const STEPS = 12;
// The goo between the launch point and the head lets go this long after the head does.
const CLING = 70;
// Pure ease-in: fastest as it hits.
const LAUNCH = [0.5, 0, 0.9, 0.4] as const;

/** y for x on a CSS cubic-bezier. */
function bezier([x1, y1, x2, y2]: readonly [number, number, number, number]) {
  const axis = (a: number, b: number, s: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  const solve = (target: number, a: number, b: number) => {
    let low = 0;
    let high = 1;
    for (let pass = 0; pass < 20; pass++) {
      const middle = (low + high) / 2;
      if (axis(a, b, middle) < target) low = middle;
      else high = middle;
    }
    return high;
  };
  return {
    at: (time: number) => axis(y1, y2, solve(time, x1, x2)),
  };
}

const goo = `<svg aria-hidden="true" width="0" height="0"><filter id="draft-fx-goo" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 22 -9"/></filter></svg>`;

export function playDraftSendFlight(card: HTMLElement, done: () => void, discard = false): () => void {
  const button = card.querySelector<HTMLElement>("[data-fx-actor]");
  const status = card.querySelector<HTMLElement>(".draft-header .draft-status");
  // What is being sent or dropped: the letter, or the message bubble.
  const panel = card.querySelector<HTMLElement>(".draft-panel, .imessage-bubble, .imessage-attachments");
  const summary = card.querySelector<HTMLElement>(".draft-fx-summary");
  if (!button || !status || !panel || !summary) {
    done();
    return () => {};
  }
  // The card's row may still be scaled by its entrance, so everything is measured
  // in the card's own pixels: on-screen boxes divided by how much it is scaled.
  const screen = card.getBoundingClientRect();
  const frame = { width: card.offsetWidth, height: card.offsetHeight };
  const zoom = screen.width / frame.width || 1;
  const local = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: (box.left - screen.left) / zoom, y: (box.top - screen.top) / zoom, width: box.width / zoom, height: box.height / zoom };
  };
  const center = (element: Element) => {
    const box = local(element);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const styles = getComputedStyle(card);
  const ink = styles.getPropertyValue(discard ? "--draft-muted" : "--draft-primary").trim();
  const green = styles.getPropertyValue("--draft-green").trim();
  const badge = local(status);
  const header = local(status.parentElement!);
  const line = header.y + header.height + Number.parseFloat(styles.rowGap || "10");
  summary.style.top = `${line}px`;
  const settled = line + summary.offsetHeight + Number.parseFloat(styles.paddingBottom);

  // Everything is laid out in the closed card's box, pinned to the card's
  // bottom edge, so the blob rides that edge up while the card closes.
  const pressed = center(button);
  const from = { x: pressed.x, y: pressed.y - (frame.height - settled) };
  // As the card closes the blob settles onto the summary line, clear of the title.
  const rest = { x: from.x, y: Math.min(line + summary.offsetHeight / 2, settled - 20) };
  // A send flies into the badge; a discard falls straight out of the card.
  const to = discard ? { x: rest.x, y: settled + 60 } : { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 };
  const [go, gone] = discard ? [HOP, DROPPED] : [SLING, HIT];
  const heading = Math.atan2(to.y - rest.y, to.x - rest.x);
  const back = { x: rest.x - Math.cos(heading) * 7, y: rest.y - Math.sin(heading) * 7 };
  const launch = bezier(LAUNCH);
  // A discard is tossed: a small hop, then gravity takes it out of the card.
  // It rises `rise` px, so y = rest − up·t + fall·t², ending at `to`.
  const rise = 9;
  const drop = to.y - rest.y;
  const up = 2 * rise + 2 * Math.sqrt(rise * rise + rise * drop);
  const fall = drop + up;
  /** Where the blob is, and how stretched along and across its heading, at 0…1 of its flight. */
  const course = (time: number): { point: { x: number; y: number }; along: number; across: number } => {
    const t = Math.max(0, Math.min(1, time));
    if (discard) {
      // Stretched by its speed, round at the top of the hop and as it lets go.
      const speed = (Math.abs(2 * fall * t - up) / (2 * fall - up)) * Math.min(1, t / 0.12);
      return { point: { x: rest.x, y: rest.y - up * t + fall * t * t }, along: 1 + 0.6 * speed, across: 1 - 0.3 * speed };
    }
    const p = launch.at(t);
    const pull = Math.min(1, p / 0.4);
    const point = { x: back.x + (to.x - back.x) * p, y: back.y + (to.y - back.y) * p };
    return t ? { point, along: 1 + 1.4 * pull, across: 1 - 0.45 * pull } : { point, along: 0.8, across: 1.15 };
  };

  const layer = document.createElement("div");
  layer.className = "draft-fx";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML = `${goo}<div class="draft-fx-stage" style="height:${settled}px"><div class="draft-fx-goo"></div></div>`;
  const stage = layer.lastElementChild as HTMLElement;
  const gooLayer = stage.firstElementChild as HTMLElement;
  card.append(layer);
  const add = (parent: HTMLElement, className: string, fill?: string) => {
    const element = document.createElement("span");
    element.className = className;
    if (fill) element.style.backgroundColor = fill;
    parent.append(element);
    return element;
  };
  const animations: Animation[] = [];
  const play = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) =>
    animations.push(element.animate(frames, options));
  const at = (point: { x: number; y: number }, angle: number, x: number, y = x) =>
    `translate(${point.x}px, ${point.y}px) rotate(${angle}rad) scale(${x}, ${y})`;

  // The letter goes into the blob, and the card closes on what is left.
  const sheet = local(panel);
  panel.style.transformOrigin = `${pressed.x - sheet.x}px ${pressed.y - sheet.y}px`;
  const swallow: KeyframeAnimationOptions = { duration: GULP, easing: "cubic-bezier(0.6, 0, 0.9, 0.4)", fill: "forwards" };
  play(panel, [{ opacity: 1, transform: "scale(1)" }, { opacity: 1, offset: 0.62 }, { opacity: 0, transform: "scale(0.08)" }], swallow);
  for (const other of card.querySelectorAll(":scope > :is(.draft-note, .imessage-title, .imessage-to, .imessage-attachments)"))
    if (other !== panel) play(other, [{ opacity: 1 }, { opacity: 0 }], swallow);
  // A card with no header while it waits gets its settled one as it closes.
  const title = card.querySelector(".draft-fx-header > :first-child");
  if (title) play(title, [{ opacity: 0 }, { opacity: 1 }], { delay: CLOSE.delay, duration: 160, fill: "both" });
  play(card, [{ height: `${frame.height}px` }, { height: `${settled}px` }], {
    ...CLOSE,
    // No sudden start: the chat follows a frame behind (see below), and a big
    // first step would open a gap above the card for that frame.
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    fill: "both",
  });
  // The chat's list places each row from the top, in a box of a set height, and
  // gives a row its new height a frame or more after the row changes. While the
  // card closes, the list still believes it is taller. When the chat is being
  // held at its bottom, catching up will slide everything down by that
  // difference, as far as there is scroll left to give. Until it does, the card
  // is moved down by exactly that much, so its bottom edge (which the blob
  // rides) is already where it is going to be. A chat too short to scroll has
  // nothing to give: there the card simply closes upward.
  const row = card.closest<HTMLElement>("[data-virtual-timeline-index]");
  const list = row?.parentElement;
  let scroller = list?.parentElement ?? null;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  let release = () => {};
  if (row && list && scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
    const view = scroller;
    const next = list.querySelector<HTMLElement>(`:scope > [data-virtual-timeline-index="${Number(row.dataset.virtualTimelineIndex) + 1}"]`);
    // How far past this row's end the list believes it reaches: up to the next
    // row, or to the end of the list's box.
    const believed = () => (next?.isConnected ? next.getBoundingClientRect().top : list.getBoundingClientRect().bottom) - row.getBoundingClientRect().bottom;
    const rest = believed();
    const until = performance.now() + CLOSE.delay + CLOSE.duration + 400;
    const hold = () => {
      const behind = Math.min(believed() - rest, view.scrollTop);
      card.style.translate = behind > 0.5 ? `0 ${Math.min(behind / zoom, frame.height - settled)}px` : "";
    };
    // The chat may catch up at any point in a frame, so the hold is taken as late
    // as possible: after layout whenever the card's own size changed, and
    // otherwise in a frame callback queued behind everyone else's (from a task).
    const sized = new ResizeObserver(hold);
    sized.observe(card);
    const later = new MessageChannel();
    let queued = 0;
    const each = () => {
      hold();
      if (performance.now() < until) later.port2.postMessage(0);
      else release();
    };
    later.port1.onmessage = () => (queued = requestAnimationFrame(each));
    queued = requestAnimationFrame(each);
    release = () => {
      sized.disconnect();
      later.port1.onmessage = null;
      cancelAnimationFrame(queued);
      card.style.translate = "";
    };
  }

  // Gulp, settle (a send winds up against its heading), then go. `shape` false
  // keeps the glyph unstretched; `nose` is the glyph's own angle on top of the heading.
  const path = (scale: number, shape: boolean, nose = 0): Keyframe[] => {
    const angle = heading + nose;
    const lead: Keyframe[] = [
      { offset: 0, opacity: 1, transform: at(from, angle, scale), easing: "cubic-bezier(0.3, 0, 0.4, 1)" },
      { offset: (GULP + 10) / gone, opacity: 1, transform: at(from, angle, scale * 1.25), easing: "ease-in-out" },
      { offset: WIND / gone, opacity: 1, transform: at(rest, angle, scale * 1.08), easing: "ease-out" },
    ];
    const flight: Keyframe[] = Array.from({ length: STEPS + 1 }, (_, step) => {
      const { point, along, across } = course(step / STEPS);
      const [x, y] = shape ? [along, across] : [1, 1];
      return { offset: (go + (step / STEPS) * (gone - go)) / gone, opacity: 1, transform: at(point, angle, scale * x, scale * y) };
    });
    return [...lead, ...flight];
  };
  const head = path(1, true);
  play(add(stage, "draft-fx-blob", ink), head, { duration: gone });
  play(add(gooLayer, "draft-fx-blob", ink), head, { duration: gone });
  // The tail is one strand of goo from wherever the head was CLING ms ago up to
  // the head: it stretches thin off the launch point, then whips after it.
  const strand = Array.from({ length: STEPS + 5 }, (_, step) => {
    const front = course(step / STEPS).point;
    const rear = course(step / STEPS - CLING / (gone - go)).point;
    const length = Math.hypot(front.x - rear.x, front.y - rear.y) + 20;
    const point = { x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2 };
    return { opacity: 1, transform: at(point, heading, length / 32, Math.max(0.2, 0.78 - length / 300)) };
  });
  play(add(gooLayer, "draft-fx-blob", ink), strand, { delay: go, duration: ((STEPS + 4) / STEPS) * (gone - go) });
  const plane = add(stage, "draft-fx-plane");
  const glyph = button.querySelector("svg");
  if (glyph) plane.append(glyph.cloneNode(true));
  if (discard) plane.style.color = styles.getPropertyValue("--draft-text");
  // The plane points along the heading; a discard's cross stays upright.
  play(plane, path(1, false, discard ? -heading : Math.PI / 4), { duration: gone });

  const ghost = title ? null : add(layer, "draft-status draft-fx-ghost");
  if (ghost) {
    // The badge the card showed while it waited, until the new one takes its place.
    ghost.dataset.tone = "ready";
    ghost.innerHTML = `<span class="draft-status-dot"></span>${discard ? "Ready to send" : "Sending"}`;
    ghost.style.top = `${badge.y}px`;
    ghost.style.right = `${frame.width - badge.x - badge.width}px`;
  }
  const nudge = (along: number) => `translate(${Math.cos(heading) * along}px, ${Math.sin(heading) * along}px)`;
  if (discard) {
    // The card dips as the blob drops off it, and the receipt fades in behind.
    play(card, [{ transform: nudge(0) }, { transform: nudge(2), offset: 0.2, easing: "ease-in-out" }, { transform: nudge(0) }], {
      delay: go + 110,
      duration: 240,
      easing: "ease-out",
    });
    if (ghost) play(ghost, [{ opacity: 1 }, { opacity: 0 }], { ...CLOSE, fill: "forwards" });
    const receipt: KeyframeAnimationOptions = { ...RECEIPT, easing: "ease-in-out", fill: "both" };
    play(summary, [{ opacity: 0 }, { opacity: 1 }], receipt);
    play(status, [{ opacity: 0 }, { opacity: 1 }], receipt);
  } else {
    // The card gives as the blob lets go, and takes the hit when it lands.
    const kick = HIT - SLING + 240;
    play(
      card,
      [
        { transform: nudge(0), easing: "ease-out" },
        { transform: nudge(-2), offset: 45 / kick, easing: "ease-in-out" },
        { transform: nudge(0), offset: (HIT - SLING) / kick, easing: "ease-out" },
        { transform: nudge(3), offset: (HIT - SLING + 50) / kick, easing: "ease-in-out" },
        { transform: nudge(-1), offset: (HIT - SLING + 140) / kick, easing: "ease-in-out" },
        { transform: nudge(0) },
      ],
      { delay: SLING, duration: kick }
    );

    // The summary is written in the blob's wake: its clip edge trails the head.
    const edge = (x: number) => `inset(-4px ${frame.width - 12 - (x - 14)}px -4px 0)`;
    play(summary, [{ opacity: 1, clipPath: edge(back.x) }, { opacity: 1, clipPath: edge(frame.width + 2) }], {
      delay: SLING,
      duration: HIT - SLING,
      easing: `cubic-bezier(${LAUNCH.join(",")})`,
      fill: "forwards",
    });

    if (ghost) play(ghost, [{ opacity: 1 }, { opacity: 0 }], { delay: HIT - 20, duration: 40, fill: "forwards" });
    // The hit: the blob bursts green over the "Sending" badge. The splat pulls
    // itself into the badge's shape, stamped "Sent", while drops fly off it.
    const splat: Keyframe[] = [
      { opacity: 1, transform: at(to, 0, 0.75, 1.9), easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
      { opacity: 1, transform: at(to, 0, 1.5, 1.7), offset: 0.24, easing: "ease-in-out" },
      { opacity: 1, transform: at(to, 0, 0.95, 0.9), offset: 0.56, easing: "ease-in-out" },
      { opacity: 1, transform: at(to, 0, 1.03, 1.04), offset: 0.8, easing: "ease-in-out" },
      { opacity: 1, transform: at(to, 0, 1) },
    ];
    const pill = (parent: HTMLElement) => {
      const element = add(parent, "draft-fx-blob", green);
      Object.assign(element.style, {
        top: `${-badge.height / 2}px`,
        left: `${-badge.width / 2}px`,
        width: `${badge.width}px`,
        height: `${badge.height}px`,
      });
      return element;
    };
    play(pill(gooLayer), splat, { delay: HIT, duration: STAMP });
    const stamp = pill(stage);
    play(stamp, splat, { delay: HIT, duration: STAMP, fill: "forwards" });
    // [angle, distance, size]: thrown wide, mostly down and back into the card,
    // where there is room to see them. Each slows as it goes and shrinks all the way.
    const drops: [number, number, number][] = [
      [0.35, 52, 13],
      [1.0, 66, 16],
      [2.15, 80, 17],
      [2.8, 58, 13],
      [3.4, 72, 15],
      [5.7, 46, 14],
    ];
    drops.forEach(([angle, distance, size], index) => {
      const frames = Array.from({ length: 9 }, (_, step) => {
        const time = step / 8;
        const reach = distance * (1 - (1 - time) ** 3);
        const point = { x: to.x + Math.cos(angle) * reach, y: to.y + Math.sin(angle) * reach };
        return { opacity: 1, transform: at(point, 0, (size / 32) * (1 - time ** 1.6)) };
      });
      play(add(gooLayer, "draft-fx-blob", green), frames, { delay: HIT, duration: 280 + (index % 3) * 50 });
    });
    const label = add(stage, "draft-status draft-fx-ghost draft-fx-stamp");
    label.innerHTML = `<span class="draft-status-dot"></span>Sent`;
    label.style.top = `${badge.y}px`;
    label.style.left = `${badge.x}px`;
    play(label, [{ opacity: 0, transform: "scale(1.5)" }, { opacity: 1, offset: 0.4 }, { opacity: 1, transform: "scale(1)" }], {
      delay: HIT + 40,
      duration: 200,
      easing: "cubic-bezier(0.3, 1.4, 0.5, 1)",
      fill: "forwards",
    });
    // The stamp relaxes into the settled badge.
    const relax: KeyframeAnimationOptions = { delay: HIT + STAMP, duration: RELAX, easing: "ease-in-out", fill: "forwards" };
    play(stamp, [{ opacity: 1 }, { opacity: 0 }], relax);
    play(label, [{ opacity: 1 }, { opacity: 0 }], relax);
    play(status, [{ opacity: 0 }, { opacity: 1 }], { ...relax, fill: "both" });
  }

  const timer = window.setTimeout(done, discard ? RECEIPT.delay + RECEIPT.duration + 20 : END);
  return () => {
    window.clearTimeout(timer);
    release();
    for (const animation of animations) animation.cancel();
    layer.remove();
  };
}
