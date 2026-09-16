"use client";

import Image from "next/image";
import { useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  Folder,
  Globe,
  KeyRound,
  Laptop,
  LockKeyhole,
  MousePointer2,
  Pencil,
  Server,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { ChatGPTLogo, ClaudeLogo } from "./model-provider-logos";
import { useDemoCycle } from "./use-demo-cycle";
import "./worker-showcase.css";
import "./worker-polish.css";

const workers = [
  {
    name: "Chief of staff",
    shape: "helmet",
    color: "#ff7a1a",
    role: "Keep the day running smoothly.",
    instructions:
      "Prepare me for meetings, keep track of commitments, and make sure nothing important slips through.",
    apps: ["Calendar", "Email", "Meeting notes"],
    file: "meeting-brief.md",
    task: "Prepare tomorrow’s meeting brief",
    preview: [
      "10:00 · Acme intro with Maya Chen",
      "14:30 · Northstar pilot follow-up",
      "Review: last call notes + pilot outline",
    ],
  },
  {
    name: "Travel planner",
    shape: "pod",
    color: "#925df2",
    role: "Work out the details of every trip.",
    instructions:
      "Plan travel around my calendar and preferences. Compare options, keep within budget, and ask before booking.",
    apps: ["Calendar", "Email", "Web search"],
    file: "boston-itinerary.md",
    task: "Find options for the Boston trip",
    preview: [
      "8:10 AM · Morning flight to Boston",
      "Hotel near your downtown meetings",
      "Estimated trip total: $1,420",
    ],
  },
  {
    name: "Finance manager",
    shape: "chip",
    color: "#27baae",
    role: "Keep a closer eye on the numbers.",
    instructions:
      "Review expenses, organize invoices, and flag unusual spending. Keep a clear record of what needs my attention.",
    apps: ["Email", "Documents", "Spreadsheets"],
    file: "monthly-expenses.csv",
    task: "Review this month’s expenses",
    preview: [
      "3 invoices ready for review",
      "Software spend up $126 this month",
      "One duplicate charge flagged",
    ],
  },
] as const;

export function WorkerProfiles({ children }: { children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const cycle = useDemoCycle(workers.length, 8200, !expanded);
  const selected = cycle.index;
  const worker = workers[selected];
  return (
    <div className="ws-studio ws-ui" ref={cycle.ref} {...cycle.props}>
      <div className="ws-studio-top">
        <span>
          <Server size={15} />
          Your personal cloud
        </span>
        <div className="ws-studio-activity">
          <span className="ws-presence">
            <i />
            <i />
            <i />
          </span>
          3 workers online
        </div>
      </div>
      <div className="ws-studio-body">
        <div className="ws-studio-copy">
          {children}
          <div className="ws-roster" aria-label="Choose an example worker">
            {workers.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={selected === index}
                aria-controls="worker-profile"
                onClick={() => {
                  setExpanded(false);
                  cycle.select(index);
                }}
              >
                <BotAvatar shape={item.shape} color={item.color} size={38} ambient />
                <span>
                  {item.name}
                  <small>{item.role}</small>
                </span>
                <ChevronRight size={17} />
                {selected === index && (
                  <i
                    key={`${selected}-${cycle.revision}-${cycle.playing}`}
                    className="ws-cycle-progress"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
        <div
          className="ws-worker-deck"
          style={{ "--worker-color": worker.color } as React.CSSProperties}
        >
          <div className="ws-deck-back ws-deck-back-one" aria-hidden="true" />
          <div className="ws-deck-back ws-deck-back-two" aria-hidden="true" />
          <article id="worker-profile" className="ws-worker-card" key={worker.name}>
            <div className="ws-worker-card-top">
              <span>Worker profile</span>
              <span>0{selected + 1} / 03</span>
            </div>
            <div className="ws-worker-identity">
              <span className="ws-worker-portrait">
                <BotAvatar shape={worker.shape} color={worker.color} size={68} ambient />
                <i />
              </span>
              <div>
                <h3>{worker.name}</h3>
                <span>
                  <i />
                  Ready to work
                </span>
              </div>
            </div>
            <div className="ws-worker-instructions">
              <span className="ws-label">Instructions</span>
              <p>{worker.instructions}</p>
            </div>
            <div className="ws-connected">
              <span className="ws-label">Works with</span>
              <div>
                {worker.apps.map((app) => (
                  <span key={app}>{app}</span>
                ))}
              </div>
            </div>
            <div className="ws-worker-result" key={`${selected}-${cycle.revision}`}>
              <div className="ws-task-status">
                <span className="ws-task-working">
                  <span className="ws-activity-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  Working on it
                </span>
                <span className="ws-task-finished">
                  <Check size={13} />
                  Ready for you
                </span>
                <span>Just now</span>
              </div>
              <p>{worker.task}</p>
              <button
                className="ws-result-file"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                <span>
                  <FileText size={18} />
                </span>
                <strong>
                  {worker.file}
                  <small>{expanded ? "Close preview" : "Open file"}</small>
                </strong>
                <ChevronRight size={15} />
              </button>
              {expanded && (
                <ul className="ws-result-preview">
                  {worker.preview.map((line) => (
                    <li key={line}>
                      <Check size={12} />
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

const computers = [
  {
    name: "Research",
    shape: "helmet",
    color: "#ff7a1a",
    src: "/screenshots/linux-vendor-review.png",
    alt: "Worker’s Linux desktop with a browser comparing vendors",
    activity: "Comparing vendor plans",
    source: "Browser · Pricing & features",
    file: "vendor-review.md",
  },
  {
    name: "Operations",
    shape: "pod",
    color: "#925df2",
    src: "/screenshots/linux-dashboard.png",
    alt: "Worker’s Linux desktop with a business dashboard open",
    activity: "Reviewing the weekly report",
    source: "Browser · Business dashboard",
    file: "weekly-report.csv",
  },
] as const;

export function ComputerWorkspace({ children }: { children?: ReactNode }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const cycle = useDemoCycle(computers.length, 8000, openFile === null);
  const selected = cycle.index;
  const computer = computers[selected];
  return (
    <div className="ws-machine ws-ui" ref={cycle.ref} {...cycle.props}>
      <div className="ws-machine-intro">
        {children}
        <div className="ws-machine-status">
          <span>
            <Server size={15} /> Your compute
          </span>
        </div>
      </div>
      <div className="ws-computer">
        <div className="ws-computer-toolbar">
          <div className="ws-computer-workers" aria-label="Choose a worker’s computer">
            {computers.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={selected === index}
                aria-controls="worker-screen"
                onClick={() => cycle.select(index)}
              >
                <BotAvatar shape={item.shape} color={item.color} size={23} mode="still" />
                {item.name}
              </button>
            ))}
          </div>
          <span>
            <Server size={14} />
            Your server
          </span>
        </div>
        <div className="ws-computer-body">
          <div className="ws-screen" id="worker-screen">
            <div className="ws-screen-toolbar">
              <Laptop size={15} />
              <span>{computer.name}’s computer</span>
              <span className="ws-screen-status">
                <i />
                {computer.activity}
              </span>
            </div>
            <div className="ws-screen-view" key={`${computer.src}-${cycle.revision}`}>
              <Image
                className="ws-screen-capture"
                src={computer.src}
                alt={computer.alt}
                width={1280}
                height={800}
                unoptimized
              />
              <span className="ws-live-cursor" aria-hidden="true">
                <MousePointer2 size={20} fill="currentColor" />
                <span>{computer.name}</span>
              </span>
              <div className="ws-screen-live-task">
                <BotAvatar
                  shape={computer.shape}
                  color={computer.color}
                  size={27}
                  mode="thinking"
                />
                <div>
                  <strong>{computer.activity}</strong>
                  <span>{computer.source}</span>
                </div>
                <span className="ws-live-task-working">
                  <i />
                  <i />
                  <i />
                </span>
                <Check className="ws-live-task-done" size={16} />
                <span className="ws-screen-task-progress" />
              </div>
            </div>
            <div className="ws-desktop-tools">
              <span>
                <Globe size={12} />
                Browser
              </span>
              <span>
                <Terminal size={12} />
                Terminal
              </span>
              <span>
                <Folder size={12} />
                Files
              </span>
              <span className="ws-desktop-live">
                <i />
                Live
              </span>
            </div>
          </div>
          <aside className="ws-workspace">
            <div className="ws-workspace-heading">
              <Folder size={17} />
              <strong>Shared workspace</strong>
            </div>
            <div className="ws-folder">
              <ChevronRight size={13} />
              <Folder size={14} />
              Team files
            </div>
            {[
              ["vendor-review.md", "Research"],
              ["weekly-report.csv", "Operations"],
              ["company-context.md", "You"],
            ].map(([name, owner]) => (
              <button
                key={name}
                type="button"
                className="ws-workspace-file"
                data-current={name === computer.file}
                aria-expanded={openFile === name}
                onClick={() => setOpenFile(openFile === name ? null : name)}
              >
                <FileText size={17} />
                <span>
                  <strong>{name}</strong>
                  <small>
                    {owner}
                    {name === computer.file && <span className="ws-file-writing"> · updating</span>}
                  </small>
                </span>
                {name === computer.file && <span className="ws-file-pulse" aria-hidden="true" />}
              </button>
            ))}
            {openFile ? (
              <div className="ws-file-peek">
                <button
                  type="button"
                  aria-label="Close file preview"
                  onClick={() => setOpenFile(null)}
                >
                  <X size={14} />
                </button>
                <strong>{openFile}</strong>
                <p>
                  {openFile === "vendor-review.md"
                    ? "Northstar is the lowest-cost option that includes SSO. Source links and plan details saved for the team."
                    : openFile === "weekly-report.csv"
                      ? "This week’s report is ready. Revenue, new accounts, and open support requests are included."
                      : "A small team working across sales, operations, and product. Keep recommendations concise and include sources."}
                </p>
              </div>
            ) : (
              <div className="ws-workspace-members">
                <div>
                  {computers.map((item) => (
                    <BotAvatar
                      key={item.name}
                      shape={item.shape}
                      color={item.color}
                      size={22}
                      mode="still"
                    />
                  ))}
                </div>
                <span>Shared with both workers</span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

export function WorkerMemory({ children }: { children?: ReactNode }) {
  const [preference, setPreference] = useState(
    "Prefer morning flights. Keep travel plans under $1,800."
  );
  const [draft, setDraft] = useState(preference);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const cycle = useDemoCycle(3, [2600, 3200, 7000], !editing);
  const finish = (save: boolean) => {
    if (save && draft.trim()) setPreference(draft.trim());
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  return (
    <div
      className="ws-memory-scene ws-ui"
      ref={cycle.ref}
      {...cycle.props}
      data-memory-stage={cycle.index}
    >
      <div className="ws-memory-intro">
        {children}
        <div className="ws-memory-persistence">
          <LockKeyhole size={15} />
          <span>Your memory. On your compute.</span>
        </div>
      </div>
      <div className="ws-memory">
        <div className="ws-memory-journey" aria-label="Memory example stages">
          {["Tell it once", "Saved", "Remembered"].map((step, index) => (
            <button
              type="button"
              key={step}
              aria-pressed={cycle.index === index}
              onClick={() => cycle.select(index)}
            >
              <span>{cycle.index > index ? <Check size={10} /> : `0${index + 1}`}</span>
              {step}
            </button>
          ))}
        </div>
        <div className="ws-memory-note">
          <span>You, last week</span>
          <p>Morning flights, please. And keep it under $1,800.</p>
          <Check size={16} />
        </div>
        <div className="ws-memory-file">
          <header>
            <FileText size={17} />
            <span>Travel planner / memory.md</span>
            <button
              ref={editButton}
              type="button"
              aria-label="Edit example travel preferences"
              onClick={() => {
                setDraft(preference);
                setEditing(true);
              }}
            >
              <Pencil size={15} />
            </button>
          </header>
          <div className="ws-memory-content">
            <span className="ws-label">Your preferences</span>
            {editing ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  finish(true);
                }}
              >
                <textarea
                  aria-label="Travel preferences"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") finish(false);
                  }}
                />
                <div className="ws-memory-actions">
                  <button type="button" onClick={() => finish(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={!draft.trim()}>
                    Save memory
                  </button>
                </div>
              </form>
            ) : (
              <p className="ws-saved-preference">{preference}</p>
            )}
            <span className="ws-label">Shared knowledge</span>
            <div className="ws-memory-shared">
              <Folder size={15} />
              <span>Company travel policy</span>
              <span>Team</span>
            </div>
            <div className="ws-memory-shared">
              <Folder size={15} />
              <span>Upcoming meetings</span>
              <span>Team</span>
            </div>
          </div>
          <footer>
            <LockKeyhole size={13} />
            Stored on your server
            <span className="ws-memory-save-status">
              <Check size={12} />
              Saved
            </span>
          </footer>
        </div>
        <div className="ws-memory-recall">
          <span className="ws-memory-later">Next time</span>
          <div className="ws-mini-user">Plan my next trip to Boston.</div>
          <div className="ws-memory-reply">
            <BotAvatar shape="pod" color="#925df2" size={26} ambient />
            <div>
              <strong>Travel planner</strong>
              <p>I’ll use your saved preferences and check the team’s travel policy.</p>
              <span>
                <Sparkles size={13} />
                Using your memory
              </span>
              <blockquote>{preference}</blockquote>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const providers = [
  {
    name: "ChatGPT",
    icon: ChatGPTLogo,
    method: "Sign in with your ChatGPT account",
    detail: "Connect your account during setup and choose a model for your workers.",
    kind: "Account",
    color: "#427d68",
  },
  {
    name: "Claude",
    icon: ClaudeLogo,
    method: "Sign in with your Claude account",
    detail: "Connect your account during setup. Claude sign-in uses paid extra usage.",
    kind: "Account",
    color: "#b56e50",
  },
  {
    name: "API key",
    icon: KeyRound,
    method: "Bring your own API key",
    detail: "Connect an OpenAI or Anthropic API key. Usage stays with your provider.",
    kind: "API key",
    color: "#8076a5",
  },
  {
    name: "Your endpoint",
    icon: Terminal,
    method: "Use a hosted or local model",
    detail: "Point OpenTeam to a compatible endpoint on your machine or in the cloud.",
    kind: "Endpoint",
    color: "#63788d",
  },
] as const;

export function InferencePicker() {
  const cycle = useDemoCycle(providers.length, 6500);
  const selected = cycle.index;
  const provider = providers[selected];
  return (
    <div className="ws-inference ws-ui" ref={cycle.ref} {...cycle.props}>
      <div className="ws-inference-header">
        <span>
          <Terminal size={13} />
          Model connection
        </span>
        <span>Your choice</span>
      </div>
      <div className="ws-provider-options" aria-label="Model connection options">
        {providers.map((item, index) => (
          <button
            key={item.name}
            type="button"
            aria-pressed={selected === index}
            aria-controls="model-connection"
            onClick={() => cycle.select(index)}
            style={{ "--provider-color": item.color } as React.CSSProperties}
          >
            <item.icon size={20} />
            <span>{item.name}</span>
            <span className="ws-radio">{selected === index && <Check size={11} />}</span>
          </button>
        ))}
      </div>
      <div className="ws-inference-bridge" aria-hidden="true">
        <div
          className="ws-inference-source"
          style={{ "--provider-color": provider.color } as React.CSSProperties}
          key={provider.name}
        >
          <provider.icon size={21} />
          <span>{provider.name}</span>
        </div>
        <div className="ws-inference-wire">
          <i />
          <i />
        </div>
        <div className="ws-inference-workers">
          {workers.map((worker) => (
            <BotAvatar
              key={worker.name}
              shape={worker.shape}
              color={worker.color}
              size={29}
              ambient
            />
          ))}
        </div>
      </div>
      <div id="model-connection" className="ws-provider-detail">
        <div key={provider.name}>
          <span className="ws-provider-kind">{provider.kind}</span>
          <h3>{provider.method}</h3>
          <p>{provider.detail}</p>
        </div>
        <a href="/download" aria-label={`Set up OpenTeam with ${provider.name}`}>
          <ArrowRight size={20} />
        </a>
      </div>
    </div>
  );
}
