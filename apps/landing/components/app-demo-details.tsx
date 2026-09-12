"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronsRight,
  CirclePlus,
  Clock3,
  FileText,
  Mic,
  LoaderCircle,
  X,
  Minimize2,
  Monitor,
  MonitorUp,
  Plus,
  RotateCcw,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { DesktopPlusIcon, DesktopMicIcon } from "./desktop-demo-controls";
import { Button } from "./ui/button";
import "./app-demo-details.css";

type HandoffState = "requested" | "active" | "completed" | "skipped" | "dismissed";

// Presentational states mirror ComputerHandoffCard and BotScreen. The Linux
// frame is captured from the real computer image with a local sample website.
export function ComputerDemo() {
  const [state, setState] = useState<HandoffState>("active");
  const active = state === "active";
  const resolved = state !== "active" && state !== "requested";
  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (event.target as HTMLElement)?.closest(".dc-demo")) {
        setState("dismissed");
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [active]);
  return (
    <div className="dc-demo">
      <div className="dc-window" aria-label="Desktop computer handoff demo">
        {active ? (
          <div
            className="dc-viewer"
            tabIndex={-1}
            onPointerDown={(event) => {
              if (!(event.target as HTMLElement).closest("button"))
                event.currentTarget.focus({ preventScroll: true });
            }}
          >
            <header className="dc-viewer-header">
              <span>Complete the requested step</span>
              <Button
                variant="ghost"
                className="dc-viewer-skip"
                onClick={() => setState("skipped")}
              >
                Skip this step
              </Button>
              <Button className="dc-viewer-done" onClick={() => setState("completed")}>
                I&apos;m done, continue
              </Button>
              <Button
                variant="ghost"
                className="dc-viewer-close"
                aria-label="Close handoff computer view"
                onClick={() => setState("dismissed")}
              >
                <Minimize2 size={16} />
              </Button>
            </header>
            <div
              className="dc-screen-area"
              onClick={(event) => {
                if (event.target === event.currentTarget) setState("dismissed");
              }}
            >
              <Image
                src="/screenshots/linux-sign-in.png"
                width={1280}
                height={800}
                unoptimized
                alt="Actual OpenTeam Linux desktop with Chromium showing a sample Northstar sign-in page"
                className="dc-real-screen"
              />
            </div>
          </div>
        ) : (
          <section className="dc-chat" aria-label="Research handoff conversation">
            <header className="dc-chat-header">
              <BotAvatar
                shape="helmet"
                color="#ff7a1a"
                size={16}
                mode={resolved ? "thinking" : "idle"}
              />
              <strong>Research</strong>
            </header>
            <div className="dc-chat-content" role="log" aria-label="Sample handoff messages">
              <p className="dc-chat-date">Today 8:04 AM</p>
              <div className="dc-user-bubble">
                Check the vendor dashboard and save a usage report.
              </div>
              <section className="dc-handoff-card" aria-label="Computer handoff request">
                <div className="dc-handoff-copy">
                  <MonitorUp size={16} />
                  <div>
                    <strong>Take over the computer</strong>
                    <p>
                      Sign in to Northstar in the browser, then return control so I can check the
                      dashboard.
                    </p>
                  </div>
                </div>
                {resolved ? (
                  <span className="dc-handoff-result">{state}</span>
                ) : (
                  <div className="dc-handoff-actions">
                    <button type="button" onClick={() => setState("skipped")}>
                      Skip
                    </button>
                    <button type="button" onClick={() => setState("active")}>
                      Take over
                    </button>
                  </div>
                )}
              </section>
              {resolved && (
                <div className="dc-assistant-bubble">
                  {state === "completed"
                    ? "Thanks. I’ll check the dashboard and save the report."
                    : "I’ll continue with the information I can access."}
                </div>
              )}
            </div>
            <div className="dc-composer">
              <span className="dc-composer-plus">
                <DesktopPlusIcon />
              </span>
              <span>Message Research</span>
              <span className="dc-composer-mic">
                <DesktopMicIcon />
              </span>
            </div>
          </section>
        )}
      </div>
      <div className="dc-demo-caption">
        <span>Desktop handoff · Sample sign-in</span>
        <Button variant="ghost" onClick={() => setState("requested")}>
          <RotateCcw size={12} />
          Replay demo
        </Button>
      </div>
    </div>
  );
}

export function RoutineDemo() {
  const [enabled, setEnabled] = useState(true);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [schedules, setSchedules] = useState(["Every day at 8:00 AM"]);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setRunning(false);
      setHasRun(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, [running]);
  return (
    <div className="dr-demo">
      <section className="dr-panel" aria-label="Sample desktop routine editor">
        <header className="dr-header">
          <ChevronLeft size={16} />
          <span>Routine</span>
          <ChevronsRight size={16} />
        </header>
        {deleted ? (
          <div className="dr-empty">
            <p>Routine deleted</p>
            <Button
              onClick={() => {
                setDeleted(false);
                setRunning(false);
                setHasRun(false);
                setSchedules(["Every day at 8:00 AM"]);
                setEnabled(true);
              }}
            >
              Restore sample routine
            </Button>
          </div>
        ) : (
          <>
            <div className="dr-actions">
              <button
                type="button"
                role="switch"
                aria-label="Active sample routine"
                aria-checked={enabled}
                className="dr-switch"
                onClick={() => setEnabled(!enabled)}
              >
                <span />
              </button>
              <span>{enabled ? "Active" : "Inactive"}</span>
              <Button variant="secondary" className="dr-delete" onClick={() => {
                setRunning(false);
                setHasRun(false);
                setDeleted(true);
              }}>
                Delete
              </Button>
              <Button className="dr-test" onClick={() => setRunning(true)} disabled={running}>
                {running ? "Running…" : "Test run"}
              </Button>
            </div>
            <div className="dr-fields">
              <label>
                Name
                <input value="Check vendor dashboards" readOnly />
              </label>
              <label>
                Instruction
                <textarea
                  value="Check vendor dashboards. Compare uptime and usage with yesterday. Save the changes in a CSV."
                  readOnly
                />
              </label>
              <div className="dr-field">
                <span>When to run</span>
                <div className="dr-triggers">
                  {schedules.map((schedule, index) => (
                    <div key={`${index}-${schedule}`}>
                      <Clock3 size={14} />
                      <span>{schedule}</span>
                      <button
                        type="button"
                        className="dr-remove-schedule"
                        aria-label={`Remove schedule ${index + 1}`}
                        onClick={() =>
                          setSchedules((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {schedules.length < 8 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSchedules((current) => [
                          ...current,
                          current.length ? "Every day at 5:00 PM" : "Every day at 8:00 AM",
                        ])
                      }
                    >
                      <CirclePlus size={14} />
                      Add another
                    </button>
                  )}
                </div>
              </div>
              <div className="dr-field">
                <span>Run history</span>
                <div className="dr-history" aria-live="polite">
              {(running || hasRun) && (
                    <div>
                      <time>Just now</time>
                      <span>
                        {running ? (
                          <LoaderCircle className="dr-running" size={14} aria-label="Running" />
                        ) : (
                          <Check size={14} aria-label="Completed" />
                        )}
                      </span>
                    </div>
                  )}
                  <div>
                    <time>Today at 8:00 AM</time>
                    <Check size={14} aria-label="Completed" />
                  </div>
                  <div>
                    <time>Yesterday at 8:00 AM</time>
                    <Check size={14} aria-label="Completed" />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
      <p className="dr-caption">Sample routine · no task is scheduled</p>
    </div>
  );
}

export function MemoryDemo() {
  return (
    <figure className="dm-file">
      <figcaption>
        <FileText size={15} />
        memory/profile.md
      </figcaption>
      <pre>
        <code>{`# About the user

- (2026-09-12) Keep the recommendation to one page.
- (2026-09-12) Link to original sources.
- (2026-09-12) Save reports in /workspace/reports.
- (2026-09-12) Track vendor pricing changes.`}</code>
      </pre>
      <p>Sample memory file</p>
    </figure>
  );
}

// Dimensions match the native 390pt chat UI, uniformly scaled by its frame.
export function MobileDemo() {
  return (
    <div className="ot-mobile-scene dm-mobile-scene">
      <div className="dm-phone-frame">
        <div className="dm-phone">
          <div className="dm-status">
            <span>9:41</span>
            <i />
            <span>••• ▰</span>
          </div>
          <header className="dm-header">
            <span className="dm-circle">
              <ChevronLeft size={18} />
            </span>
            <div className="dm-identity">
              <BotAvatar shape="helmet" color="#ff7a1a" size={27} mode="idle" />
              <strong>Research</strong>
            </div>
            <span className="dm-circle dm-computer">
              <Monitor size={18} />
            </span>
          </header>
          <div className="dm-messages">
            <time>Today, 9:41 AM</time>
            <div className="dm-bubble dm-user">Which vendor do you recommend?</div>
            <div className="dm-bubble">Northstar includes SSO and costs the least.</div>
            <div className="dm-bubble">
              I saved the comparison in vendor-review.md.
              <div className="dm-attachment">
                <FileText size={22} />
                <span>
                  <strong>vendor-review.md</strong>
                  <small>1 KB</small>
                </span>
              </div>
            </div>
            <div className="dm-bubble dm-user">Check their pricing again on October 1 at 9 AM.</div>
            <div className="dm-bubble">Scheduled. I’ll update the comparison.</div>
          </div>
          <div className="dm-composer-row">
            <span className="dm-circle">
              <Plus size={20} />
            </span>
            <div className="dm-composer">
              <span>Message Research</span>
              <span className="dm-mic">
                <Mic size={16} />
              </span>
            </div>
          </div>
          <div className="dm-home" />
        </div>
      </div>
      <span className="dm-phone-caption">iPhone chat · Sample conversation</span>
    </div>
  );
}
