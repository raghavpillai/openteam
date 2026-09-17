"use client";

import type { CSSProperties } from "react";
import { Check, Folder, KeyRound, LoaderCircle, MemoryStick, Server } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { ChatGPTLogo, ClaudeLogo } from "./model-provider-logos";
import { useDemoCycle } from "./use-demo-cycle";
import "./model-connections.css";

const connections = [
  {
    name: "ChatGPT", icon: ChatGPTLogo, model: "GPT-5.6", modelIcon: ChatGPTLogo,
    source: "ChatGPT account", color: "#427d68", wash: "#edf5f1",
    detail: "Use your ChatGPT account to power your workers.",
  },
  {
    name: "Claude", icon: ClaudeLogo, model: "Claude Sonnet", modelIcon: ClaudeLogo,
    source: "Claude account", color: "#b86d50", wash: "#faf0eb",
    detail: "Use your Claude account. Paid extra usage applies.",
  },
  {
    name: "API key", icon: KeyRound, model: "Claude Opus", modelIcon: ClaudeLogo,
    source: "Your API key", color: "#7c6bb2", wash: "#f2eff9",
    detail: "Connect an OpenAI or Anthropic API key.",
  },
  {
    name: "Endpoint", icon: Server, model: "Local model", modelIcon: Server,
    source: "Your endpoint", color: "#527d9d", wash: "#edf3f9",
    detail: "Use a compatible model on your machine or in the cloud.",
  },
] as const;

const team = [
  { name: "Chief of staff", shape: "helmet", color: "#ff7a1a" },
  { name: "Travel planner", shape: "pod", color: "#925df2" },
  { name: "Finance manager", shape: "chip", color: "#27baae" },
] as const;

export function ModelConnections() {
  const cycle = useDemoCycle(connections.length * 2, [800, 3200]);
  const selected = Math.floor(cycle.index / 2);
  const changing = cycle.index % 2 === 0;
  const connection = connections[selected];
  const workerConnection = connections[changing ? (selected + connections.length - 1) % connections.length : selected];

  return (
    <div
      className="mc-demo"
      ref={cycle.ref}
      {...cycle.props}
      data-changing={changing}
      style={{ ...cycle.props.style, "--mc-accent": connection.color, "--mc-wash": connection.wash } as CSSProperties}
      role="img"
      aria-label={`Automatic model connection demo. ${connection.model} through ${connection.source}. Your workers keep their memory and shared workspace when the model changes.`}
    >
      <div className="mc-providers" aria-hidden="true">
        {connections.map((item, index) => (
          <div className="mc-provider" data-active={index === selected} key={item.name}>
            <item.icon size={24} />
            <span>{item.name}</span>
            {index === selected && <i />}
          </div>
        ))}
      </div>

      <div className="mc-stage" aria-hidden="true">
        <div className="mc-model">
          <div className="mc-model-heading">
            <span>Team model</span>
            <span className="mc-connection-state">
              {changing ? <LoaderCircle size={13} /> : <Check size={13} />}
              {changing ? "Switching" : "Connected"}
            </span>
          </div>
          <div className="mc-model-identity" key={connection.name}>
            <div className="mc-model-logo"><connection.modelIcon size={36} /></div>
            <div className="mc-model-name">
              <h3>{connection.model}</h3>
              <span><connection.icon size={14} />{connection.source}</span>
            </div>
          </div>
          <p key={`${connection.name}-detail`} className="mc-connection-detail">{connection.detail}</p>
        </div>

        <div className="mc-distribution">
          <span className="mc-trunk"><i /></span>
          <div className="mc-workers">
            {team.map((worker, index) => (
              <div className="mc-worker" key={worker.name} style={{ "--mc-worker-order": index } as CSSProperties}>
                <span className="mc-worker-branch"><i /></span>
                <BotAvatar shape={worker.shape} color={worker.color} size={32} mode={changing ? "thinking" : "idle"} />
                <span className="mc-worker-name">{worker.name}</span>
                <span className="mc-worker-model" key={workerConnection.name}>
                  <workerConnection.modelIcon size={12} />
                  {workerConnection.model}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mc-continuity" aria-hidden="true">
        <span>Change models. Keep your team.</span>
        <div><span><MemoryStick size={14} />Memory</span><span><Folder size={14} />Workspace</span></div>
      </div>
    </div>
  );
}
