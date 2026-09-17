"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  CalendarClock,
  ChevronsRight,
  PanelLeftClose,
  Plug,
  Clock3,
  FileText,
  Monitor,
  Plus,
  Search,
  Settings,
  Terminal,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { DesktopPlusIcon, DesktopMicIcon } from "./desktop-demo-controls";
import "./desktop-demo.css";

const examples = [
  {
    id: "research",
    label: "Compare vendors",
    name: "Research",
    acknowledgment: "I'll compare pricing, SSO support, and fit with your requirements.",
    shape: "helmet" as const,
    color: "#ff7a1a",
    preview: "Vendor comparison is ready.",
    prompt:
      "Compare these three vendors against our requirements and budget. Check pricing and SSO support. Save a recommendation with source links.",
    reply:
      "I recommend Northstar. It meets the requirements and has the lowest annual price. The comparison includes pricing, SSO support, and source notes.",
    file: "vendor-review.md",
    fileMeta: "Recommendation · 3 vendors",
    heading: "Vendor comparison",
    subheading: "Research / Team software",
    rows: [
      ["Northstar", "$144", "Included", "Best fit"],
      ["Meridian", "$216", "Add-on", "Runner-up"],
      ["Orbit", "$288", "Included", "Over budget"],
    ],
  },
  {
    id: "operations",
    label: "Check dashboards",
    name: "Operations",
    acknowledgment: "I'll check the three dashboards and compare with yesterday.",
    shape: "pod" as const,
    color: "#925df2",
    preview: "Daily report is ready.",
    prompt:
      "Every morning at 8, check our vendor dashboards. Export uptime and usage, compare with yesterday, and flag changes.",
    reply:
      "All three services are healthy. API usage is up 12% since yesterday. I saved uptime and usage changes in the CSV.",
    file: "morning-report.csv",
    fileMeta: "Daily report · 3 dashboards",
    heading: "Daily dashboard report",
    subheading: "Operations / 08:00 run",
    rows: [
      ["API", "99.99%", "+12%", "Healthy"],
      ["Database", "100%", "+3%", "Healthy"],
      ["Storage", "100%", "+2%", "Healthy"],
    ],
  },
  {
    id: "code",
    label: "Fix a failing test",
    name: "Engineering",
    acknowledgment: "I'll reproduce the failure, fix it, and rerun the tests.",
    shape: "chip" as const,
    color: "#27baae",
    preview: "The fix is ready for review.",
    prompt:
      "Run the test suite, track down the failure, and fix it. Leave me the diff and explain what changed.",
    reply:
      "The parser returned an invalid Date for empty input. I changed it to return null and added a regression test. All 24 tests pass. The diff is ready for review.",
    file: "fix-summary.md",
    fileMeta: "Code change · 24 tests passing",
    heading: "Date parser fix",
    subheading: "Engineering / Date parser fix",
    rows: [],
  },
];

const DEMO_STAGE_ENDS = [1100, 2500, 3900, 5300];
const DEMO_DURATION = DEMO_STAGE_ENDS[DEMO_STAGE_ENDS.length - 1];
// Give the result time to be read before automatically switching workers.
const DEMO_CYCLE_DURATION = DEMO_DURATION + 4200;

function sampleFileContent(scenario: (typeof examples)[number]) {
  const table = [
    "| Provider | Annual price | SSO | Verdict |",
    "| --- | --- | --- | --- |",
    ...scenario.rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
  const diff = [
    "```diff",
    " export function parseDate(input) {",
    "-  return new Date(input);",
    "+  if (!input?.trim()) return null;",
    "+  return new Date(input);",
    " }",
    "```",
    "",
    "Validation: 24 tests passed, 0 failed. Includes an empty-input regression test.",
  ].join("\n");
  return scenario.id === "operations"
    ? "Service,Uptime,Usage change,Status\n" +
        scenario.rows.map((row) => row.join(",")).join("\n") +
        "\n"
    : `# ${scenario.heading}\n\n${scenario.reply}\n\n${scenario.id === "code" ? diff : table + "\n\n## Why Northstar\nThe required SSO feature is included. It costs $72 less per year than Meridian and $144 less than Orbit. Meridian requires an add-on; Orbit exceeds the sample budget.\n\n## Sample source notes\nNorthstar pricing page; Meridian plan documentation; Orbit SSO documentation. These are fictional vendors in a product demonstration, not live citations."}\n\n---\nSample output from the OpenTeam interactive product demo. All data is illustrative.\n`;
}

function TrafficLights() {
  return (
    <div className="pd-traffic" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

export function ProductDemo() {
  const showcase = useRef<HTMLDivElement>(null);
  const scenarioTabs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelId = useId();
  const progress = useRef<HTMLSpanElement>(null);
  const playback = useRef<Animation | null>(null);
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState(0);
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(false);
  const [runId, setRunId] = useState(0);
  const scenario = examples[selected];
  const fileBytes = new TextEncoder().encode(sampleFileContent(scenario)).byteLength;
  const fileSize = fileBytes < 1024 ? `${fileBytes} B` : `${(fileBytes / 1024).toFixed(1)} KB`;
  const done = stage >= 4;
  const active = visible && documentVisible;
  const avatarMode = !active ? "still" : done ? "idle" : "thinking";

  function selectScenario(index: number) {
    setSelected(index);
    setStage(0);
    setRunId((id) => id + 1);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % examples.length; break;
      case "ArrowLeft": next = (index - 1 + examples.length) % examples.length; break;
      case "Home": next = 0; break;
      case "End": next = examples.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectScenario(next);
    scenarioTabs.current[next]?.focus();
  }

  useEffect(() => {
    const syncDocument = () => setDocumentVisible(!document.hidden);
    syncDocument();
    document.addEventListener("visibilitychange", syncDocument);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { threshold: 0.12 }
    );
    if (showcase.current) observer.observe(showcase.current);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncDocument);
    };
  }, []);

  useEffect(() => {
    if (!progress.current) return;
    // Fill continuously until the tab switches, including the result entrance.
    const animation = progress.current.animate(
      [
        { transform: "scaleX(0)", offset: 0 },
        { transform: "scaleX(1)", offset: 1 },
      ],
      { duration: DEMO_CYCLE_DURATION, easing: "linear", fill: "forwards" }
    );
    animation.pause();
    playback.current = animation;
    return () => {
      animation.cancel();
      playback.current = null;
    };
  }, [runId]);

  useEffect(() => {
    const animation = playback.current;
    if (!animation) return;
    if (!active) return;

    const nextTask = () => {
      setSelected((index) => (index + 1) % examples.length);
      setStage(0);
      setRunId((id) => id + 1);
    };
    const advanceWhenReady = () => {
      setStage(4);
      nextTask();
    };
    // Continue the automatic cycle when the demo comes back into view.
    if (Number(animation.currentTime) >= DEMO_CYCLE_DURATION) {
      advanceWhenReady();
      return;
    }

    animation.play();
    let frame = 0;
    let previousStage = -1;
    const updateStage = () => {
      const elapsed = Number(animation.currentTime ?? 0);
      if (elapsed >= DEMO_CYCLE_DURATION) {
        advanceWhenReady();
        return;
      }
      const nextStage = DEMO_STAGE_ENDS.filter((end) => elapsed >= end).length;
      if (nextStage !== previousStage) {
        setStage(nextStage);
        previousStage = nextStage;
      }
      frame = requestAnimationFrame(updateStage);
    };
    frame = requestAnimationFrame(updateStage);
    return () => {
      cancelAnimationFrame(frame);
      animation.pause();
    };
  }, [active, runId]);

  // Presentational adapter of desktop Sidebar, DesktopHeader, MessageContent,
  // PromptInput and Inspector. Only sample data and playback belong to the landing.
  return (
    <div
      className="pd-showcase"
      ref={showcase}
      data-demo-task={scenario.id}
      data-demo-stage={stage}
      data-demo-running={active && !done}
      data-demo-motion="true"
    >
      <div className="pd-scenarios">
        <span className="pd-try-label">Example Bots</span>
        <div className="pd-scenario-buttons" role="tablist" aria-label="Example bots">
          {examples.map((item, i) => (
            <button
              key={item.id}
              ref={(element) => { scenarioTabs.current[i] = element; }}
              type="button"
              role="tab"
              id={`${panelId}-${item.id}`}
              aria-controls={panelId}
              aria-selected={selected === i}
              tabIndex={selected === i ? 0 : -1}
              className={`pd-scenario ${selected === i ? "is-selected" : ""}`}
              onClick={() => selectScenario(i)}
              onKeyDown={(event) => handleTabKeyDown(event, i)}
            >
              {i === 0 ? (
                <Search size={14} />
              ) : i === 1 ? (
                <Clock3 size={14} />
              ) : (
                <Terminal size={14} />
              )}
              {item.label}
              {selected === i && (
                <span className="pd-task-progress" aria-hidden="true">
                  <span key={runId} ref={progress} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div
        className="dt-app dt-details-open"
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${scenario.id}`}
        tabIndex={0}
      >
        <aside className="dt-sidebar" aria-label="Demo conversations">
          <div className="dt-sidebar-toolbar">
            <TrafficLights />
            <div className="dt-icon-button" aria-hidden="true">
              <PanelLeftClose size={15} />
            </div>
            <span className="dt-icon-button dt-new" aria-hidden="true">
              <Plus size={16} />
            </span>
          </div>
          <div className="dt-search" aria-hidden="true">
            <Search size={14} />
            <span className="dt-search-placeholder">Search</span>
          </div>
          <div className="dt-conversations">
            {examples.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`dt-conversation ${i === selected ? "is-active" : ""}`}
                aria-label={`${item.name} example`}
                aria-pressed={i === selected}
                onClick={() => selectScenario(i)}
              >
                <BotAvatar
                  shape={item.shape}
                  color={item.color}
                  size={36}
                  mode={i === selected ? avatarMode : "still"}
                />
                <span className="dt-conversation-text">
                  <span>
                    <strong>{item.name}</strong>
                    <time>{i === 0 ? "8:01 AM" : i === 1 ? "8:00 AM" : "Yesterday"}</time>
                  </span>
                  <small>{i === selected && !done ? "Working…" : item.preview}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="dt-sidebar-footer">
            <div>
              <span className="dt-footer-icon">
                <Plug size={14} />
              </span>
              <span className="dt-footer-label">Plugins</span>
            </div>
            <div>
              <span className="dt-account-avatar">JL</span>
              <span className="dt-footer-label">Jordan Lee</span>
            </div>
          </div>
        </aside>
        <section className="dt-chat" aria-label={`${scenario.name} sample conversation`}>
          <header className="dt-chat-header">
            <BotAvatar shape={scenario.shape} color={scenario.color} size={16} mode={avatarMode} />
            <strong>{scenario.name}</strong>
            <div className="dt-icon-button dt-open-details" aria-hidden="true">
              <Monitor size={16} />
            </div>
            <div className="dt-icon-button dt-mobile-screen" aria-label="Worker computer">
              <Monitor size={16} />
            </div>
          </header>
          <div
            className="dt-transcript"
            key={`${scenario.id}-${runId}`}
            role="log"
            aria-label="Sample messages"
            aria-live="off"
          >
            <p className="dt-date">Today 8:00 AM</p>
            <div className="dt-message dt-message-user">
              <div className="dt-bubble">{scenario.prompt}</div>
            </div>
            <div className="dt-response-slot">
              <div
                className="dt-message dt-ack"
                data-revealed={stage > 0}
                aria-hidden={stage === 0}
                inert={stage === 0}
              >
                <div className="dt-bubble">{scenario.acknowledgment}</div>
              </div>
              {stage === 0 && (
                <div className={`dt-thinking ${!active ? "is-paused" : ""}`} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            <div className="dt-response-slot">
              <div
                className="dt-message dt-result"
                data-revealed={done}
                aria-hidden={!done}
                inert={!done}
              >
                <div className="dt-bubble">{scenario.reply}</div>
                <article className="dt-file">
                  <div className="dt-file-open" aria-label={scenario.file}>
                    <span className="dt-file-icon">
                      <FileText size={17} strokeWidth={1.65} />
                    </span>
                    <span>
                      <strong>
                        {scenario.file.slice(0, scenario.file.lastIndexOf("."))}
                        <span className="dt-file-extension">
                          {scenario.file.slice(scenario.file.lastIndexOf("."))}
                        </span>
                      </strong>
                      <small>{fileSize}</small>
                    </span>
                  </div>
                </article>
              </div>
              {stage > 0 && !done && (
                <div
                  className={`dt-thinking ${!active ? "is-paused" : ""}`}
                  role="status"
                  aria-live="off"
                  aria-label={`${scenario.name} is working`}
                >
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
          </div>
          <div className="dt-composer-dock">
            <div className="dt-composer" aria-label="Sample message composer">
              <span className="dt-composer-plus" aria-hidden="true">
                <DesktopPlusIcon />
              </span>
              <span className="dt-placeholder">Message {scenario.name}</span>
              <span className="dt-mic" aria-hidden="true">
                <DesktopMicIcon />
              </span>
            </div>
          </div>
        </section>
        <aside className="dt-inspector" aria-label="Conversation details">
          <header className="dt-inspector-header">
            <span className="dt-icon-button" aria-hidden="true">
              <Settings size={14} />
            </span>
            <div className="dt-icon-button" aria-hidden="true">
              <ChevronsRight size={16} />
            </div>
          </header>
          <div className="dt-screen-preview" aria-label="Worker computer">
            <DesktopScreenCanvas scenario={scenario} />
          </div>
          <p className="dt-screen-label">{scenario.name}&apos;s screen</p>
          <div className="dt-routines">
            <div className="dt-routines-heading">
              <h3>Routines</h3>
              <span aria-hidden="true">
                <Plus size={16} />
              </span>
            </div>
            <div className="dt-routine-row">
              <CalendarClock size={14} />
              <div>
                <strong>
                  {scenario.id === "operations"
                    ? "Check vendor dashboards"
                    : scenario.id === "code"
                      ? "Run the test suite"
                      : "Review vendor pricing"}
                </strong>
                <small>
                  {scenario.id === "research"
                    ? "Monthly on the 1st at 9:00 AM"
                    : "Every day at 8:00 AM"}
                </small>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

const desktopCaptures: Record<string, string> = {
  research: "/screenshots/linux-vendor-review.png",
  operations: "/screenshots/linux-dashboard.png",
  code: "/screenshots/linux-code-review.png",
};

function DesktopScreenCanvas({ scenario }: { scenario: (typeof examples)[number] }) {
  return (
    <Image
      className="dt-screen-canvas"
      src={desktopCaptures[scenario.id]}
      width={1280}
      height={800}
      unoptimized
      alt={`Actual OpenTeam Linux desktop showing ${scenario.name.toLowerCase()}'s sample ${scenario.heading.toLowerCase()}`}
    />
  );
}

export { ComputerDemo, RoutineDemo, MobileDemo, MemoryDemo } from "./app-demo-details";
