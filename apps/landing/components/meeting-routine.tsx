"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Mail,
  Monitor,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BotAvatar } from "./bot-avatar";
import { DesktopMicIcon, DesktopPlusIcon } from "./desktop-demo-controls";
import { useDemoCycle } from "./use-demo-cycle";
import "./meeting-routine.css";

const meetings = [
  {
    time: "10:00 AM",
    title: "Acme · Intro call",
    person: "Maya Chen",
    role: "Head of Operations",
    context:
      "Alex introduced you last week. Maya is looking for a simpler way to manage vendor renewals.",
    review: "Company overview and Alex’s introduction.",
    source: "Intro email · Company overview",
  },
  {
    time: "2:30 PM",
    title: "Northstar · Follow-up",
    person: "Alex Rivera",
    role: "Co-founder",
    context: "You discussed a pilot with the operations team. Scope and timing are still open.",
    review: "Pilot outline and the questions from your last call.",
    source: "Meeting notes · Pilot outline",
  },
] as const;

// Mirrors the desktop's generated question card, routine event, markdown reply,
// file attachment, and composer. The conversation itself is illustrative.
export function MeetingRoutine({ children }: { children?: ReactNode }) {
  const [preview, setPreview] = useState(false);
  const [schedule, setSchedule] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const cycle = useDemoCycle(4, [1700, 1300, 1400, 10500], !preview);
  const stage = cycle.index;
  const scheduled = stage > 0;
  const complete = stage === 3;
  const scheduleLabel = schedule === 0 ? "Every weekday" : "Every day";

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = transcript.current;
      if (!element) return;
      element.scrollTo({
        top: stage >= 2 ? element.scrollHeight : 0,
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  return (
    <div className="mr-scene" ref={cycle.ref} {...cycle.props} data-routine-chat-stage={stage}>
      <div className="mr-intro">
        {children}
        <div className="mr-schedule" aria-label="Daily meeting brief schedule">
          <div className="mr-schedule-heading">
            <span className="mr-schedule-icon">
              <CalendarClock size={20} />
            </span>
            <div>
              <strong>Daily meeting brief</strong>
              <span>Chief of staff</span>
            </div>
            <span className="mr-active-light" aria-label="Active" />
          </div>
          <div className="mr-schedule-time">
            <span>
              08<span className="mr-clock-colon">:</span>00
            </span>
            <div>
              <strong>AM</strong>
              <span>{scheduleLabel}</span>
            </div>
          </div>
          <div className="mr-week" aria-label={scheduleLabel}>
            {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
              <span key={index} data-enabled={schedule === 1 || index < 5} data-today={index === 2}>
                {day}
                <i />
              </span>
            ))}
          </div>
          <div className="mr-schedule-footer">
            {stage === 1 || stage === 2 ? <span className="mr-running-dot" /> : <Check size={13} />}
            <span>
              {complete
                ? "Delivered · Next run tomorrow"
                : scheduled
                  ? "Preparing your morning brief"
                  : "Runs on your server"}
            </span>
          </div>
          <div className="mr-schedule-progress" key={`${stage}-${cycle.revision}`} />
        </div>
        <svg className="mr-connection" viewBox="0 0 100 100" fill="none" aria-hidden="true">
          <path d="M2 2V42Q2 58 18 58H77Q93 58 93 74V98" />
          <path className="mr-connection-packet" d="M2 2V42Q2 58 18 58H77Q93 58 93 74V98" />
        </svg>
      </div>

      <div className="mr-window" aria-label="Chief of staff chat and recurring meeting brief">
        <header className="mr-header">
          <BotAvatar
            shape="helmet"
            color="#ff7a1a"
            size={28}
            mode={stage === 1 || stage === 2 ? "thinking" : "idle"}
          />
          <div>
            <strong>Chief of staff</strong>
            <span>{stage === 1 || stage === 2 ? "Working on your brief" : "Your workspace"}</span>
          </div>
          <span className="mr-header-computer" aria-label="Worker computer">
            <Monitor size={17} />
          </span>
        </header>

        <div className="mr-transcript" ref={transcript}>
          <p className="mr-date">Yesterday, 4:32 PM</p>
          <div className="mr-user-bubble">
            Send me a brief of my meetings: who I’m meeting, what we last discussed, and what to
            review.
          </div>

          <div className="mr-question" aria-label="Generated scheduling question">
            <p>When should I send your brief?</p>
            <div className="mr-question-options" role="group" aria-label="Choose a schedule">
              {["Weekdays at 8:00 AM", "Every day at 8:00 AM"].map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={scheduled && schedule === index}
                  data-selected={scheduled && schedule === index}
                  data-resolved={scheduled}
                  onClick={() => {
                    setSchedule(index);
                    cycle.select(1);
                  }}
                >
                  <span className="mr-option-key">{index === 0 ? "A" : "B"}</span>
                  <span>{label}</span>
                  {scheduled && schedule === index ? (
                    <Check size={15} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="mr-delivery" data-visible={scheduled} aria-hidden={!scheduled}>
            <div className="mr-routine-event">
              <span>Created</span>
              <Clock3 size={12} />
              <span>Daily meeting brief</span>
            </div>
            <div className="mr-today">
              <span />
              <p>Today, 8:00 AM</p>
              <span />
            </div>
            {stage === 1 && (
              <div className="mr-working" aria-label="Reading calendar, email, and meeting notes">
                <div className="mr-working-icons">
                  <CalendarDays size={15} />
                  <Mail size={15} />
                  <FileText size={15} />
                </div>
                <span>Reading your calendar and conversations</span>
                <span className="mr-typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>

          {stage >= 2 && (
            <div className="mr-result" key="meeting-brief">
              <p className="mr-reply-intro">Good morning. Here’s your meeting brief.</p>
              <article className="mr-brief" aria-label="Today’s generated meeting brief">
                <header>
                  <div>
                    <span>Wednesday, September 16</span>
                    <h3>Ready for your day.</h3>
                  </div>
                  <span className="mr-meeting-count">2 meetings</span>
                </header>
                {meetings.map((meeting, index) => (
                  <section
                    key={meeting.title}
                    className="mr-meeting"
                    data-visible={index === 0 || complete}
                    aria-hidden={index === 1 && !complete}
                  >
                    <div className="mr-meeting-title">
                      <span>{meeting.time}</span>
                      <h4>{meeting.title}</h4>
                    </div>
                    <p className="mr-person">
                      <strong>{meeting.person}</strong> · {meeting.role}
                    </p>
                    <p className="mr-context">{meeting.context}</p>
                    <p className="mr-review">
                      <strong>Review</strong> {meeting.review}
                    </p>
                    <span className="mr-sources">
                      <FileText size={12} />
                      {meeting.source}
                    </span>
                  </section>
                ))}
                {!complete && (
                  <div className="mr-brief-generating">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </article>
              {complete && (
                <button className="mr-file" type="button" onClick={() => setPreview(true)}>
                  <span className="mr-file-icon">
                    <FileText size={23} />
                  </span>
                  <span>
                    <strong>meeting-brief.md</strong>
                    <small>Markdown document · 2 KB</small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mr-composer" aria-hidden="true">
          <span className="mr-plus">
            <DesktopPlusIcon />
          </span>
          <span>Message Chief of staff</span>
          <span className="mr-mic">
            <DesktopMicIcon />
          </span>
        </div>
      </div>

      <Dialog.Root open={preview} onOpenChange={setPreview}>
        <Dialog.Portal>
          <Dialog.Backdrop className="mr-preview-backdrop" />
          <Dialog.Popup className="mr-preview-dialog">
            <header>
              <FileText size={17} />
              <Dialog.Title>meeting-brief.md</Dialog.Title>
              <Dialog.Close aria-label="Close meeting brief">
                <X size={18} />
              </Dialog.Close>
            </header>
            <Dialog.Description className="mr-visually-hidden">
              The daily meeting brief generated by your Chief of staff in this example.
            </Dialog.Description>
            <article className="mr-document">
              <span>Wednesday, September 16</span>
              <h2>Your meeting brief</h2>
              <p>Two meetings today. Here’s the context to bring into each conversation.</p>
              {meetings.map((meeting) => (
                <section key={meeting.title}>
                  <span>{meeting.time}</span>
                  <h3>{meeting.title}</h3>
                  <p>
                    <strong>{meeting.person}</strong> · {meeting.role}
                  </p>
                  <h4>Context</h4>
                  <p>{meeting.context}</p>
                  <h4>Before the call</h4>
                  <p>{meeting.review}</p>
                  <small>{meeting.source}</small>
                </section>
              ))}
            </article>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
