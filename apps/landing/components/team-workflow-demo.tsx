"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ChevronsRight, FileText, Info, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotAvatar } from "./bot-avatar";
import { DesktopMicIcon, DesktopPlusIcon } from "./desktop-demo-controls";
import "./team-workflow-demo.css";

const members = [
  { name: "Research", shape: "helmet", color: "#ff7a1a" },
  { name: "Engineering", shape: "chip", color: "#27baae" },
] as const;

const files = {
  brief: {
    name: "signup-brief.md",
    title: "Make password requirements clear",
    path: "/workspace/shared/signup-brief.md",
    content: [
      {
        heading: "What customers are reporting",
        body: "The signup form explains its password rules only after someone submits an invalid password. People have to guess what to change and try again.",
      },
      {
        heading: "Recommended change",
        body: "Show the password requirements beside the field. Update each requirement as the person types, and preserve their other form inputs if validation fails.",
      },
      {
        heading: "Handoff to Engineering",
        body: "Check the existing signup validation and propose the smallest change that makes the requirements visible before submission. Include tests for each requirement.",
      },
    ],
  },
  plan: {
    name: "signup-plan.md",
    title: "Signup validation plan",
    path: "/workspace/shared/signup-plan.md",
    content: [
      {
        heading: "Based on the shared brief",
        body: "Research identified unclear password requirements in signup feedback. This plan uses signup-brief.md and the sample signup form to define the change.",
      },
      {
        heading: "Implementation",
        body: "Reuse the existing password validation rules in a checklist below the field. Mark each rule as satisfied while the person types. Preserve the email field when submission fails.",
      },
      {
        heading: "Validation",
        body: "Cover empty input, each unmet requirement, and a valid password. Check that feedback remains accessible to screen readers and that an unsuccessful submission preserves the form.",
      },
    ],
  },
};

type SampleFile = keyof typeof files;

// The final reply finishes its 220ms entrance before the next loop.
const stageDurations = [1800, 1100, 2100, 400] as const;
const stageDescriptions = [
  "Research is reviewing the customer feedback.",
  "Research saved the brief to the shared workspace.",
  "Engineering is reading the brief and planning the fix.",
  "Handoff complete. Both sample files are ready to open.",
];

function TypingIndicator({ member, active }: { member: (typeof members)[number]; active: boolean }) {
  return (
    <div className="twd-typing-row" aria-hidden="true">
      <BotAvatar shape={member.shape} color={member.color} size={22} mode={active ? "thinking" : "still"} />
      <span className="twd-typing-bubble">
        <i /><i /><i />
      </span>
    </div>
  );
}

function GroupAvatar() {
  return (
    <span className="twd-group-avatar" aria-hidden="true">
      {members.map((member) => (
        <span key={member.name}>
          <BotAvatar shape={member.shape} color={member.color} size={16} mode="still" />
        </span>
      ))}
    </span>
  );
}

function FileAttachment({
  file,
  onOpen,
}: {
  file: SampleFile;
  onOpen: (file: SampleFile) => void;
}) {
  return (
    <button
      type="button"
      className="twd-file"
      onClick={() => onOpen(file)}
      aria-label={`Preview sample ${files[file].name}`}
    >
      <span className="twd-file-icon" aria-hidden="true">
        <FileText size={17} strokeWidth={1.65} />
      </span>
      <span>
        <strong>{files[file].name}</strong>
        <small>Markdown document</small>
      </span>
    </button>
  );
}

/**
 * A cropped desktop group conversation, with illustrative messages and files.
 * The header, agent labels/gutters, bubbles, member list, and composer follow
 * DesktopHeader, ChatPane, Inspector, and PromptInput in the desktop renderer.
 */
export function TeamWorkflowDemo() {
  const [preview, setPreview] = useState<SampleFile | null>(null);
  const [stage, setStage] = useState(0);
  const [fileFocused, setFileFocused] = useState(false);
  const [reading, setReading] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [visible, setVisible] = useState(false);
  const showcase = useRef<HTMLElement>(null);
  const started = useRef(false);
  const remaining = useRef<{ stage: number; duration: number } | null>(null);
  const readingTimer = useRef<number | null>(null);
  const pointerHeld = useRef(false);
  const document = preview ? files[preview] : null;
  const playing = motionAllowed && visible && preview === null;
  const shownStage = stage;

  const resumeAfterReading = useCallback(() => {
    if (readingTimer.current !== null) window.clearTimeout(readingTimer.current);
    readingTimer.current = window.setTimeout(() => {
      readingTimer.current = null;
      setReading(false);
    }, 500);
  }, []);
  const holdForReading = useCallback(() => {
    setReading(true);
    if (readingTimer.current !== null) window.clearTimeout(readingTimer.current);
    readingTimer.current = null;
    if (!pointerHeld.current) resumeAfterReading();
  }, [resumeAfterReading]);
  useEffect(() => {
    const release = () => {
      if (!pointerHeld.current) return;
      pointerHeld.current = false;
      resumeAfterReading();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      if (readingTimer.current !== null) window.clearTimeout(readingTimer.current);
    };
  }, [resumeAfterReading]);

  useEffect(() => {
    const element = showcase.current;
    if (!element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inView = false;
    const sync = () => {
      const allowed = !preference.matches;
      const onScreen = inView && !window.document.hidden;
      setMotionAllowed(allowed);
      setVisible(onScreen);
      if (allowed && onScreen && !started.current) {
        started.current = true;
        remaining.current = null;
        setStage(0);
      }
      if (!allowed) setStage(3);
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.3);
      sync();
    }, { threshold: 0.3 });
    sync();
    observer.observe(element);
    preference.addEventListener("change", sync);
    window.document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", sync);
      window.document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const duration = remaining.current?.stage === stage
      ? remaining.current.duration
      : stageDurations[stage];
    const began = performance.now();
    let advanced = false;
    const timeout = window.setTimeout(() => {
      // Reading can hold the reset, without stopping a reply mid-animation.
      if (stage === 3 && (reading || fileFocused || pointerHeld.current || readingTimer.current !== null)) {
        remaining.current = { stage, duration: 0 };
        return;
      }
      advanced = true;
      remaining.current = null;
      setStage((current) => (current + 1) % stageDurations.length);
    }, duration);
    return () => {
      window.clearTimeout(timeout);
      if (!advanced) {
        remaining.current = { stage, duration: Math.max(0, duration - (performance.now() - began)) };
      }
    };
  }, [fileFocused, playing, reading, stage]);

  return (
    <figure
      className="twd-showcase"
      ref={showcase}
      data-playing={playing}
      data-motion-enabled={motionAllowed}
      data-workflow-stage={stage}
      onFocusCapture={(event) => setFileFocused(event.target.matches(":focus-visible"))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFileFocused(false);
      }}
    >
      <div className="twd-app">
        <section className="twd-chat" aria-label="Signup improvements sample group conversation">
          <header className="twd-header">
            <GroupAvatar />
            <strong>Signup improvements</strong>
            <span className="twd-info" aria-hidden="true">
              <Info size={16} />
            </span>
          </header>

          <div className="twd-transcript" onScroll={holdForReading} onPointerDown={(event) => {
            if (event.button !== 0) return;
            pointerHeld.current = true;
            holdForReading();
          }}>
            <p className="twd-date">Today 9:41 AM</p>
            <div className="twd-message twd-user" aria-label="Message from you">
              <p className="twd-bubble">
                Review the customer feedback and propose a fix for the signup flow.
              </p>
            </div>

            <div className="twd-message" aria-label="Message from Research" data-revealed={shownStage >= 1}>
              {shownStage === 0 && <TypingIndicator member={members[0]} active={playing} />}
              <span className="twd-sender">Research</span>
              <div className="twd-agent-row" aria-hidden={shownStage < 1} inert={shownStage < 1}>
                <BotAvatar
                  shape={members[0].shape}
                  color={members[0].color}
                  size={22}
                  mode={playing ? "idle" : "still"}
                />
                <div className="twd-message-content">
                  <FileAttachment file="brief" onOpen={setPreview} />
                  <p className="twd-bubble">
                    The feedback points to unclear password rules. I saved the brief in our shared
                    workspace. Engineering, can you review the signup code and plan the fix?
                  </p>
                </div>
              </div>
            </div>

            <div className="twd-message" aria-label="Message from Engineering" data-revealed={shownStage >= 3} data-pending={shownStage < 2}>
              {shownStage === 2 && <TypingIndicator member={members[1]} active={playing} />}
              <span className="twd-sender">Engineering</span>
              <div className="twd-agent-row" aria-hidden={shownStage < 3} inert={shownStage < 3}>
                <BotAvatar
                  shape={members[1].shape}
                  color={members[1].color}
                  size={22}
                  mode={playing ? "idle" : "still"}
                  blinkDelay={1800}
                />
                <div className="twd-message-content">
                  <FileAttachment file="plan" onOpen={setPreview} />
                  <p className="twd-bubble">
                    I read your brief and the signup code. The plan adds inline password guidance
                    using the existing validation rules, with tests for each rule.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="twd-composer-dock" aria-hidden="true">
            <div className="twd-composer">
              <span className="twd-plus">
                <DesktopPlusIcon />
              </span>
              <span className="twd-placeholder">Message Signup improvements</span>
              <span className="twd-mic">
                <DesktopMicIcon />
              </span>
            </div>
          </div>
        </section>

        <aside className="twd-members" aria-label="Sample group members">
          <div className="twd-member-toolbar" aria-hidden="true">
            <Settings size={14} />
            <ChevronsRight size={16} />
          </div>
          <p>Members</p>
          {members.map((member) => (
            <div className="twd-member" key={member.name}>
              <BotAvatar
                shape={member.shape}
                color={member.color}
                size={22}
                mode={playing && ((member.name === "Research" && stage === 0) || (member.name === "Engineering" && stage === 2)) ? "thinking" : "still"}
              />
              <span>{member.name}</span>
            </div>
          ))}
        </aside>
      </div>
      <figcaption>
        <span>Sample group conversation · Open a file to inspect the handoff.</span>
        <span className="twd-announcement" aria-live="off">{stageDescriptions[shownStage]}</span>
      </figcaption>

      <Dialog.Root open={preview !== null} onOpenChange={(open) => {
        if (!open) {
          setPreview(null);
          holdForReading();
        }
      }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="twd-preview-backdrop" />
          <Dialog.Popup className="twd-preview-dialog">
            <header>
              <FileText size={16} aria-hidden="true" />
              <Dialog.Title>{document?.name}</Dialog.Title>
              <Dialog.Close className="twd-close" aria-label="Close sample file preview">
                <X size={17} />
              </Dialog.Close>
            </header>
            <Dialog.Description className="twd-preview-description">
              Illustrative file from the sample group conversation.
            </Dialog.Description>
            <article className="twd-document">
              <p className="twd-path">{document?.path}</p>
              <h2>{document?.title}</h2>
              {document?.content.map((section) => (
                <section key={section.heading}>
                  <h3>{section.heading}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
            </article>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </figure>
  );
}
