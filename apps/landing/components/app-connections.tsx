"use client";

import Image from "next/image";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  FileText,
  Globe2,
  Mail,
  Plug,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./connections-polish.css";

const connections = [
  {
    name: "Email",
    logo: "/logos/gmail.png",
    icon: Mail,
    color: "#e45546",
    action: "Reading the introduction email",
  },
  {
    name: "Calendar",
    logo: "/logos/google-calendar.png",
    icon: CalendarDays,
    color: "#4285f4",
    action: "Checking the meeting invite",
  },
  {
    name: "Notion",
    logo: "/logos/notion.svg",
    icon: FileText,
    color: "#444",
    action: "Reviewing your customer notes",
  },
  {
    name: "Slack",
    logo: "/logos/slack.svg",
    icon: Mail,
    color: "#925df2",
    action: "Reading the team’s renewal thread",
  },
  { name: "Web search", icon: Globe2, color: "#27baae", action: "Checking Meridian’s latest updates" },
  {
    name: "Your tools",
    icon: Plug,
    color: "#d5982e",
    action: "Finding the last proposal in your CRM",
  },
] as const;

const brief = [
  {
    label: "Who you’re meeting",
    text: "Maya Patel · Finance lead, Meridian",
    detail: "Tomorrow, 10:00 AM · 30 minutes",
    sources: [0, 1],
  },
  {
    label: "What to discuss",
    text: "Consolidating vendors before the September renewal.",
    sources: [2, 3],
  },
  {
    label: "What to review",
    text: "Your last proposal and Meridian’s finance hiring update.",
    sources: [4, 5],
  },
] as const;

const desktopPaths = [
  "M75 100 C230 100 230 290 550 290",
  "M75 300 L550 290",
  "M75 500 C230 500 230 290 550 290",
  "M1025 100 C870 100 870 290 550 290",
  "M1025 300 L550 290",
  "M1025 500 C870 500 870 290 550 290",
];
const mobilePaths = [
  "M60 50 C60 135 15 155 180 240",
  "M180 50 L180 240",
  "M300 50 C300 135 345 155 180 240",
  "M60 132 C60 210 120 220 180 240",
  "M180 132 L180 240",
  "M300 132 C300 210 240 220 180 240",
];

function ConnectionMark({
  connection,
  size = 28,
}: {
  connection: (typeof connections)[number];
  size?: number;
}) {
  return "logo" in connection ? (
    <Image src={connection.logo} alt="" width={size} height={size} unoptimized />
  ) : (
    <connection.icon size={size} strokeWidth={1.6} aria-hidden="true" />
  );
}

function ConnectionLines({
  activeIndices,
  mobile = false,
}: {
  activeIndices: readonly number[];
  mobile?: boolean;
}) {
  return (
    <svg
      className={`ac-lines ${mobile ? "ac-lines-mobile" : "ac-lines-desktop"}`}
      viewBox={mobile ? "0 0 360 250" : "0 0 1100 600"}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {(mobile ? mobilePaths : desktopPaths).map((path, index) => (
        <g
          key={path}
          data-active={activeIndices.includes(index)}
          style={{ "--source-color": connections[index].color } as CSSProperties}
        >
          <path d={path} pathLength={100} />
          <path className="ac-packet" d={path} pathLength={100} />
        </g>
      ))}
    </svg>
  );
}

function pickSources(sources: number[], count: number) {
  const remaining = [...sources];
  const selected: number[] = [];
  while (remaining.length && selected.length < count) {
    const index = Math.floor(Math.random() * remaining.length);
    selected.push(...remaining.splice(index, 1));
  }
  return selected;
}

function BriefText({ text }: { text: string }) {
  return text.split(" ").map((word, index) => (
    <span className="ac-reveal-word" key={`${index}-${word}`} style={{ "--word-index": index } as CSSProperties}>
      {word}{" "}
    </span>
  ));
}

/** Sources finish independently; answers appear only after their sources arrive. */
function useConnectionActivity(playing: boolean) {
  const [activity, setActivity] = useState({ active: [] as number[], completed: [] as number[], resetting: false });
  useEffect(() => {
    if (!playing) return;
    const done = activity.completed.length === connections.length;
    const starting = activity.active.length === 0;
    const delay = activity.resetting ? 700 : done ? 5200 : starting ? 100 : 950 + Math.random() * 850;
    const timer = window.setTimeout(() => {
      if (done && !activity.resetting) {
        setActivity({ ...activity, resetting: true });
        return;
      }
      if (activity.resetting || starting) {
        setActivity({ active: pickSources(connections.map((_, index) => index), 2), completed: [], resetting: false });
        return;
      }
      const [finished] = pickSources(activity.active, 1);
      const completed = [...activity.completed, finished];
      const active = activity.active.filter((index) => index !== finished);
      const pending = connections.map((_, index) => index)
        .filter((index) => !completed.includes(index) && !active.includes(index));
      setActivity({ active: [...active, ...pickSources(pending, 2 - active.length)], completed, resetting: false });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activity, playing]);
  return activity;
}

export function AppConnections({ children }: { children: ReactNode }) {
  const { ref, playing, props } = useDemoCycle(1, 60_000);
  const { active, completed, resetting } = useConnectionActivity(playing);
  const done = completed.length === connections.length;

  return (
    <div className="ac-section ws-ui" ref={ref} {...props}>
      <div className="ac-intro">
        {children}
        <a className="ac-catalog-link" href="/docs/usage/plugins">
          Browse plugins &amp; skills <ArrowUpRight size={16} />
        </a>
      </div>

      <div className="ac-workflow" data-resetting={resetting}>
        <ConnectionLines activeIndices={active} />
        <ConnectionLines activeIndices={active} mobile />
        {connections.map((connection, index) => (
          <div
            className={`ac-app ac-app-${index}`}
            key={connection.name}
            data-active={active.includes(index)}
            data-used={completed.includes(index)}
            style={{ "--app-color": connection.color } as CSSProperties}
          >
            <span className="ac-app-logo">
              <ConnectionMark connection={connection} />
            </span>
            <strong>{connection.name}</strong>
            <span className="ac-app-status" data-state={completed.includes(index) ? "used" : active.includes(index) ? "reading" : "idle"}>
              <span className="ac-status-idle" aria-hidden={completed.includes(index) || active.includes(index)}>{index === 5 ? "Custom MCP" : "Connected"}</span>
              <span className="ac-status-reading" aria-hidden={!active.includes(index)}><i className="ac-reading-light" /> Reading…</span>
              <span className="ac-status-used" aria-hidden={!completed.includes(index)}><Check size={11} /> Used in brief</span>
            </span>
          </div>
        ))}

        <article
          className="ac-conversation"
          aria-label="Chief of staff prepares a meeting brief using connected apps"
        >
          <header className="ac-chat-header">
            <BotAvatar
              shape="helmet"
              color="#ff7a1a"
              size={32}
              mode={playing && !done ? "thinking" : "idle"}
            />
            <strong>Chief of staff</strong>
            <span data-done={done}>
              <span className="ac-run-working" aria-hidden={done}><i /> Working</span>
              <span className="ac-run-ready" aria-hidden={!done}><Check size={12} /> Ready</span>
            </span>
          </header>
          <div className="ac-chat-body">
            <div className="ac-request">Prep me for my call with Maya at Meridian.</div>
            <div className="ac-skill-run">
              <span className="ac-skill-icon">
                <BookOpen size={18} />
              </span>
              <div>
                <div className="ac-skill-name">
                  <strong>Meeting prep</strong>
                  <span>Reusable skill</span>
                </div>
                <div className="ac-current-source">
                  <span className="ac-source-read" data-visible={done} aria-hidden={!done}>
                    <Check size={13} /><span>Brief ready, with sources attached</span>
                  </span>
                  {connections.map((connection, index) => (
                    <span
                      className="ac-source-read"
                      key={connection.name}
                      data-visible={active.includes(index)}
                      aria-hidden={!active.includes(index)}
                      style={{ "--source-slot": Math.max(0, active.indexOf(index)) } as CSSProperties}
                    >
                      <ConnectionMark connection={connection} size={13} />
                      <span>{connection.action}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="ac-brief" aria-label="Meridian meeting brief">
              <div className="ac-brief-header">
                <FileText size={16} />
                <strong>meridian-call-brief.md</strong>
                <span className="ac-file-state" data-done={done}>
                  <span className="ac-run-working" aria-hidden={done}>Writing…</span>
                  <span className="ac-run-ready" aria-hidden={!done}>Saved</span>
                </span>
              </div>
              {brief.map((point) => {
                const ready = point.sources.every((index) => completed.includes(index));
                return (
                  <div
                    className="ac-brief-point"
                    key={point.label}
                    data-ready={ready}
                    data-active={point.sources.some((index) => active.includes(index))}
                  >
                    <div className="ac-brief-point-heading">
                      <span className="ac-brief-label">{point.label}</span>
                      <div
                        className="ac-citations"
                        aria-hidden={!ready}
                        aria-label={`Sources: ${point.sources.map((index) => connections[index].name).join(" and ")}`}
                      >
                          {point.sources.map((index) => (
                            <span
                              key={index}
                              data-active={active.includes(index)}
                              title={connections[index].name}
                            >
                              <ConnectionMark connection={connections[index]} size={12} />
                              <span className="ac-citation-name">{connections[index].name}</span>
                            </span>
                          ))}
                      </div>
                    </div>
                    <div className="ac-brief-point-body">
                      <div className="ac-brief-answer" aria-hidden={!ready}>
                        <strong><BriefText text={point.text} /></strong>
                        {"detail" in point && <p><BriefText text={point.detail} /></p>}
                      </div>
                      <div
                        className="ac-brief-pending"
                        aria-hidden={ready}
                        aria-label={`Gathering ${point.label.toLowerCase()}`}
                      >
                        <i />
                        <i />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
