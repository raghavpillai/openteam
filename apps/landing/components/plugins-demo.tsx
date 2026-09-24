"use client";

import Image from "next/image";
import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { BookOpen, Expand, ShieldCheck, X } from "lucide-react";
import { Button } from "./ui/button";
import { useDemoCycle } from "./use-demo-cycle";
import "./plugins-demo.css";

const views = [
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
    label: "Reusable skills",
    icon: BookOpen,
    src: "/screenshots/plugins-skills.png",
    alt: "Desktop app preview of reusable research instructions in the private skills editor",
    description: "Save your team's instructions and supporting files as a reusable skill.",
  },
] as const;

// Native 3× PNG captures of desktop preview components with local sample
// data. The 1000 × 700 image dimensions below preserve their logical UI size.
// View selection and image enlargement belong to the landing page, outside the app.
export function PluginsDemo() {
  const [direction, setDirection] = useState("forward");
  const [expanded, setExpanded] = useState(false);
  const cycle = useDemoCycle(views.length, 6500, !expanded);
  const selected = cycle.index;
  const previous = (selected + views.length - 1) % views.length;
  const view = views[selected];
  return (
    <div className="pl-demo" data-direction={direction} ref={cycle.ref} {...cycle.props}>
      <div className="pl-views" aria-label="Plugin screenshots">
        <span className="pl-selection" style={{ "--selection": selected } as React.CSSProperties} aria-hidden="true" />
        {views.map((item, index) => (
          <Button
            key={item.id}
            variant="ghost"
            aria-pressed={selected === index}
            aria-controls="plugin-screenshot"
            className="pl-view"
            onClick={() => {
              if (index === selected) return;
              setDirection(index > selected ? "forward" : "backward");
              cycle.select(index);
            }}
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
          {views.map((item, index) => (
            <Image key={item.id} className="pl-slide" data-active={selected === index ? "" : undefined} data-previous={previous === index ? "" : undefined}
              src={item.src} width={1000} height={700} unoptimized
              alt={selected === index ? item.alt : ""} aria-hidden={selected !== index} />
          ))}
          <span className="pl-image-expand" aria-hidden="true"><Expand size={15} /></span>
        </button>
      </figure>
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
