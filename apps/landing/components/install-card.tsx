import { Container, MemoryStick } from "lucide-react";
import { InstallCommand } from "./install-command";
import "./install-card.css";

const steps = [
  ["Install the server", "Run guided setup on the machine that will host your agents."],
  ["Connect your model", "Sign in, add an API key, or connect a compatible endpoint."],
  ["Create your first agent", "Enter your server URL in the desktop app, sign in, and create an agent."],
] as const;

export function InstallCard() {
  return (
    <div className="ot-install-card">
      <InstallCommand />
      <ol className="ot-install-steps" aria-label="Set up OpenTeam">
        {steps.map(([title, description], index) => (
          <li key={title}>
            <span className="ot-install-step-number" aria-hidden="true">0{index + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="ot-install-requirements" aria-label="Server requirements">
        <span><Container size={15} aria-hidden="true" /> Docker Compose 2.20+</span>
        <span><MemoryStick size={15} aria-hidden="true" /> 8 GB RAM recommended</span>
      </div>
    </div>
  );
}
