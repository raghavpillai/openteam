"use client";

import { CalendarClock, CalendarDays, Check, Clock3, FileText, Mail, Monitor } from "lucide-react";
import type { ReactNode } from "react";
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

// One autoplay conversation: request, schedule, run, and delivered brief.
export function MeetingRoutine({ children }: { children?: ReactNode }) {
  const cycle = useDemoCycle(5, [2200, 2000, 1600, 1700, 9000]);
  const stage = cycle.index;
  const scheduled = stage > 0;
  const delivering = stage >= 2;
  const complete = stage === 4;

  return (
    <div className="mr-scene" ref={cycle.ref} {...cycle.props} data-routine-chat-stage={stage}>
      <div className="mr-intro">{children}</div>
      <div
        className="mr-window"
        aria-label="Chief of staff schedules and delivers a daily meeting brief"
      >
        <header className="mr-header">
          <BotAvatar
            shape="helmet"
            color="#ff7a1a"
            size={30}
            mode={stage === 2 || stage === 3 ? "thinking" : "idle"}
          />
          <div>
            <strong>Chief of staff</strong>
            <span>Your workspace</span>
          </div>
          <Monitor size={18} aria-hidden="true" />
        </header>

        <div className="mr-schedule" data-scheduled={scheduled}>
          <CalendarClock size={21} />
          <div>
            <strong>Daily meeting brief</strong>
            <span>Weekdays · 8:00 AM</span>
          </div>
          <span className="mr-schedule-state">
            {complete ? <Check size={13} /> : <Clock3 size={13} />}
            {complete
              ? "Delivered"
              : stage >= 2
                ? "Running"
                : scheduled
                  ? "Scheduled"
                  : "Setting up"}
          </span>
          <i className="mr-schedule-progress" key={stage} aria-hidden="true" />
        </div>

        <div className="mr-transcript">
          {!delivering ? (
            <div className="mr-setup" key="setup">
              <p className="mr-date">Yesterday, 4:32 PM</p>
              <div className="mr-user-bubble">
                Send me a brief of my meetings: who I’m meeting, what we last discussed, and what to
                review.
              </div>
              <div className="mr-question">
                <p>When should I send your brief?</p>
                <div className="mr-question-options" aria-label="Example scheduling choices">
                  {["Weekdays at 8:00 AM", "Every day at 8:00 AM"].map((label, index) => (
                    <div key={label} className="mr-option" data-selected={scheduled && index === 0}>
                      <span className="mr-option-key">{index === 0 ? "A" : "B"}</span>
                      <span>{label}</span>
                      {scheduled && index === 0 && <Check size={15} />}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mr-confirmation" data-visible={scheduled} aria-hidden={!scheduled}>
                <Check size={15} /> Scheduled. I’ll send your brief here every weekday at 8:00 AM.
              </div>
            </div>
          ) : (
            <div className="mr-delivery" key="delivery">
              <div className="mr-today">
                <span />
                <p>Today, 8:00 AM</p>
                <span />
              </div>
              {stage === 2 ? (
                <div className="mr-working">
                  <div className="mr-working-icons">
                    <CalendarDays size={17} />
                    <Mail size={17} />
                    <FileText size={17} />
                  </div>
                  <span>Reading your calendar and conversations</span>
                  <span className="mr-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              ) : (
                <div className="mr-result">
                  <p className="mr-reply-intro">Good morning. Here’s your meeting brief.</p>
                  <article className="mr-brief" aria-label="Today’s generated meeting brief">
                    <header>
                      <div>
                        <span>Wednesday, September 16</span>
                        <h3>Ready for your day.</h3>
                      </div>
                      <span className="mr-meeting-count">2 meetings</span>
                    </header>
                    {meetings.map(
                      (meeting, index) =>
                        (index === 0 || complete) && (
                          <section key={meeting.title} className="mr-meeting">
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
                        )
                    )}
                    {!complete && (
                      <div className="mr-brief-generating" aria-label="Preparing your next meeting">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                  </article>
                  {complete && (
                    <div className="mr-file">
                      <FileText size={20} />
                      <div>
                        <strong>meeting-brief.md</strong>
                        <span>Saved to your workspace</span>
                      </div>
                      <Check size={15} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mr-next-run" data-visible={complete} aria-hidden={!complete}>
          <Clock3 size={12} /> Next brief tomorrow at 8:00 AM
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
    </div>
  );
}
