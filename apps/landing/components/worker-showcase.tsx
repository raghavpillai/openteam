"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChartColumn,
  Check,
  FileText,
  Globe,
  ListChecks,
  Plane,
  ReceiptText,
  Search,
  Terminal,
  Tickets,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./worker-showcase.css";
import "./worker-polish.css";

const toolMarks = {
  Gmail: { logo: "/logos/gmail.png" },
  "Google Calendar": { logo: "/logos/google-calendar.png" },
  Granola: { logo: "/logos/granola.png" },
  Notion: { logo: "/logos/notion.svg" },
  "Google Drive": { logo: "/logos/google-drive.png" },
  "Web search": { icon: Search },
  Browser: { icon: Globe },
  Terminal: { icon: Terminal },
} as const;

const skillMarks = {
  "Meeting prep": CalendarDays,
  "Commitment tracker": ListChecks,
  "Trip planning": Plane,
  "Fare comparison": Tickets,
  "Invoice reconciliation": ReceiptText,
  "Spend variance review": ChartColumn,
} as const;

const workers = [
  {
    name: "Chief of staff",
    shape: "helmet",
    color: "#ff7a1a",
    role: "Keep the day running smoothly.",
    instructions:
      "Prepare meeting briefs from calendar invites, email threads and Granola notes. Track decisions, owners and deadlines in Notion, and draft follow-ups for overdue commitments. Link the original context; ask before sending messages or moving a meeting.",
    tools: ["Gmail", "Google Calendar", "Granola", "Notion"],
    skills: ["Meeting prep", "Commitment tracker"],
    file: "meeting-brief.md",
    task: "Prepare tomorrow’s meeting brief",
  },
  {
    name: "Travel planner",
    shape: "pod",
    color: "#925df2",
    role: "Work out the details of every trip.",
    instructions:
      "Find flights and hotels around confirmed meetings. Compare baggage, cancellation terms and total trip cost; allow time for transfers. Use saved travel preferences, get the budget from Finance, and ask before booking or changing a reservation.",
    tools: ["Google Calendar", "Web search", "Browser"],
    skills: ["Trip planning", "Fare comparison"],
    file: "boston-itinerary.md",
    task: "Find options for the Boston trip",
  },
  {
    name: "Finance manager",
    shape: "chip",
    color: "#27baae",
    role: "Keep a closer eye on the numbers.",
    instructions:
      "Match invoices in Drive with receipts in Gmail. Reconcile vendor, amount and currency against the expense export; flag duplicates, missing receipts and unusual changes. Send unresolved questions to me with source links. Never approve invoices or move money.",
    tools: ["Gmail", "Google Drive", "Terminal"],
    skills: ["Invoice reconciliation", "Spend variance review"],
    file: "monthly-expenses.csv",
    task: "Review this month’s expenses",
  },
] as const;

export function WorkerProfiles({ children }: { children?: ReactNode }) {
  const cycle = useDemoCycle(workers.length, 4500);
  const selected = cycle.index;
  const worker = workers[selected];
  return (
    <div className="ws-studio ws-ui" ref={cycle.ref} {...cycle.props}>
      <div className="ws-studio-body">
        <div className="ws-studio-copy">
          {children}
          <div className="ws-roster" aria-label="Example workers">
            {workers.map((item, index) => (
              <div key={item.name} className="ws-roster-item" data-selected={selected === index}>
                <BotAvatar shape={item.shape} color={item.color} size={38} ambient />
                <span>
                  {item.name}
                  <small>{item.role}</small>
                </span>
                {selected === index && (
                  <i
                    key={`${selected}-${cycle.revision}-${cycle.playing}`}
                    className="ws-cycle-progress"
                  />
                )}
              </div>
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
              <span className="ws-label">Tools</span>
              <div aria-label={`${worker.name} tools`}>
                {worker.tools.map((tool) => {
                  const mark = toolMarks[tool];
                  return (
                    <span key={tool}>
                      {"logo" in mark ? (
                        <Image src={mark.logo} alt="" width={16} height={16} unoptimized />
                      ) : (
                        <mark.icon size={16} aria-hidden="true" />
                      )}
                      {tool}
                    </span>
                  );
                })}
              </div>
              <span className="ws-label ws-skills-label">Skills</span>
              <div className="ws-worker-skills" aria-label={`${worker.name} skills`}>
                {worker.skills.map((skill) => {
                  const SkillMark = skillMarks[skill];
                  return (
                    <span key={skill}>
                      <SkillMark size={16} aria-hidden="true" />
                      {skill}
                    </span>
                  );
                })}
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
              <div className="ws-result-file">
                <span>
                  <FileText size={18} />
                </span>
                <strong>
                  {worker.file}
                  <small>Saved to workspace</small>
                </strong>
                <Check size={15} />
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}
