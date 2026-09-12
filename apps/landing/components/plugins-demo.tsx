"use client";

import Image from "next/image";
import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { BookOpen, Expand, Plug, ShieldCheck, X } from "lucide-react";
import { Button } from "./ui/button";
import "./plugins-demo.css";

const views = [
  {
    id: "browse",
    label: "Browse plugins",
    icon: Plug,
    src: "/screenshots/plugins-browse.png",
    alt: "OpenTeam's actual Plugins dialog showing the bundled plugin catalog",
    description: "Install app connectors and reusable skills from the plugin catalog.",
  },
  {
    id: "access",
    label: "Choose agent access",
    icon: ShieldCheck,
    src: "/screenshots/plugins-access.png",
    alt: "OpenTeam's actual GitHub plugin settings with separate access controls for each agent",
    description: "Connect an account, then choose which agents can use it.",
  },
  {
    id: "skills",
    label: "Add private skills",
    icon: BookOpen,
    src: "/screenshots/plugins-skills.png",
    alt: "OpenTeam's actual Private skills editor with research instructions and agent access settings",
    description: "Save your team's instructions as a skill and enable it for selected agents.",
  },
] as const;

// Native 3× PNG captures of the shipping desktop components with local sample
// data. The 1000 × 700 image dimensions below preserve their logical UI size.
// View selection and image enlargement belong to the landing page, outside the app.
export function PluginsDemo() {
  const [selected, setSelected] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const view = views[selected];
  return (
    <div className="pl-demo">
      <div className="pl-views" aria-label="Plugin screenshots">
        {views.map((item, index) => (
          <Button
            key={item.id}
            variant="ghost"
            aria-pressed={selected === index}
            aria-controls="plugin-screenshot"
            className="pl-view"
            onClick={() => setSelected(index)}
          >
            <item.icon size={16} />
            {item.label}
          </Button>
        ))}
      </div>
      <figure id="plugin-screenshot" className="pl-figure">
        <button
          type="button"
          className="pl-image-button"
          aria-label={`Expand screenshot: ${view.label}`}
          onClick={() => setExpanded(true)}
        >
          <Image src={view.src} width={1000} height={700} unoptimized alt={view.alt} />
        </button>
        <figcaption>
          <p aria-live="polite">{view.description}</p>
          <Button variant="ghost" className="pl-expand" onClick={() => setExpanded(true)}>
            <Expand size={14} /> Expand screenshot
          </Button>
        </figcaption>
      </figure>
      <p className="pl-disclosure">Actual desktop app · Sample accounts and settings</p>
      <Dialog.Root open={expanded} onOpenChange={setExpanded}>
        <Dialog.Portal>
          <Dialog.Backdrop className="pl-lightbox-backdrop" />
          <Dialog.Popup className="pl-lightbox">
            <header>
              <Dialog.Title>{view.label}</Dialog.Title>
              <Dialog.Close aria-label="Close plugin screenshot">
                <X size={20} />
              </Dialog.Close>
            </header>
            <Dialog.Description className="pl-lightbox-description">
              {view.description} Screenshot of the desktop app with sample data.
            </Dialog.Description>
            <p className="pl-pan-hint">Scroll to explore the full-size screenshot.</p>
            <div
              className="pl-lightbox-image"
              tabIndex={0}
              aria-label="Full-size plugin screenshot"
            >
              <Image src={view.src} width={1000} height={700} unoptimized alt={view.alt} />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
