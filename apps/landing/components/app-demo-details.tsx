"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronsRight,
  CirclePlus,
  Clock3,
  FileText,
  Mic,
  LoaderCircle,
  X,
  Monitor,
  MonitorUp,
  Pencil,
  Plus,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import { DesktopPlusIcon, DesktopMicIcon } from "./desktop-demo-controls";
import { Button } from "./ui/button";
import "./app-demo-details.css";

// A passive illustration of the handoff request shown in the desktop app.
export function ComputerDemo() {
  const cycle = useDemoCycle(3, [1100, 1500, 12000]);
  const ready = cycle.index === 2;
  return (
    <div
      className="dc-demo"
      ref={cycle.ref}
      {...cycle.props}
      data-handoff-state="requested"
      data-handoff-stage={cycle.index}
    >
      <div className="dc-window" aria-label="Desktop computer handoff demo">
        <section className="dc-chat" aria-label="Research handoff conversation">
          <header className="dc-chat-header">
            <BotAvatar
              shape="helmet"
              color="#ff7a1a"
              size={16}
              mode={ready ? "idle" : "thinking"}
            />
            <strong>Research</strong>
            <span className="dc-live-status">{ready ? "Needs your input" : "Working…"}</span>
          </header>
          <div className="dc-chat-content" aria-label="Sample handoff messages">
            <p className="dc-chat-date">Today 8:04 AM</p>
            <div className="dc-user-bubble">
              Check the vendor dashboard and save a usage report.
            </div>
            <div className="dc-activity-slot">
              <span className="dc-live-activity" key={cycle.index}>
                {ready ? (
                  <>
                    <MonitorUp size={13} />
                    Your computer is ready
                  </>
                ) : (
                  <>
                    <LoaderCircle size={13} />
                    {cycle.index === 0 ? "Opening the vendor dashboard" : "Sign-in required"}
                  </>
                )}
              </span>
            </div>
            <section
              className="dc-handoff-card"
              aria-label="Computer handoff request"
              data-visible={ready}
              aria-hidden={!ready}
            >
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
              <div className="dc-handoff-actions" aria-label="Example handoff choices">
                <span>Skip</span>
                <span>Take over</span>
              </div>
            </section>
          </div>
          <div className="dc-composer" aria-hidden="true">
            <span className="dc-composer-plus">
              <DesktopPlusIcon />
            </span>
            <span>Message Research</span>
            <span className="dc-composer-mic">
              <DesktopMicIcon />
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

export function RoutineDemo() {
  const [enabled, setEnabled] = useState(true);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
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
                setResultOpen(false);
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
              <Button
                variant="secondary"
                className="dr-delete"
                onClick={() => {
                  setRunning(false);
                  setHasRun(false);
                  setResultOpen(false);
                  setDeleted(true);
                }}
              >
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
      {hasRun && !deleted && (
        <div className="dr-sample-result">
          <p role="status">
            {running ? <LoaderCircle size={14} /> : <Check size={14} />}
            {running ? "Updating sample report…" : "Sample run complete"}
          </p>
          <button
            type="button"
            aria-expanded={resultOpen}
            aria-controls="routine-sample-result"
            onClick={() => setResultOpen(!resultOpen)}
          >
            <FileText size={16} /> <span>dashboard-changes.csv</span>
            <ChevronDown size={16} />
          </button>
          <div
            id="routine-sample-result"
            className="dr-result-body"
            data-open={resultOpen}
            inert={!resultOpen}
            aria-hidden={!resultOpen}
          >
            <div>
              <table>
                <caption>Sample changes since yesterday</caption>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Uptime</th>
                    <th>Usage</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>API</td>
                    <td>99.99%</td>
                    <td>+12%</td>
                  </tr>
                  <tr>
                    <td>Database</td>
                    <td>100%</td>
                    <td>+3%</td>
                  </tr>
                  <tr>
                    <td>Storage</td>
                    <td>100%</td>
                    <td>+2%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <p className="dr-caption">Try Test run to see a sample report. No task is scheduled.</p>
    </div>
  );
}

const SAMPLE_MEMORY = `# About the user

- (2026-09-12) Keep the recommendation to one page.
- (2026-09-12) Link to original sources.
- (2026-09-12) Save reports in /workspace/reports.
- (2026-09-12) Track vendor pricing changes.`;

export function MemoryDemo() {
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [memory, setMemory] = useState(SAMPLE_MEMORY);
  const [draft, setDraft] = useState(SAMPLE_MEMORY);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(0);
  const closeEditor = () => {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  };
  return (
    <div className="dm-memory-demo">
      <figure className="dm-file" data-updated={saved > 0 || undefined}>
        <figcaption>
          <FileText size={15} />
          memory/profile.md
        </figcaption>
        {editing ? (
          <textarea
            ref={editor}
            aria-label="Edit sample memory"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <pre key={saved}>
            <code>{memory}</code>
          </pre>
        )}
        <p>Sample file · Changes stay in this demo.</p>
      </figure>
      <div className="dm-memory-controls">
        <span role="status">
          {editing
            ? "Edit a preference, then save."
            : saved
              ? "Sample memory updated."
              : "Your notes are editable."}
        </span>
        <div>
          {editing ? (
            <>
              <Button variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setMemory(draft);
                  setSaved((count) => count + 1);
                  closeEditor();
                }}
              >
                <Check size={14} /> Save memory
              </Button>
            </>
          ) : (
            <Button
              ref={editButton}
              variant="outline"
              onClick={() => {
                setDraft(memory);
                setEditing(true);
                requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
              }}
            >
              <Pencil size={14} /> Edit sample memory
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Dimensions match the native 390pt chat UI, uniformly scaled by its frame.
export function MobileDemo() {
  const cycle = useDemoCycle(5, [1300, 1400, 2000, 1700, 8500]);
  return (
    <div
      ref={cycle.ref}
      {...cycle.props}
      className="dm-mobile-autoplay"
      data-mobile-stage={cycle.index}
    >
      <figure className="dm-mobile-scene" aria-label="Example OpenTeam conversation on iPhone">
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
              <div className="dm-bubble" data-visible={cycle.index >= 1}>
                Northstar includes SSO and costs the least.
              </div>
              <div className="dm-bubble" data-visible={cycle.index >= 2}>
                I saved the comparison in vendor-review.md.
                <div className="dm-attachment">
                  <FileText size={22} />
                  <span>
                    <strong>vendor-review.md</strong>
                    <small>1 KB</small>
                  </span>
                </div>
              </div>
              <div className="dm-bubble dm-user" data-visible={cycle.index >= 3}>
                Check their pricing every Monday at 9 AM.
              </div>
              <div className="dm-bubble" data-visible={cycle.index >= 4}>
                Scheduled. I’ll update the comparison.
              </div>
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
      </figure>
    </div>
  );
}
