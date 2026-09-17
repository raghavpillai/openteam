"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Brain, CalendarDays, Check, Compass, Sparkles } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./worker-memory.css";

// Human-readable groupings illustrate relevance, not separate storage systems.
const conversations = [
  {
    when: "Getting to know you",
    message: <>I prefer <mark>morning flights</mark>, <mark>nonstop</mark> if possible.</>,
    reply: "Morning and nonstop. I’ll keep that in mind for future trips.",
  },
  {
    when: "Today",
    message: <>I’m going to <mark>Boston, October 12–15</mark>. Keep this trip <mark>under $1,800</mark>.</>,
    reply: "Got it. I’ll plan around those dates and your trip budget.",
  },
  {
    when: "A little later",
    message: <>Actually, allow <mark>$2,200 for Boston</mark>. I need a <mark>flexible return</mark>.</>,
    reply: "Updated to $2,200 for Boston, with a flexible return.",
  },
  {
    when: "A new conversation",
    message: <>Find flights for my <mark>Boston trip</mark>.</>,
    reply: "I’ll look for morning, nonstop flights for October 12–15, with a flexible return and a $2,200 trip budget.",
  },
];
const stages = [
  "Noticing what matters", "Remembering your preferences", "Preferences remembered",
  "Connecting the details", "Trip context remembered", "Updating what’s changed",
  "New budget remembered", "Bringing it back to mind", "Remembered for this conversation",
];
const durations = [1500, 1300, 2500, 1800, 3000, 1800, 3000, 1700, 5600];

function MemoryThought({ children, fresh = false }: { children: ReactNode; fresh?: boolean }) {
  return <span className="wm-thought" data-fresh={fresh}><i aria-hidden="true" />{children}</span>;
}

export function WorkerMemory({ children }: { children?: ReactNode }) {
  const { ref, index: stage, playing, props } = useDemoCycle(stages.length, durations);
  const conversationIndex = stage < 3 ? 0 : stage < 5 ? 1 : stage < 7 ? 2 : 3;
  const conversation = conversations[conversationIndex];
  const recalling = stage >= 7;
  const saved = [2, 4, 6, 8].includes(stage);
  const hasPreferences = stage >= 2;
  const hasTrip = stage >= 4;
  const hasUpdate = stage >= 6;

  return (
    <div className="wm-scene ws-ui" ref={ref} {...props} data-stage={stage}>
      <div className="wm-intro">{children}</div>
      <div className="wm-studio">
        <div className="wm-conversation">
          <header className="wm-chat-header">
            <BotAvatar shape="pod" color="#925df2" size={28} mode={playing && !saved ? "thinking" : "idle"} />
            <strong>Travel planner</strong>
            <span key={conversationIndex}>{conversation.when}</span>
          </header>
          <div className="wm-exchange" key={conversationIndex}>
            <div className="wm-user-message" data-extracting={!saved && !recalling}>{conversation.message}</div>
            <div className="wm-worker-message">
              <BotAvatar shape="pod" color="#925df2" size={22} mode={playing && !saved ? "thinking" : "idle"} />
              {saved ? (
                <div className="wm-worker-answer" key={stage}>
                  {recalling && <span className="wm-recall-label"><Sparkles size={12} /> From your memory</span>}
                  <p>{conversation.reply}</p>
                </div>
              ) : (
                <span className="wm-typing" aria-label="Travel planner is thinking"><i /><i /><i /></span>
              )}
            </div>
          </div>
        </div>

        <div className="wm-memory" data-recalling={recalling}>
          <div className="wm-memory-head">
            <div className="wm-ingestion" data-recalling={recalling} aria-hidden="true">
              <i /><i /><i />{recalling ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            </div>
            <div className="wm-brain" data-learning={!saved}>
              <span className="wm-brain-orbit" aria-hidden="true"><i /><i /><i /></span>
              <span className="wm-brain-core"><Brain size={33} strokeWidth={1.25} /></span>
              <span className="wm-brain-spark wm-brain-spark-one" aria-hidden="true" />
              <span className="wm-brain-spark wm-brain-spark-two" aria-hidden="true" />
            </div>
            <div className="wm-memory-title">
              <strong>Travel planner’s memory</strong>
              <span key={stage}>{saved ? <Check size={12} /> : <Sparkles size={12} />}{stages[stage]}</span>
            </div>
          </div>

          <div className="wm-memory-map">
            <svg className="wm-branches" viewBox="0 0 600 50" preserveAspectRatio="none" fill="none" aria-hidden="true">
              <path d="M300 0V8C300 27 100 13 100 50" /><path d="M300 0V50" /><path d="M300 0V8C300 27 500 13 500 50" />
              <path className="wm-branch-pulse" d="M300 0V8C300 27 100 13 100 50" />
              <path className="wm-branch-pulse" d="M300 0V50" />
              <path className="wm-branch-pulse" d="M300 0V8C300 27 500 13 500 50" />
            </svg>
            <section className="wm-pocket wm-pocket-you" data-active={stage === 1 || stage === 2 || recalling} data-filled={hasPreferences}>
              <div className="wm-pocket-heading"><span><Sparkles size={16} /></span><div><h3>About you</h3><span>Lasting preferences</span></div></div>
              <div className="wm-pocket-thoughts">
                {hasPreferences ? (
                  <div key="preferences"><MemoryThought fresh={stage === 2}>Morning flights</MemoryThought><MemoryThought fresh={stage === 2}>Nonstop preferred</MemoryThought></div>
                ) : <div className="wm-thought-placeholder"><span /><span /><small>Getting to know you</small></div>}
              </div>
            </section>
            <section className="wm-pocket wm-pocket-today" data-active={stage === 3 || stage === 4 || recalling} data-filled={hasTrip}>
              <div className="wm-pocket-heading"><span><CalendarDays size={16} /></span><div><h3>Recent context</h3><span>From today</span></div></div>
              <div className="wm-pocket-thoughts">
                {hasTrip ? (
                  <div key="context"><MemoryThought fresh={stage === 4}>Boston trip</MemoryThought><MemoryThought fresh={stage === 4}>October 12–15</MemoryThought></div>
                ) : <div className="wm-thought-placeholder"><span /><span /><small>Details from your day</small></div>}
              </div>
            </section>
            <section className="wm-pocket wm-pocket-task" data-active={stage >= 3} data-filled={hasTrip}>
              <div className="wm-pocket-heading"><span><Compass size={16} /></span><div><h3>This trip</h3><span>Task details</span></div></div>
              <div className="wm-pocket-thoughts">
                {hasTrip ? (
                  <div key={hasUpdate ? "updated" : "budget"}>
                    <MemoryThought fresh={stage === 4 || stage === 6}><span className="wm-budget">{stage === 6 && <del>$1,800</del>}<strong>{hasUpdate ? "$2,200" : "$1,800"}</strong> budget</span></MemoryThought>
                    {hasUpdate && <MemoryThought fresh={stage === 6}>Flexible return</MemoryThought>}
                  </div>
                ) : <div className="wm-thought-placeholder"><span /><span /><small>What matters for this task</small></div>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
