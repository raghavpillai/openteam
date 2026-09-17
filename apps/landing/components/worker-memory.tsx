"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  FileText,
  FolderOpen,
  GitMerge,
  Search,
  Server,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./worker-memory.css";

// Memory files use one dated fact per Markdown line. Lasting preferences belong
// in profile.md; time-bound context goes in log/YYYY-MM.md.
const dates = { learned: "2026-09-14", updated: "2026-09-16" };
const profile = {
  flights: "Prefers morning, nonstop flights.",
  originalBudget: "Usually keeps travel spending under $1,800 per trip.",
  personalBudget: "Personal travel budget is $1,800 per trip.",
  workBudget: "Work travel budget is $2,200 per trip.",
};
const trip = "Boston work trip planned for 2026-10-12 to 2026-10-15.";
const conversations = [
  {
    date: "September 14",
    message: (
      <>
        I prefer <mark>morning, nonstop flights</mark>. I usually keep trips{" "}
        <mark>under $1,800</mark>.
      </>
    ),
    reply: "I’ll keep morning, nonstop flights and your $1,800 budget in mind.",
  },
  {
    date: "September 16",
    message: (
      <>
        For work trips, my budget is <mark>$2,200 now</mark>. Keep personal trips{" "}
        <mark>under $1,800</mark>.
      </>
    ),
    reply: "I’ve updated your work-trip budget. Personal trips stay at $1,800.",
  },
  {
    date: "Later that day",
    message: (
      <>
        My Boston work trip is <mark>October 12–15</mark>.
      </>
    ),
    reply: "Got it—October 12–15 for your Boston trip.",
  },
  {
    date: "A new conversation",
    message: (
      <>
        Find flights for my <mark>Boston work trip</mark>.
      </>
    ),
    reply:
      "I’ll look for morning, nonstop flights for October 12–15, keeping the full trip under $2,200.",
  },
];
const stages = [
  "Reading your preference",
  "Picking out lasting preferences",
  "Saved 2 preferences",
  "Updating the budget",
  "Updated work & personal budgets",
  "Saving trip context",
  "Saved to dated history",
  "Finding relevant memories",
  "Using 3 saved facts",
];
const durations = [1200, 1100, 1800, 1400, 1900, 1200, 1700, 1400, 5500];

function MemoryLine({
  number,
  date,
  children,
  added = false,
  removed = false,
  delay = 0,
}: {
  number: number;
  date: string;
  children: ReactNode;
  added?: boolean;
  removed?: boolean;
  delay?: number;
}) {
  return (
    <div
      className="wm-code-line"
      data-added={added}
      data-removed={removed}
      style={{ "--line-delay": `${delay}ms` } as CSSProperties}
    >
      <span className="wm-line-number" aria-hidden="true">
        {removed ? "−" : added ? "+" : number}
      </span>
      <code>
        <span className="wm-code-date">- ({date})</span> {children}
      </code>
    </div>
  );
}

export function WorkerMemory({ children }: { children?: ReactNode }) {
  const { ref, index: stage, playing, props } = useDemoCycle(stages.length, durations);
  const conversationIndex = stage < 3 ? 0 : stage < 5 ? 1 : stage < 7 ? 2 : 3;
  const conversation = conversations[conversationIndex];
  const recalling = stage >= 7;
  const showingLog = stage === 5 || stage === 6;
  const saved = [2, 4, 6, 8].includes(stage);
  const StatusIcon = recalling
    ? Search
    : stage === 3 || stage === 4
      ? GitMerge
      : saved
        ? Check
        : Brain;

  return (
    <div className="wm-scene ws-ui" ref={ref} {...props} data-stage={stage}>
      <div className="wm-intro">{children}</div>
      <div className="wm-studio">
        <div className="wm-conversation" data-recalling={recalling}>
          <header className="wm-chat-header">
            <BotAvatar
              shape="pod"
              color="#925df2"
              size={29}
              mode={playing && !saved ? "thinking" : "idle"}
            />
            <strong>Travel planner</strong>
            <span key={conversationIndex}>{conversation.date}</span>
          </header>
          <div className="wm-exchange" key={conversationIndex}>
            <div
              className="wm-user-message"
              data-extracting={stage === 1 || stage === 3 || stage === 5}
            >
              {conversation.message}
            </div>
            <div className="wm-worker-message" data-ready={saved}>
              <BotAvatar shape="pod" color="#925df2" size={22} mode={saved ? "idle" : "thinking"} />
              <div>
                {saved ? (
                  <div className="wm-worker-answer" key={stage}>
                    {recalling && (
                      <span className="wm-recall-label">
                        <Brain size={12} /> Remembered from earlier chats
                      </span>
                    )}
                    <p>{conversation.reply}</p>
                  </div>
                ) : (
                  <span className="wm-typing" aria-label="Travel planner is working">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="wm-transfer" data-recalling={recalling} data-saved={saved}>
          <span className="wm-transfer-line" aria-hidden="true">
            <i />
          </span>
          <div key={stage}>
            <StatusIcon size={14} />
            <span>{stages[stage]}</span>
            {recalling ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          </div>
          <span className="wm-transfer-line" aria-hidden="true">
            <i />
          </span>
        </div>

        <div className="wm-files" data-recalling={recalling}>
          <header className="wm-files-header">
            <span>
              <FolderOpen size={15} /> Travel planner <span>/ memory</span>
            </span>
            <span>
              <Server size={12} /> Your server
            </span>
          </header>
          <div className="wm-file-tabs" aria-label="Memory files">
            <span data-active={!showingLog} data-matched={recalling}>
              <FileText size={13} /> profile.md {stage >= 2 && <i>{stage >= 4 ? 3 : 2}</i>}
            </span>
            <span data-active={showingLog} data-matched={recalling}>
              <FileText size={13} /> log/2026-09.md {stage >= 6 && <i>1</i>}
            </span>
          </div>

          <div className="wm-file-content">
            {recalling ? (
              <div className="wm-recalled-facts" key="recall">
                <section>
                  <span className="wm-snippet-source">
                    <FileText size={12} /> profile.md <span>Preferences</span>
                  </span>
                  <p>
                    <mark>{profile.flights}</mark>
                  </p>
                  <p>
                    <mark>{profile.workBudget}</mark>
                  </p>
                </section>
                <section>
                  <span className="wm-snippet-source">
                    <FileText size={12} /> log/2026-09.md <span>Trip context</span>
                  </span>
                  <p>
                    <mark>{trip}</mark>
                  </p>
                </section>
              </div>
            ) : (
              <div className="wm-markdown" key={showingLog ? "log" : "profile"}>
                <div className="wm-code-heading">
                  <span className="wm-line-number" aria-hidden="true">
                    1
                  </span>
                  <code>{showingLog ? "# Memory log" : "# About the user"}</code>
                </div>
                {showingLog ? (
                  <MemoryLine number={3} date={dates.updated} added={stage === 5}>
                    {trip}
                  </MemoryLine>
                ) : (
                  <>
                    {stage >= 2 ? (
                      <MemoryLine number={3} date={dates.learned} added={stage === 2}>
                        {profile.flights}
                      </MemoryLine>
                    ) : (
                      <div className="wm-pending-line">
                        <span className="wm-line-number">3</span>
                        <i />
                        <span className="wm-writing-caret" />
                      </div>
                    )}
                    {stage >= 2 && stage <= 3 && (
                      <MemoryLine
                        number={4}
                        date={dates.learned}
                        added={stage === 2}
                        removed={stage === 3}
                        delay={180}
                      >
                        {profile.originalBudget}
                      </MemoryLine>
                    )}
                    {stage >= 4 && (
                      <>
                        <MemoryLine number={4} date={dates.updated} added>
                          {profile.personalBudget}
                        </MemoryLine>
                        <MemoryLine number={5} date={dates.updated} added delay={180}>
                          {profile.workBudget}
                        </MemoryLine>
                      </>
                    )}
                    {stage < 2 && (
                      <div className="wm-pending-line">
                        <span className="wm-line-number">4</span>
                        <i />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <footer className="wm-file-footer">
            <span>
              {recalling
                ? "Relevant snippets"
                : showingLog
                  ? "Dated context"
                  : "Lasting preferences"}
            </span>
            <span key={stage}>
              {saved ? (
                <>
                  <Check size={12} />
                  {recalling ? "Used in this conversation" : "Saved"}
                </>
              ) : (
                <>
                  <span className="wm-saving-dot" />
                  {recalling ? "Matching memories…" : stage < 2 ? "Extracting…" : "Updating…"}
                </>
              )}
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
