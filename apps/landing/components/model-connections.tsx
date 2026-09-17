"use client";

import type { CSSProperties } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Brain, Folder, Server } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { ChatGPTLogo, ClaudeLogo } from "./model-provider-logos";
import { useDemoCycle } from "./use-demo-cycle";
import "./model-connections.css";

const providers = [
  {
    provider: "OpenAI", model: "GPT", icon: ChatGPTLogo,
    connection: "ChatGPT sign-in or API key", color: "#527c69", wash: "#edf5ef",
  },
  {
    provider: "Anthropic", model: "Claude", icon: ClaudeLogo,
    connection: "Claude sign-in or API key", color: "#b4785c", wash: "#faf0e9",
  },
  {
    provider: "Your endpoint", model: "Your model", icon: Server,
    connection: "Hosted or running locally", color: "#647fa0", wash: "#edf2f8",
  },
] as const;

const team = [
  { name: "Chief of staff", shape: "helmet", color: "#ff7a1a" },
  { name: "Travel planner", shape: "pod", color: "#925df2" },
  { name: "Finance manager", shape: "chip", color: "#27baae" },
] as const;

function InferenceConnection({ mobile = false }: { mobile?: boolean }) {
  const branches = mobile
    ? ["M50 0 C50 25 135 14 150 38", "M150 0 V38", "M250 0 C250 25 165 14 150 38"]
    : ["M0 36 C30 36 18 120 48 120", "M0 120 H48", "M0 204 C30 204 18 120 48 120"];
  const request = mobile ? "M150 38 C150 51 137 49 137 66 V130" : "M48 120 C66 120 62 102 80 102 H160";
  const response = mobile ? "M163 130 V66 C163 49 150 51 150 38" : "M160 140 H80 C62 140 66 120 48 120";
  return (
    <div className={`mc-link mc-link-${mobile ? "mobile" : "desktop"}`}>
      <svg viewBox={mobile ? "0 0 300 130" : "0 0 160 240"} preserveAspectRatio="none" aria-hidden="true">
        {branches.map((path) => <path className="mc-branch" d={path} key={path} />)}
        <path className="mc-route" d={request} />
        <path className="mc-route" d={response} />
        <path className="mc-request-packet" d={request} pathLength="100" />
        <path className="mc-response-packet" d={response} pathLength="100" />
        <circle className="mc-junction" cx={mobile ? 150 : 48} cy={mobile ? 38 : 120} r="3" />
      </svg>
      <span className="mc-request-label">Request {mobile ? <ArrowDown size={11} /> : <ArrowRight size={11} />}</span>
      <span className="mc-response-label">{mobile ? <ArrowUp size={11} /> : <ArrowLeft size={11} />} Response</span>
    </div>
  );
}

export function ModelConnections() {
  const cycle = useDemoCycle(providers.length, 6200);
  const selected = cycle.index % providers.length;
  const provider = providers[selected];

  return (
    <div
      className="mc-demo"
      ref={cycle.ref}
      {...cycle.props}
      style={{ ...cycle.props.style, "--mc-accent": provider.color, "--mc-wash": provider.wash } as CSSProperties}
      role="img"
      aria-label={`Your workers send requests to ${provider.model} through ${provider.provider} and receive responses. The model cycles automatically; your team, memory and workspace stay in place.`}
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
              <div className="mc-model-card" key={item.provider} data-active={index === selected}>
                <span className="mc-provider-name">{item.provider}</span>
                <span className="mc-model-mark"><item.icon size={42} /></span>
                <strong>{item.model}</strong>
                <span className="mc-model-connection">{item.connection}</span>
              </div>
            ))}
            <span className="mc-model-port mc-model-port-request" />
            <span className="mc-model-port mc-model-port-response" />
          </div>
          <div className="mc-model-options">
            {providers.map((item, index) => (
              <span key={item.provider} data-active={index === selected}><item.icon size={13} /></span>
            ))}
          </div>
        </div>
      </div>
      <div className="mc-continuity" aria-hidden="true">
        <span>Switch models. Keep your team.</span>
        <div><span><Brain size={14} />Memory</span><span><Folder size={14} />Workspace</span></div>
      </div>
    </div>
  );
}
