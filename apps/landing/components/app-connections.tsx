"use client";

import Image from "next/image";
import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  Globe2,
  Mail,
  Plug,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import { PluginsDemo } from "./plugins-demo";
import "./connections-polish.css";

const connections = [
  {
    name: "Email",
    icon: Mail,
    color: "#e45546",
    label: "A conversation to pick up",
    file: "Introduction to Maya",
    type: "Email",
    text: "Alex introduced you to Maya at Acme. She wants to talk about vendor renewals.",
    detail: "Alex Chen · 2 messages",
    reply: "I found the introduction. I’ll bring the conversation into your meeting prep.",
  },
  {
    name: "Calendar",
    icon: CalendarDays,
    color: "#4285f4",
    label: "A meeting to prepare for",
    file: "Acme · Tomorrow, 10 AM",
    type: "Calendar",
    text: "Your intro call is confirmed. The invite includes the team and the meeting agenda.",
    detail: "Tomorrow · 10:00–10:30 AM",
    reply: "The call is on your calendar. I have the attendees and agenda to work from.",
  },
  {
    name: "Notion",
    logo: "/logos/notion.svg",
    icon: FileText,
    color: "#444",
    label: "The context behind the work",
    file: "Customer research",
    type: "Document",
    text: "Company notes, earlier research, and the questions you want to answer on the call.",
    detail: "Workspace / Customers / Acme",
    reply: "I’ve picked up the customer notes, including your open questions for Maya.",
  },
  {
    name: "Slack",
    logo: "/logos/slack.svg",
    icon: Mail,
    color: "#925df2",
    label: "What your team already knows",
    file: "#customer-notes",
    type: "Team conversation",
    text: "The sales team shared the latest customer context and a few things worth following up.",
    detail: "#customer-notes · 3 replies",
    reply: "Your team flagged the renewal timeline. I’ll include it in the briefing.",
  },
  {
    name: "Web search",
    icon: Globe2,
    color: "#27baae",
    label: "A wider view",
    file: "Acme company overview",
    type: "Web research",
    text: "A quick look at the company, its product, and recent news, with sources included.",
    detail: "Company website · Recent news",
    reply: "I checked the company background and saved the sources alongside your notes.",
  },
  {
    name: "Your tools",
    icon: Plug,
    color: "#e4a43d",
    label: "Your systems, connected",
    file: "Internal CRM",
    type: "Custom MCP connection",
    text: "Give workers the customer history and internal tools that matter to your business.",
    detail: "Acme / Account history",
    reply: "I can use your internal account history too, through the tools you connect.",
  },
] as const;

export function AppConnections({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const cycle = useDemoCycle(connections.length, 6000, !expanded);
  const active = connections[cycle.index];
  return (
    <div className="ws-app-scene ws-ui" ref={cycle.ref} {...cycle.props}>
      <div className="ws-app-orbit">
        <svg
          className="ws-connection-lines"
          viewBox="0 0 1100 570"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {[
            "M130 90 C330 90 300 410 550 430",
            "M90 265 C330 265 320 430 550 430",
            "M145 445 C330 445 380 430 550 430",
            "M970 90 C770 90 800 410 550 430",
            "M1010 265 C770 265 780 430 550 430",
            "M955 445 C770 445 720 430 550 430",
          ].map((path, index) => (
            <g
              key={path}
              data-active={index === cycle.index}
              style={{ "--source-color": connections[index].color } as React.CSSProperties}
            >
              <path d={path} pathLength={100} />
              <path className="ws-connection-packet" d={path} pathLength={100} />
            </g>
          ))}
        </svg>
        <div className="ws-app-intro">
          {children}
          <div className="ws-app-worker">
            <BotAvatar
              shape="helmet"
              color="#ff7a1a"
              size={54}
              mode={cycle.playing ? "thinking" : "still"}
            />
            <span className="ws-app-worker-label">
              <strong>Chief of staff</strong>
              <small key={active.name}>
                Reading {active.name.toLowerCase()}
                <i />
              </small>
            </span>
          </div>
        </div>
        {connections.map((connection, index) => (
          <button
            key={connection.name}
            type="button"
            className={`ws-app-node ws-app-node-${index}`}
            aria-pressed={cycle.index === index}
            aria-controls="connected-context"
            onClick={() => cycle.select(index)}
            style={{ "--app-color": connection.color } as React.CSSProperties}
          >
            <span className="ws-app-symbol">
              {"logo" in connection ? (
                <Image src={connection.logo} alt="" width={30} height={30} unoptimized />
              ) : (
                <connection.icon size={29} strokeWidth={1.6} />
              )}
            </span>
            <strong>{connection.name}</strong>
            <span className="ws-app-node-state">
              {cycle.index === index ? (
                <>
                  <Check size={11} />
                  Reading context
                </>
              ) : (
                "Connected"
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="ws-context-feed" id="connected-context">
        <div className="ws-context-feed-header">
          <span>
            <ArrowDownLeft size={15} /> Context for your team
          </span>
          <span className="ws-feed-count">
            {String(cycle.index + 1).padStart(2, "0")} <span>/ 06</span>
          </span>
        </div>
        <div
          className="ws-context-strip"
          key={`${active.file}-${cycle.revision}`}
          style={{ "--source-color": active.color } as React.CSSProperties}
        >
          <div className="ws-context-source">
            <div className="ws-context-file">
              <span>
                <active.icon size={20} />
              </span>
              <div>
                <small>{active.type}</small>
                <strong>{active.file}</strong>
              </div>
            </div>
            <p className="ws-context-detail">{active.detail}</p>
            <p className="ws-context-source-text">{active.text}</p>
          </div>
          <div className="ws-context-route" aria-hidden="true">
            <ChevronRight size={17} />
            <i />
          </div>
          <div className="ws-context-received">
            <div className="ws-context-recipient">
              <BotAvatar
                shape="helmet"
                color="#ff7a1a"
                size={23}
                mode={cycle.playing ? "idle" : "still"}
              />
              <strong>Chief of staff</strong>
              <span>
                <Check size={12} /> Context added
              </span>
            </div>
            <p>{active.reply}</p>
            <div className="ws-context-source-link">
              <active.icon size={12} />
              <span>{active.file}</span>
            </div>
          </div>
          <div className="ws-context-progress" aria-hidden="true">
            <i />
          </div>
        </div>
      </div>
      <div className="ws-app-footer">
        <div>
          <BookOpen size={16} />
          <span>Save the way you work as a reusable skill.</span>
        </div>
        <button type="button" onClick={() => setExpanded(true)}>
          Explore plugins &amp; skills <ArrowUpRight size={16} />
        </button>
      </div>
      <Dialog.Root open={expanded} onOpenChange={setExpanded}>
        <Dialog.Portal>
          <Dialog.Backdrop className="twd-preview-backdrop" />
          <Dialog.Popup className="ws-catalog-dialog">
            <header>
              <Dialog.Title>Plugins &amp; skills</Dialog.Title>
              <Dialog.Close aria-label="Close plugin catalog">
                <X size={20} />
              </Dialog.Close>
            </header>
            <Dialog.Description className="ws-sr-only">
              Browse the plugin catalog, worker access, and reusable skills in the desktop app.
            </Dialog.Description>
            <PluginsDemo />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
