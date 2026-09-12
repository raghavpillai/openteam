"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowDownToLine,
  CalendarClock,
  ChevronsRight,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Check,
  Clock3,
  FileText,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Terminal,
  X,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { DesktopPlusIcon, DesktopMicIcon } from "./desktop-demo-controls";
import { Button } from "./ui/button";
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
    steps: [
      "Read the brief and team requirements",
      "Compare three vendors in the browser",
      "Verify pricing and SSO in the docs",
      "Save the comparison and recommendation",
    ],
    reply:
      "I recommend Northstar. It meets the requirements and has the lowest annual price. The comparison includes pricing, SSO support, and source notes.",
    file: "vendor-review.md",
    fileMeta: "Recommendation · 3 vendors",
    heading: "Vendor comparison",
    subheading: "Research / Team software",
    rows: [
      ["Northstar", "$144", "Included", "Best fit"],
      ["Acme", "$216", "Add-on", "Runner-up"],
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
    steps: [
      "Open the saved dashboard sessions",
      "Read uptime and usage metrics",
      "Compare with yesterday’s snapshot",
      "Save the changes in a CSV",
    ],
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
    steps: [
      "Read the project and run the tests",
      "Trace the failure to the date parser",
      "Handle the empty input case",
      "Run the full suite again",
    ],
    reply:
      "The parser returned an invalid Date for empty input. I changed it to return null and added a regression test. All 24 tests pass. The diff is ready for review.",
    file: "fix-summary.md",
    fileMeta: "Code change · 24 tests passing",
    heading: "Date parser fix",
    subheading: "Engineering / Date parser fix",
    rows: [],
  },
];

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
    : `# ${scenario.heading}\n\n${scenario.reply}\n\n${scenario.id === "code" ? diff : table + "\n\n## Why Northstar\nThe required SSO feature is included. It costs $72 less per year than Acme and $144 less than Orbit. Acme requires an add-on; Orbit exceeds the sample budget.\n\n## Sample source notes\nNorthstar pricing page; Acme plan documentation; Orbit SSO documentation. These are fictional vendors in a product demonstration, not live citations."}\n\n---\nSample output from the OpenTeam interactive product demo. All data is illustrative.\n`;
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
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState(4);
  const [paused, setPaused] = useState(false);
  const [compact, setCompact] = useState(false);
  const [details, setDetails] = useState(true);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<"file" | "computer" | null>(null);
  const scenario = examples[selected];
  const fileBytes = new TextEncoder().encode(sampleFileContent(scenario)).byteLength;
  const fileSize = fileBytes < 1024 ? `${fileBytes} B` : `${(fileBytes / 1024).toFixed(1)} KB`;
  const done = stage >= 4;
  const avatarMode = !done && !paused ? "thinking" : "idle";
  useEffect(() => {
    if (done || paused) return;
    const timer = setTimeout(() => setStage((s) => s + 1), 1150);
    return () => clearTimeout(timer);
  }, [stage, done, paused]);
  const choose = (index: number) => {
    setSelected(index);
    setStage(4);
    setPaused(false);
    setPreview(null);
  };
  const replay = () => {
    if (done) {
      setStage(0);
      setPaused(false);
      setPreview(null);
    } else setPaused((value) => !value);
  };
  const download = () => {
    const text = sampleFileContent(scenario);
    const url = URL.createObjectURL(
      new Blob([text], { type: scenario.id === "operations" ? "text/csv" : "text/markdown" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = scenario.file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // Presentational adapter of desktop Sidebar, DesktopHeader, MessageContent,
  // PromptInput and Inspector. Only sample data and replay belong to the landing.
  return (
    <div className="pd-showcase">
      <div className="pd-scenarios">
        <span className="pd-try-label">SAMPLE TASKS</span>
        <div className="pd-scenario-buttons" aria-label="Choose a sample task">
          {examples.map((item, i) => (
            <Button
              variant="ghost"
              key={item.id}
              className={`pd-scenario ${selected === i ? "is-selected" : ""}`}
              aria-pressed={selected === i}
              onClick={() => choose(i)}
            >
              {i === 0 ? (
                <Search size={14} />
              ) : i === 1 ? (
                <Clock3 size={14} />
              ) : (
                <Terminal size={14} />
              )}
              {item.label}
            </Button>
          ))}
        </div>
        <Button variant="ghost" className="pd-replay" onClick={replay}>
          {done ? <RotateCcw size={13} /> : paused ? <Play size={13} /> : <Pause size={13} />}
          {done ? "Replay demo" : paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <div className={`dt-app ${compact ? "dt-compact" : ""} ${details ? "dt-details-open" : ""}`}>
        <aside className="dt-sidebar" aria-label="Demo conversations">
          <div className="dt-sidebar-toolbar">
            <TrafficLights />
            <button
              type="button"
              className="dt-icon-button"
              aria-label="Toggle compact sidebar"
              onClick={() => setCompact(!compact)}
            >
              {compact ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            <span className="dt-icon-button dt-new" aria-hidden="true">
              <Plus size={16} />
            </span>
          </div>
          <label className="dt-search">
            <Search size={14} />
            <input
              aria-label="Search demo conversations"
              placeholder="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="dt-conversations">
            {examples.map(
              (item, i) =>
                item.name.toLowerCase().includes(search.toLowerCase()) && (
                  <button
                    type="button"
                    key={item.id}
                    className={`dt-conversation ${i === selected ? "is-active" : ""}`}
                    onClick={() => choose(i)}
                    aria-label={`Open ${item.name} demo`}
                    aria-pressed={i === selected}
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
                      <small>
                        {i === selected && !done
                          ? paused
                            ? "Run paused"
                            : "Working…"
                          : item.preview}
                      </small>
                    </span>
                  </button>
                )
            )}
            {search &&
              !examples.some((item) => item.name.toLowerCase().includes(search.toLowerCase())) && (
                <p className="dt-no-results">No conversations found</p>
              )}
          </div>
          <div className="dt-sidebar-footer">
            <a href="#plugins" aria-label="Explore plugins">
              <span className="dt-footer-icon">
                <Plug size={14} />
              </span>
              <span className="dt-footer-label">Plugins</span>
            </a>
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
            <button
              type="button"
              className="dt-icon-button dt-open-details"
              aria-label="Open conversation details"
              onClick={() => setDetails(true)}
            >
              <Monitor size={16} />
            </button>
            <button
              type="button"
              className="dt-icon-button dt-mobile-screen"
              aria-label="Open computer"
              onClick={() => setPreview("computer")}
            >
              <Monitor size={16} />
            </button>
          </header>
          <div className="dt-transcript" role="log" aria-label="Sample messages">
            <p className="dt-date">Today 8:00 AM</p>
            <div className="dt-message dt-message-user">
              <div className="dt-bubble">{scenario.prompt}</div>
            </div>
            <div className="dt-message dt-ack">
              <div className="dt-bubble">{scenario.acknowledgment}</div>
            </div>
            {done ? (
              <div className="dt-message dt-result" aria-live="polite">
                <div className="dt-bubble">{scenario.reply}</div>
                <article className="dt-file">
                  <button
                    type="button"
                    className="dt-file-open"
                    onClick={() => setPreview("file")}
                    aria-label={`Preview ${scenario.file}`}
                  >
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
                  </button>
                  <button
                    type="button"
                    className="dt-icon-button"
                    aria-label={`Download ${scenario.file}`}
                    onClick={download}
                  >
                    <ArrowDownToLine size={16} />
                  </button>
                </article>
              </div>
            ) : (
              <div
                className={`dt-thinking ${paused ? "is-paused" : ""}`}
                role="status"
                aria-label={paused ? "Run paused" : `${scenario.name} is working`}
              >
                <span />
                <span />
                <span />
              </div>
            )}
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
            <button
              type="button"
              className="dt-icon-button"
              aria-label="Close details"
              onClick={() => setDetails(false)}
            >
              <ChevronsRight size={16} />
            </button>
          </header>
          <button
            type="button"
            className="dt-screen-preview"
            aria-label="Open computer"
            onClick={() => setPreview("computer")}
          >
            <DesktopScreenCanvas scenario={scenario} />
          </button>
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
      <Dialog.Root
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="dt-preview-backdrop" />
          <Dialog.Popup
            className={`dt-preview-dialog ${preview === "computer" ? "dt-computer-dialog" : ""}`}
          >
            <header>
              <Dialog.Title>
                {preview === "computer" ? `${scenario.name}'s screen` : scenario.file}
              </Dialog.Title>
              {preview === "file" && (
                <button
                  type="button"
                  className="dt-icon-button"
                  aria-label="Download sample file"
                  onClick={download}
                >
                  <ArrowDownToLine size={16} />
                </button>
              )}
              <Dialog.Close
                className="dt-icon-button"
                aria-label={preview === "computer" ? "Close computer view" : "Close preview"}
              >
                {preview === "computer" ? <Minimize2 size={16} /> : <X size={16} />}
              </Dialog.Close>
            </header>
            <Dialog.Description className="dt-visually-hidden">
              Desktop product recreation with sample data.
            </Dialog.Description>
            <div className="dt-preview-content">
              {preview === "computer" ? (
                <DesktopScreenCanvas scenario={scenario} />
              ) : (
                <DesktopDocument scenario={scenario} />
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function DesktopDocument({ scenario }: { scenario: (typeof examples)[number] }) {
  if (scenario.id === "operations") {
    return (
      <div className="dt-document">
        <pre>{sampleFileContent(scenario)}</pre>
      </div>
    );
  }
  return (
    <article className="dt-document">
      <h1>{scenario.heading}</h1>
      <p>{scenario.reply}</p>
      {scenario.id === "code" ? (
        <>
          <pre className="dt-document-diff">
            <code>{` export function parseDate(input) {
-  return new Date(input);
+  if (!input?.trim()) return null;
+  return new Date(input);
 }`}</code>
          </pre>
          <p>Validation: 24 tests passed, 0 failed. Includes an empty-input regression test.</p>
        </>
      ) : (
        <>
          <div className="dt-document-table">
            <table>
              <thead>
                <tr>
                  {["Provider", "Annual price", "SSO", "Verdict"].map((heading) => (
                    <th key={heading}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scenario.rows.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, index) => (
                      <td key={`${index}-${cell}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Why Northstar</h2>
          <p>
            The required SSO feature is included. It costs $72 less per year than Acme and $144 less
            than Orbit. Acme requires an add-on; Orbit exceeds the sample budget.
          </p>
          <h2>Sample source notes</h2>
          <p>
            Northstar pricing page; Acme plan documentation; Orbit SSO documentation. These are
            fictional vendors in a product demonstration, not live citations.
          </p>
        </>
      )}
      <p>Sample output from the OpenTeam interactive product demo. All data is illustrative.</p>
    </article>
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
