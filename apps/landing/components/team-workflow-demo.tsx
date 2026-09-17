"use client";

import {
  FileJson,
  Check,
  ChevronsRight,
  FileText,
  FolderOpen,
  Info,
  Settings,
} from "lucide-react";
import { useDemoCycle } from "./use-demo-cycle";
import { DataStream } from "./data-stream";
import { BotAvatar } from "./bot-avatar";
import { DesktopMicIcon, DesktopPlusIcon } from "./desktop-demo-controls";
import "./team-workflow-demo.css";
import "./team-polish.css";

const members = [
  { name: "Finance", shape: "chip", color: "#27baae" },
  { name: "Travel planner", shape: "pod", color: "#925df2" },
] as const;

const files = {
  options: { name: "travel-options.json" },
  review: { name: "cost-review.md" },
  plan: { name: "boston-itinerary.md" },
};

type SampleFile = keyof typeof files;

// Leave the completed handoff on screen long enough to read the shared files and result.
const stageDurations = [1300, 2500, 1400, 2800, 1600, 9500] as const;
const activity = [
  "Travel planner is comparing flights and hotels",
  "Travel options shared with Finance",
  "Finance is checking fees and travel policy",
  "Cost review sent to Travel planner",
  "Travel planner is updating the itinerary",
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

function FileAttachment({ file }: { file: SampleFile }) {
  return (
    <div className="twd-file">
      <span className="twd-file-icon" aria-hidden="true">
        {file === "options" ? (
          <FileJson size={17} strokeWidth={1.65} />
        ) : (
          <FileText size={17} strokeWidth={1.65} />
        )}
      </span>
      <span>
        <strong>{files[file].name}</strong>
        <small>
          {file === "options" ? "Shared workspace · JSON" : "Shared workspace · Markdown"}
        </small>
      </span>
    </div>
  );
}

/**
 * A cropped desktop group conversation, with illustrative messages and files.
 * The header, agent labels/gutters, bubbles, member list, and composer follow
 * DesktopHeader, ChatPane, Inspector, and PromptInput in the desktop renderer.
 */
export function TeamWorkflowDemo() {
  const cycle = useDemoCycle(stageDurations.length, stageDurations);
  const stage = cycle.index;
  const playing = cycle.playing;

  return (
    <div
      className="twd-showcase twd-live"
      ref={cycle.ref}
      {...cycle.props}
      data-motion-enabled="true"
      data-workflow-stage={stage}
    >
      <div
        className="twd-exchange"
        aria-label="Travel planner shares options with Finance, and Finance sends back a cost review"
      >
        <div className="twd-exchange-worker">
          <BotAvatar
            shape="chip"
            color="#27baae"
            size={35}
            mode={playing && stage === 2 ? "thinking" : "idle"}
          />
          <span>Finance</span>
        </div>
        <DataStream playing={playing} />
        <div className="twd-exchange-worker">
          <BotAvatar
            shape="pod"
            color="#925df2"
            size={35}
            mode={playing && (stage === 0 || stage === 4) ? "thinking" : "idle"}
          />
          <span>Travel planner</span>
        </div>
      </div>
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
                Plan three nights in Boston for my Acme meetings. Find flexible travel options that
                fit our company policy.
              </p>
            </div>

            <div
              className="twd-message"
              aria-label="Message from Travel planner"
              data-revealed={stage >= 1}
            >
              {stage === 0 && <TypingIndicator member={members[1]} active={playing} />}
              <span className="twd-sender">Travel planner</span>
              <div className="twd-agent-row" aria-hidden={stage < 1}>
                <BotAvatar
                  shape="pod"
                  color="#925df2"
                  size={22}
                  mode={playing ? "idle" : "still"}
                />
                <div className="twd-message-content">
                  <p className="twd-bubble">
                    I found a morning flight and two refundable hotels.{" "}
                    <span className="twd-mention">@Finance</span>, compare the full costs, including
                    fees and transfers?
                  </p>
                  <FileAttachment file="options" />
                </div>
              </div>
            </div>

            <div
              className="twd-message"
              aria-label="Message from Finance"
              data-revealed={stage >= 3}
              data-pending={stage < 2}
            >
              {stage === 2 && <TypingIndicator member={members[0]} active={playing} />}
              <span className="twd-sender">Finance</span>
              <div className="twd-agent-row" aria-hidden={stage < 3}>
                <BotAvatar
                  shape="chip"
                  color="#27baae"
                  size={22}
                  mode={playing ? "idle" : "still"}
                />
                <div className="twd-message-content">
                  <p className="twd-bubble">
                    The walkable hotel is <strong>$120 less overall</strong> once transfers are
                    included. The full trip comes to <strong>$1,620</strong> and fits our travel
                    policy. <span className="twd-mention">@Travel planner</span>, use that option.
                  </p>
                  <FileAttachment file="review" />
                </div>
              </div>
            </div>

            <div
              className="twd-message"
              aria-label="Updated itinerary from Travel planner"
              data-revealed={stage >= 5}
              data-pending={stage < 4}
            >
              {stage === 4 && <TypingIndicator member={members[1]} active={playing} />}
              <span className="twd-sender">Travel planner</span>
              <div className="twd-agent-row" aria-hidden={stage < 5}>
                <BotAvatar
                  shape="pod"
                  color="#925df2"
                  size={22}
                  mode={playing ? "idle" : "still"}
                />
                <div className="twd-message-content">
                  <p className="twd-bubble">
                    Updated the itinerary with the walkable hotel and refundable fare. Ready for
                    your review; nothing booked.
                  </p>
                  <div className="twd-trip-result">
                    <div className="twd-trip-summary">
                      <span>Boston · 3 nights</span>
                      <span>
                        <Check size={11} /> Policy checked
                      </span>
                    </div>
                    <div className="twd-budget-total">
                      <strong>$1,620</strong>
                      <span>estimated total</span>
                      <small>Fees included</small>
                    </div>
                    <div className="twd-budget-track" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="twd-budget-key">
                      <span>Flight $420</span>
                      <span>Hotel $900</span>
                      <span>Other $300</span>
                    </div>
                    <FileAttachment file="plan" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="twd-workspace-status">
            <span className="twd-activity-symbol" data-complete={stage === 5}>
              {stage === 5 ? <Check size={12} /> : <FolderOpen size={12} />}
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
                  ((member.name === "Finance" && stage === 2) ||
                    (member.name === "Travel planner" && (stage === 0 || stage === 4)))
                    ? "thinking"
                    : "still"
                }
              />
              <span>{member.name}</span>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
