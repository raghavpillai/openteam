"use client";

import type { CSSProperties } from "react";
import { Cloud, Cpu, Server } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { ChatGPTLogo, ClaudeLogo } from "./model-provider-logos";
import { useDemoCycle } from "./use-demo-cycle";
import "./model-connections.css";

const providers = [
  {
    provider: "OpenAI", model: "GPT", icon: ChatGPTLogo,
    connection: "ChatGPT sign-in or API key", color: "#4e82d8", wash: "#edf3fe",
  },
  {
    provider: "Anthropic", model: "Claude", icon: ClaudeLogo,
    connection: "Claude sign-in or API key", color: "#d47b47", wash: "#fdf1e8",
  },
  {
    provider: "Hosted", model: "Cloud endpoint", icon: Cloud,
    connection: "Compatible third-party endpoints", color: "#8471bd", wash: "#f3effa",
  },
  {
    provider: "Self-hosted", model: "Local model", icon: Cpu,
    connection: "Running on your own compute", color: "#5b9378", wash: "#edf5ef",
  },
] as const;

const team = [
  { name: "Chief of staff", shape: "helmet", color: "#ff7a1a" },
  { name: "Travel planner", shape: "pod", color: "#925df2" },
  { name: "Finance manager", shape: "chip", color: "#27baae" },
] as const;

function InferenceConnection({ mobile = false }: { mobile?: boolean }) {
  // Each worker has one bidirectional connection. The two model lanes split
  // underneath the server card, so packets stay continuous through the server.
  const serverPoint = mobile ? "M150 68" : "M84 120";
  const toModel = mobile
    ? "C150 78 144 78 144 86 C144 104 138 104 138 122 V160"
    : "C96 120 94 114 106 114 C120 114 116 108 132 108 H200";
  const fromModel = mobile
    ? "M162 160 V122 C162 104 156 104 156 86 C156 78 150 78 150 68"
    : "M200 132 H132 C116 132 120 126 106 126 C94 126 96 120 84 120";
  const routes = (mobile ? [50, 150, 250] : [36, 120, 204]).map((position) => {
    const toServer = mobile
      ? `M${position} 0 C${position} 24 150 24 150 50 V68`
      : `M0 ${position} C30 ${position} 28 120 62 120 H84`;
    const toWorker = mobile
      ? `V50 C150 24 ${position} 24 ${position} 0`
      : `H62 C28 120 30 ${position} 0 ${position}`;
    return { worker: toServer, request: `${toServer} ${toModel}`, response: `${fromModel} ${toWorker}` };
  });
  return (
    <div className={`mc-link mc-link-${mobile ? "mobile" : "desktop"}`}>
      <svg viewBox={mobile ? "0 0 300 160" : "0 0 200 240"} preserveAspectRatio="none" aria-hidden="true">
        <path className="mc-route" d={`${serverPoint} ${toModel}`} />
        <path className="mc-route mc-return-route" d={fromModel} />
        {routes.map((route, index) => (
          <g key={index} style={{ "--mc-worker-delay": `${index * -1040}ms` } as CSSProperties}>
            <path className="mc-route" d={route.worker} />
            <path className="mc-request-packet" d={route.request} pathLength="100" />
            <path className="mc-response-packet" d={route.response} pathLength="100" />
          </g>
        ))}
      </svg>
      <div className="mc-server"><Server size={23} strokeWidth={1.5} /><span>Your server</span></div>
    </div>
  );
}

export function ModelConnections() {
  const cycle = useDemoCycle(providers.length, 1750);
  const selected = cycle.index % providers.length;
  const provider = providers[selected];

  return (
    <div
      className="mc-demo"
      ref={cycle.ref}
      {...cycle.props}
      style={{ ...cycle.props.style, "--mc-accent": provider.color, "--mc-wash": provider.wash } as CSSProperties}
      role="img"
      aria-label={`Each worker sends gray requests through your server to ${provider.model} (${provider.provider}). Responses return through the server in the provider’s color. The model cycles automatically.`}
    >
      <div className="mc-map" aria-hidden="true">
        <div className="mc-team">
          <h3>Your workers</h3>
          <div className="mc-workers">
            {team.map((worker) => (
              <div className="mc-worker" key={worker.name}>
                <BotAvatar shape={worker.shape} color={worker.color} size={30} mode="still" />
                <span>{worker.name}</span>
                <i className="mc-worker-port" />
              </div>
            ))}
          </div>
        </div>

        <InferenceConnection />
        <InferenceConnection mobile />

        <div className="mc-destination">
          <span className="mc-destination-label">Your choice of model</span>
          <div className="mc-model-stack">
            {providers.map((item, index) => (
              <div className="mc-model-card" key={item.provider} data-active={index === selected}
                style={{ "--mc-card-color": item.color, "--mc-card-wash": item.wash } as CSSProperties}>
                <span className="mc-provider-name">{item.provider}</span>
                <span className="mc-model-mark"><item.icon size={34} /></span>
                <strong>{item.model}</strong>
                <span className="mc-model-connection">{item.connection}</span>
              </div>
            ))}
            <span className="mc-model-port mc-model-port-request" />
            <span className="mc-model-port mc-model-port-response" />
          </div>
          <div className="mc-model-options">
            {providers.map((item, index) => (
              <span key={item.provider} data-active={index === selected} style={{ color: item.color }}><item.icon size={13} /></span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
