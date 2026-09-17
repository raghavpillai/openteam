import { Container, MemoryStick } from "lucide-react";
import { InstallCommand } from "./install-command";
import "./install-card.css";

const steps = [
  ["Install your server", "Run the command on your computer or personal cloud. Setup walks you through the rest."],
  ["Connect a model", "Sign in with ChatGPT or Claude, add an API key, or use your own endpoint."],
  [
    "Meet your first worker",
    "Connect the desktop app to your server. Give your first worker a role and a job to do.",
  ],
] as const;

export function InstallCard() {
  return (
    <div className="ot-install-card">
      <InstallCommand />
      <ol className="ot-install-steps" aria-label="Set up OpenTeam">
        {steps.map(([title, description], index) => (
          <li key={title}>
            <span className="ot-install-step-number" aria-hidden="true">
              {`0${index + 1}`}
            </span>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="ot-install-requirements" aria-label="Server requirements">
        <span>
          <Container size={15} aria-hidden="true" /> Docker Compose 2.20+
        </span>
        <span>
          <MemoryStick size={15} aria-hidden="true" /> 8 GB RAM recommended
        </span>
      </div>
    </div>
  );
}
