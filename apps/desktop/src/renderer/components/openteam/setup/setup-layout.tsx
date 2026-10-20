import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { LoadingOrb } from "../../ui/loading-orb";
import {
  type CSSProperties,
  type FormEvent,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CrossFade } from "./cross-fade";
import {
  useAppearedBefore,
  useEnterAnimation,
  useEntranceResume,
  useStageSwap,
  useVisualSwap,
} from "./screen-transition";
import { ignoresSubmit, nextOptionIndex, setupKeyAction } from "./setup-guards";
import "./setup.css";

export const SETUP_STAGES = ["Server", "AI model", "Voice", "First bot"] as const;
const TONES = ["server", "model", "voice", "bot"] as const;

// The stage the progress bar last showed, across screens, so newly reached segments fill
// (and segments stepped back over empty) instead of appearing in their final state. The
// first-run frame (first-run-shell.tsx) records the step it already showed.
let progressShown: number | null = null;
function useProgressFrom(stage: number) {
  const from = useRef<{ stage: number; from: number } | null>(null);
  if (from.current?.stage !== stage) {
    progressShown ??= Number(document.documentElement.dataset.setupProgress ?? -1);
    from.current = { stage, from: progressShown };
  }
  useEffect(() => {
    progressShown = stage;
  }, [stage]);
  return from.current.from;
}

// How many setup frames are mounted: the root carries the stage's tone while any is (the
// stage's colours live on the root so they ease across screens; see setup.css).
let framesMounted = 0;
function useStageTone(tone: string) {
  useLayoutEffect(() => {
    framesMounted += 1;
    document.documentElement.dataset.setupTone = tone;
    return () => {
      framesMounted -= 1;
      // The next screen mounts in the same commit; only setup closing clears the tone.
      queueMicrotask(() => {
        if (framesMounted === 0) delete document.documentElement.dataset.setupTone;
      });
    };
  }, [tone]);
}

/**
 * The stage's living background: a dot grid and soft lights that drift on one clock, so a
 * new screen's stage carries on where the last one was. They fade up the first time.
 */
function StageBackdrop() {
  const [clock] = useState(() => -Math.round(performance.now()));
  const seen = useAppearedBefore("stage-backdrop");
  return (
    <>
      <span
        className="setup-aurora"
        data-enter={seen ? undefined : ""}
        style={{ "--setup-clock": `${clock}ms` } as CSSProperties}
      >
        <i />
        <i />
        <i />
      </span>
      <span className="setup-dots" data-enter={seen ? undefined : ""} />
    </>
  );
}

// A stage picture is identified by its component, so a picture two screens share stays
// mounted (and only what changed moves) instead of appearing again.
const pictureTypes = new WeakMap<object, string>();
let pictureCount = 0;
const pictureKey = (visual: ReactNode): string => {
  if (!isValidElement(visual) || typeof visual.type === "string") return "picture";
  const type = visual.type as object;
  const known = pictureTypes.get(type);
  if (known) return known;
  pictureCount += 1;
  const key = `picture-${pictureCount}`;
  pictureTypes.set(type, key);
  return key;
};

/**
 * The shared first-run frame: one decision on the left, a picture of what the step
 * does on the right (after Wispr Flow and Raycast).
 */
export function SetupLayout({
  stage,
  screenKey,
  direction = "forward",
  onBack,
  onSkip,
  title,
  body,
  tone,
  children,
  footer,
  visual,
  celebrate = false,
  leaving = false,
  onSubmit,
}: {
  stage: number;
  screenKey: string;
  direction?: "forward" | "back";
  onBack?: () => void;
  onSkip?: () => void;
  title: ReactNode;
  body?: ReactNode;
  /** "error" announces the body as an alert. */
  tone?: "error";
  children?: ReactNode;
  footer?: ReactNode;
  visual?: ReactNode;
  celebrate?: boolean;
  /** The content eases out before the app moves on (sign-in reloads into setup). */
  leaving?: boolean;
  onSubmit?: () => void;
}) {
  const shell = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progressFrom = useProgressFrom(stage);
  useStageTone(TONES[stage] ?? "server");
  useStageSwap(celebrate);
  // Screens that arrive in a view transition are moved by it; a screen's first appearance
  // outside one plays its own entrance, and one shown before (the first-run frame's server
  // check, then the real one) simply stays.
  const enter = useEnterAnimation(screenKey);
  const picture = pictureKey(visual);
  const pictureEnter = useEnterAnimation(`visual:${picture}`);
  const pictureSeen = useAppearedBefore(`picture:${picture}`);
  useVisualSwap(picture);
  // A picture shown on an earlier screen skips its entrance: its intro animations finish
  // at once, while anything added later (a reply bubble, a new look) still animates.
  const visualRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per new picture.
  useLayoutEffect(() => {
    if (!pictureSeen) return;
    for (const animation of visualRef.current?.getAnimations({ subtree: true }) ?? []) {
      if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) {
        animation.finish();
      }
    }
  }, [picture]);
  // Mounted again moments after it first appeared (the first-run frame's server check
  // becoming the real one): every entrance carries on from where it was. Loops run on
  // their own clock and are left alone.
  const resumeAt = useEntranceResume(screenKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per new screen.
  useLayoutEffect(() => {
    if (!resumeAt) return;
    for (const animation of shell.current?.getAnimations({ subtree: true }) ?? []) {
      if (animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) continue;
      animation.currentTime = resumeAt;
    }
  }, [screenKey]);
  const shownAt = useRef(0);
  const touched = useRef(false);
  // Each new screen starts a short settle period (see ignoresSubmit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per new screen.
  useLayoutEffect(() => {
    shownAt.current = performance.now();
    touched.current = false;
  }, [screenKey]);
  // Screen readers hear each new title, unless a field on the new screen already took focus.
  const announced = `${screenKey}\u0000${typeof title === "string" ? title : ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per new title.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && panel.current?.contains(active)) return;
    heading.current?.focus({ preventScroll: true });
  }, [announced]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ignoresSubmit(shownAt.current, performance.now(), touched.current)) return;
    onSubmit?.();
  };
  return (
    <main
      className="setup-shell"
      data-celebrate={celebrate || undefined}
      data-leaving={leaving || undefined}
      data-tone={TONES[stage]}
      ref={shell}
    >
      <div className="electron-window-drag-strip" />
      <section aria-labelledby="setup-title" className="setup-panel electron-no-drag" ref={panel}>
        <header className="setup-header">
          <div aria-label={`Setup: ${SETUP_STAGES[stage]}`} className="setup-progress" role="img">
            {SETUP_STAGES.map((label, index) => (
              <span
                data-fill={
                  index <= stage && index > progressFrom
                    ? "in"
                    : index > stage && index <= progressFrom
                      ? "out"
                      : undefined
                }
                data-state={index < stage ? "done" : index === stage ? "active" : "upcoming"}
                key={label}
                style={
                  {
                    "--setup-fill-delay": `${Math.max(0, index - progressFrom - 1) * 90}ms`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
          <div className="setup-nav">
            {onBack ? (
              <button onClick={onBack} type="button">
                <ArrowLeft aria-hidden="true" className="size-3.5" /> Back
              </button>
            ) : (
              <span />
            )}
            {onSkip ? (
              <button onClick={onSkip} type="button">
                Skip
              </button>
            ) : null}
          </div>
        </header>
        <form
          className="setup-content"
          data-direction={direction}
          data-enter={enter ?? undefined}
          key={screenKey}
          noValidate
          onInput={() => {
            touched.current = true;
          }}
          // A press on the new screen is deliberate; a double click's second half is
          // dropped by detail > 1 instead (see SetupPrimary).
          onPointerDown={() => {
            touched.current = true;
          }}
          onSubmit={submit}
        >
          <p className="setup-eyebrow">{SETUP_STAGES[stage]}</p>
          {/* A new title on the same screen ("It works!") cross-fades in place, settling in
              from just below, so the heading is never blank. */}
          <h1
            data-enter={enter === "enter" ? "screen" : undefined}
            id="setup-title"
            ref={heading}
            tabIndex={-1}
          >
            {typeof title === "string" ? (
              <CrossFade className="setup-title-xfade" value={title} />
            ) : (
              title
            )}
          </h1>
          {body ? (
            <p
              aria-live={tone === "error" ? undefined : "polite"}
              className="setup-body"
              data-tone={tone}
              role={tone === "error" ? "alert" : undefined}
            >
              {typeof body === "string" ? <CrossFade value={body} /> : body}
            </p>
          ) : null}
          <div className="setup-controls">{children}</div>
          {footer ? <div className="setup-footer">{footer}</div> : null}
        </form>
      </section>
      <aside aria-hidden="true" className="setup-stage" data-celebrate={celebrate}>
        <StageBackdrop />
        {/* The payoff: a bloom that swells behind the card as the stage eases to its
            celebration look, then stays as a soft glow. */}
        {celebrate ? <span className="setup-celebrate-glow" /> : null}
        {visual ? (
          <div
            className="setup-visual"
            data-enter={pictureEnter === "enter" || undefined}
            key={picture}
            ref={visualRef}
          >
            {visual}
          </div>
        ) : null}
      </aside>
    </main>
  );
}

/**
 * Enter runs the screen's main action and Esc steps back, wherever focus is, except
 * inside menus and other controls. The arrow keys move between a screen's option rows.
 */
export function useSetupKeyboard(onBack?: () => void) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const form = document.querySelector<HTMLFormElement>(".setup-content");
      const target = event.target as Element | null;
      if (
        form &&
        !document.querySelector("[role='listbox']") &&
        !target?.closest?.("input, textarea, select, [role='combobox'], [role='radiogroup']")
      ) {
        const rows = [...form.querySelectorAll<HTMLElement>(".setup-option")];
        const row = target?.closest?.<HTMLElement>(".setup-option");
        const next = nextOptionIndex(event.key, row ? rows.indexOf(row) : -1, rows.length);
        if (next !== null) {
          event.preventDefault();
          rows[next]?.focus();
          return;
        }
      }
      const action = setupKeyAction(event.key, event.target as Element | null, {
        repeat: event.repeat,
        menuOpen: Boolean(document.querySelector("[role='listbox']")),
        submitDisabled: Boolean(form?.querySelector("button[type='submit']:disabled")),
      });
      if (action === "back" && back.current) {
        event.preventDefault();
        back.current();
      } else if (action === "submit" && form) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Copies text and reports it for a moment, so copy buttons can say "Copied". */
export function useCopied(): [boolean, (text: string) => void] {
  const [copiedAt, setCopiedAt] = useState(0);
  useEffect(() => {
    if (!copiedAt) return;
    const timer = window.setTimeout(() => setCopiedAt(0), 1_600);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);
  const copy = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopiedAt(Date.now()))
      .catch(() => {});
  };
  return [copiedAt > 0, copy];
}

/** The screen's main action. Enter triggers it; the hint says so. */
export function SetupPrimary({
  children,
  busy,
  disabled,
}: {
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
}) {
  // The second click of a double click lands on whatever replaced this screen; drop it.
  const ignoreRepeat = (event: MouseEvent) => {
    if (event.detail > 1) event.preventDefault();
  };
  return (
    <button
      className="setup-primary"
      disabled={disabled || busy}
      onClick={ignoreRepeat}
      type="submit"
    >
      <span className="setup-primary-label">{children}</span>
      {/* The hint and the spinner share one spot and cross-fade, so the label never moves. */}
      <span aria-hidden="true" className="setup-primary-end" data-busy={Boolean(busy)}>
        <kbd>↵</kbd>
        <LoadingOrb aria-hidden inverse size={16} />
      </span>
    </button>
  );
}

/** Runs a click handler for single clicks only; see SetupPrimary. */
const singleClick = (handler: () => void) => (event: MouseEvent) => {
  if (event.detail <= 1) handler();
};

export function SetupLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="setup-link" onClick={singleClick(onClick)} type="button">
      {children}
    </button>
  );
}

export function SetupOption({
  icon,
  title,
  detail,
  onClick,
  selected,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className="setup-option"
      onClick={singleClick(onClick)}
      type="button"
    >
      <span className="setup-option-icon">{icon}</span>
      <span className="setup-option-text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {selected === undefined ? (
        <ChevronRight aria-hidden="true" className="size-4" />
      ) : (
        <span className="setup-option-check" data-on={selected}>
          {selected ? <Check aria-hidden="true" className="size-3.5" strokeWidth={3} /> : null}
        </span>
      )}
    </button>
  );
}

/** A device code split into boxes so it reads like the page it gets typed into. */
export function SetupCode({ code }: { code: string }) {
  return (
    <div aria-label={`Sign-in code ${code}`} className="setup-code" role="text">
      {[...code].map((character, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Code characters repeat and never reorder.
        <span data-dash={character === "-"} key={index} style={{ "--i": index } as CSSProperties}>
          {character}
        </span>
      ))}
    </div>
  );
}

/** A drawn checkmark for moments that just worked. */
export function SetupSuccessMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className ? `setup-success ${className}` : "setup-success"}
      viewBox="0 0 52 52"
    >
      <circle cx="26" cy="26" r="24" />
      <path d="M15 27.5l7 7 15-16" />
    </svg>
  );
}

/** A small check that draws itself, for inline confirmations like "Found OpenTeam". */
export function SetupDrawnCheck() {
  return (
    <svg aria-hidden="true" className="setup-drawn-check" viewBox="0 0 16 16">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** Swaps between two labels with a short cross-fade, e.g. "Copy link" and "Copied". */
export function SetupSwap({ active, on, off }: { active: boolean; on: ReactNode; off: ReactNode }) {
  return (
    <span className="setup-swap" key={active ? "on" : "off"}>
      {active ? on : off}
    </span>
  );
}
