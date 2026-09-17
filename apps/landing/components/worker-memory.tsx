"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Brain, CalendarDays, Check, Compass, Sparkles } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./worker-memory.css";

// Human-readable groupings illustrate relevance, not separate storage systems.
const conversations = [
  {
    when: "Last week",
    message: <>Keep my updates <mark>short</mark>. Lead with <mark>decisions I need to make</mark>.</>,
    reply: "I’ll put your decisions first and keep the background brief.",
  },
  {
    when: "Monday",
    message: <><mark>Maya owns Acme’s pilot</mark>. We’re aiming for <mark>Friday</mark>, pending security review.</>,
    reply: "Acme pilot: Maya owns it, Friday is the target, and security is still open.",
  },
  {
    when: "Today",
    message: <>Acme moved to <mark>Monday</mark>. <mark>Security is cleared</mark>; they’re waiting on my go-ahead.</>,
    reply: "Updated: Monday kickoff, security cleared, and your go-ahead is next.",
  },
  {
    when: "A new conversation",
    message: <>Catch me up on <mark>Acme</mark>.</>,
    reply: <><strong>Your decision:</strong> Give Maya the go-ahead for Monday’s kickoff.<br /><strong>Context:</strong> Acme’s security review is cleared.</>,
  },
];
const stages = [
  "Noticing what matters", "Remembering your preferences", "Preferences remembered",
  "Connecting people and projects", "Project context remembered", "Updating what’s changed",
  "Latest plan remembered", "Bringing it back to mind", "Remembered for this conversation",
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
  const hasProject = stage >= 4;
  const hasUpdate = stage >= 6;

  return (
    <div className="wm-scene ws-ui" ref={ref} {...props} data-stage={stage}>
      <div className="wm-intro">{children}</div>
      <div className="wm-studio">
        <div className="wm-conversation">
          <header className="wm-chat-header">
            <BotAvatar shape="helmet" color="#ff7a1a" size={28} mode={playing && !saved ? "thinking" : "idle"} />
            <strong>Chief of staff</strong>
            <span key={conversationIndex}>{conversation.when}</span>
          </header>
          <div className="wm-exchange" key={conversationIndex}>
            <div className="wm-user-message" data-extracting={!saved && !recalling}>{conversation.message}</div>
            <div className="wm-worker-message">
              <BotAvatar shape="helmet" color="#ff7a1a" size={22} mode={playing && !saved ? "thinking" : "idle"} />
              {saved ? (
                <div className="wm-worker-answer" key={stage}>
                  {recalling && <span className="wm-recall-label"><Sparkles size={12} /> From your memory</span>}
                  <p>{conversation.reply}</p>
                </div>
              ) : (
                <span className="wm-typing" aria-label="Chief of staff is thinking"><i /><i /><i /></span>
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
              <strong>Chief of staff’s memory</strong>
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
                  <div key="preferences"><MemoryThought fresh={stage === 2}>Decisions first</MemoryThought><MemoryThought fresh={stage === 2}>Short updates</MemoryThought></div>
                ) : <div className="wm-thought-placeholder"><span /><span /><small>Getting to know you</small></div>}
              </div>
            </section>
            <section className="wm-pocket wm-pocket-today" data-active={stage === 3 || stage === 4 || recalling} data-filled={hasProject}>
              <div className="wm-pocket-heading"><span><CalendarDays size={16} /></span><div><h3>Recent context</h3><span>People &amp; projects</span></div></div>
              <div className="wm-pocket-thoughts">
                {hasProject ? (
                  <div key="context"><MemoryThought fresh={stage === 4}>Acme pilot</MemoryThought><MemoryThought fresh={stage === 4}>Maya · owner</MemoryThought></div>
                ) : <div className="wm-thought-placeholder"><span /><span /><small>Details from your day</small></div>}
              </div>
            </section>
            <section className="wm-pocket wm-pocket-task" data-active={stage >= 3} data-filled={hasProject}>
              <div className="wm-pocket-heading"><span><Compass size={16} /></span><div><h3>Next milestone</h3><span>Acme kickoff</span></div></div>
              <div className="wm-pocket-thoughts">
                {hasProject ? (
                  <div key={hasUpdate ? "updated" : "milestone"}>
                    <MemoryThought fresh={stage === 4 || stage === 6}><span className="wm-revision">{stage === 6 && <del>Friday</del>}<strong>{hasUpdate ? "Monday" : "Friday"}</strong> kickoff</span></MemoryThought>
                    <MemoryThought fresh={stage === 4 || stage === 6}>{hasUpdate ? "Security cleared" : "Security pending"}</MemoryThought>
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
