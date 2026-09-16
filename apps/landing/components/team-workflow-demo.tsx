"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowDownToLine,
  Check,
  ChevronsRight,
  FileText,
  FolderOpen,
  Info,
  Settings,
  X,
} from "lucide-react";
import { useState } from "react";
import { useDemoCycle } from "./use-demo-cycle";
import { BotAvatar } from "./bot-avatar";
import { DesktopMicIcon, DesktopPlusIcon } from "./desktop-demo-controls";
import "./team-workflow-demo.css";
import "./team-polish.css";

const members = [
  { name: "Finance", shape: "chip", color: "#27baae" },
  { name: "Travel planner", shape: "pod", color: "#925df2" },
] as const;

const files = {
  brief: {
    name: "trip-budget.md",
    title: "Boston trip budget",
    path: "/workspace/shared/trip-budget.md",
    content: [
      {
        heading: "Budget",
        body: "Allow up to $1,800 for three nights in Boston, including flights, hotel, meals, and local travel.",
      },
      {
        heading: "Suggested allocation",
        body: "Flights: $450. Hotel: $900. Meals and local travel: $300. Keep $150 in reserve.",
      },
      {
        heading: "Handoff to Travel planner",
        body: "Find options within this budget using the saved travel preferences. Share the itinerary for review before booking.",
      },
    ],
  },
  plan: {
    name: "boston-itinerary.md",
    title: "Boston travel options",
    path: "/workspace/shared/boston-itinerary.md",
    content: [
      {
        heading: "Based on the shared budget",
        body: "Finance set a total budget of $1,800. The proposed options come to $1,620, leaving $180 available.",
      },
      {
        heading: "Travel plan",
        body: "Morning outbound flight, three nights near the meeting location, and an evening return. Estimated flights: $420. Hotel: $900. Meals and local travel: $300.",
      },
      {
        heading: "Ready for your review",
        body: "No bookings have been made. Review the options and confirm the dates before the team proceeds.",
      },
    ],
  },
};

type SampleFile = keyof typeof files;

// Leave the completed handoff on screen long enough to read and open either file.
const stageDurations = [1500, 2600, 1800, 1800, 10500] as const;
const activity = [
  "Finance is setting the budget",
  "Budget saved to the shared workspace",
  "Travel planner is reading the budget",
  "Travel planner is finding options",
  "Your itinerary is ready to review",
] as const;

function TypingIndicator({
  member,
  active,
}: {
  member: (typeof members)[number];
  active: boolean;
}) {
  return (
    <div className="twd-typing-row" aria-hidden="true">
      <BotAvatar
        shape={member.shape}
        color={member.color}
        size={22}
        mode={active ? "thinking" : "still"}
      />
      <span className="twd-typing-bubble">
        <i />
        <i />
        <i />
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
      aria-label={`Preview ${files[file].name}`}
    >
      <span className="twd-file-icon" aria-hidden="true">
        <FileText size={17} strokeWidth={1.65} />
      </span>
      <span>
        <strong>{files[file].name}</strong>
        <small>{file === "brief" ? "Shared workspace · 1 KB" : "Shared workspace · 2 KB"}</small>
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
  const cycle = useDemoCycle(5, stageDurations, preview === null);
  const stage = cycle.index;
  const playing = cycle.playing;
  const document = preview ? files[preview] : null;

  return (
    <div
      className="twd-showcase twd-live"
      ref={cycle.ref}
      {...cycle.props}
      data-motion-enabled="true"
      data-workflow-stage={stage}
    >
      <div className="twd-app">
        <section className="twd-chat" aria-label="Boston trip sample group conversation">
          <header className="twd-header">
            <GroupAvatar />
            <strong>Boston trip</strong>
            <span className="twd-header-members">
              Finance <span>+ </span>Travel planner
            </span>
            <span className="twd-info" aria-hidden="true">
              <Info size={16} />
            </span>
          </header>

          <div className="twd-transcript">
            <p className="twd-date">Today, 9:41 AM</p>
            <div className="twd-message twd-user" aria-label="Message from you">
              <p className="twd-bubble">
                Plan my Boston trip. Finance, set the budget. Travel, find the options.
              </p>
            </div>

            <div
              className="twd-message"
              aria-label="Message from Finance"
              data-revealed={stage >= 1}
            >
              {stage === 0 && <TypingIndicator member={members[0]} active={playing} />}
              <span className="twd-sender">Finance</span>
              <div className="twd-agent-row" aria-hidden={stage < 1} inert={stage < 1}>
                <BotAvatar
                  shape={members[0].shape}
                  color={members[0].color}
                  size={22}
                  mode={playing ? "idle" : "still"}
                />
                <div className="twd-message-content">
                  <p className="twd-bubble">
                    We have <strong>$1,800</strong> for the trip.{" "}
                    <span className="twd-mention">@Travel planner</span>, find flights and a hotel
                    within that. The budget is in our shared workspace.
                  </p>
                  <FileAttachment file="brief" onOpen={setPreview} />
                </div>
              </div>
            </div>

            <div className="twd-file-handoff" data-visible={stage >= 2} aria-hidden={stage < 2}>
              <span className="twd-handoff-line">
                <i />
              </span>
              <ArrowDownToLine size={12} />
              <span>
                Travel planner read <strong>trip-budget.md</strong>
              </span>
              <Check size={12} />
            </div>

            <div
              className="twd-message"
              aria-label="Message from Travel planner"
              data-revealed={stage >= 4}
              data-pending={stage < 3}
            >
              {stage === 3 && <TypingIndicator member={members[1]} active={playing} />}
              <span className="twd-sender">Travel planner</span>
              <div className="twd-agent-row" aria-hidden={stage < 4} inert={stage < 4}>
                <BotAvatar
                  shape={members[1].shape}
                  color={members[1].color}
                  size={22}
                  mode={playing ? "idle" : "still"}
                  blinkDelay={1800}
                />
                <div className="twd-message-content">
                  <p className="twd-bubble">
                    Found options for <strong>$1,620</strong>: a morning flight and a hotel near the
                    meeting, using your saved preferences.
                  </p>
                  <div className="twd-trip-result">
                    <div className="twd-trip-summary">
                      <span>Boston · 3 nights</span>
                      <span>
                        <Check size={11} /> Within budget
                      </span>
                    </div>
                    <div className="twd-budget-total">
                      <strong>$1,620</strong>
                      <span>of $1,800</span>
                      <small>$180 to spare</small>
                    </div>
                    <div className="twd-budget-track" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="twd-budget-key">
                      <span>Flight</span>
                      <span>Hotel</span>
                      <span>Other</span>
                    </div>
                    <FileAttachment file="plan" onOpen={setPreview} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="twd-workspace-status">
            <span className="twd-activity-symbol" data-complete={stage === 4}>
              {stage === 4 ? <Check size={12} /> : <FolderOpen size={12} />}
            </span>
            <span key={stage}>{activity[stage]}</span>
            <span className="twd-activity-steps" aria-hidden="true">
              {stageDurations.map((_, index) => (
                <i key={index} data-active={index === stage} data-done={index < stage} />
              ))}
            </span>
          </div>
          <div className="twd-composer-dock" aria-hidden="true">
            <div className="twd-composer">
              <span className="twd-plus">
                <DesktopPlusIcon />
              </span>
              <span className="twd-placeholder">Message Boston trip</span>
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
                mode={
                  playing &&
                  ((member.name === "Finance" && stage === 0) ||
                    (member.name === "Travel planner" && (stage === 2 || stage === 3)))
                    ? "thinking"
                    : "still"
                }
              />
              <span>{member.name}</span>
            </div>
          ))}
        </aside>
      </div>

      <Dialog.Root
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
          }
        }}
      >
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
    </div>
  );
}
