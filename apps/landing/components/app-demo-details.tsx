"use client";

import { Check, ChevronLeft, Mic, LoaderCircle, Ellipsis, MonitorUp, Plus } from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { ConversationPill, FileCard } from "./app-ui";
import { useDemoCycle } from "./use-demo-cycle";
import { DesktopPlusIcon, DesktopMicIcon } from "./desktop-demo-controls";
import "./app-demo-details.css";

// A passive illustration of the handoff request shown in the desktop app.
export function ComputerDemo() {
  const cycle = useDemoCycle(3, [1100, 1500, 12000]);
  const ready = cycle.index === 2;
  return (
    <div
      className="dc-demo"
      ref={cycle.ref}
      {...cycle.props}
      data-handoff-state="requested"
      data-handoff-stage={cycle.index}
    >
      <div className="dc-window" aria-label="Desktop computer handoff demo">
        <section className="dc-chat" aria-label="Research handoff conversation">
          <header className="dc-chat-header">
            <ConversationPill
              avatar={
                <BotAvatar shape="helmet" color="#ff7a1a" size={24} mode={ready ? "idle" : "working"} />
              }
              name="Research"
            />
          </header>
          <div className="dc-chat-content" aria-label="Sample handoff messages">
            <p className="dc-chat-date">Today 8:04 AM</p>
            <div className="dc-user-bubble">
              Check the vendor dashboard and save a usage report.
            </div>
            <div className="dc-activity-slot">
              <span className="dc-live-activity" key={cycle.index}>
                {ready ? (
                  <>
                    <MonitorUp size={13} />
                    Ready for you to take over
                  </>
                ) : (
                  <>
                    <LoaderCircle size={13} />
                    {cycle.index === 0 ? "Opening the vendor dashboard" : "Sign-in required"}
                  </>
                )}
              </span>
            </div>
            <section
              className="dc-handoff-card"
              aria-label="Computer handoff request"
              data-visible={ready}
              aria-hidden={!ready}
            >
              <div className="dc-handoff-copy">
                <MonitorUp size={16} />
                <div>
                  <strong>Take over the computer</strong>
                  <p>
                    Sign in to Northstar in the browser, then return control so I can check the
                    dashboard.
                  </p>
                </div>
              </div>
              <div className="dc-handoff-actions" aria-label="Example handoff choices">
                <span>Skip</span>
                <span>Take over</span>
              </div>
            </section>
          </div>
          <div className="dc-composer" aria-hidden="true">
            <span className="dc-composer-plus">
              <DesktopPlusIcon />
            </span>
            <span>Message Research</span>
            <span className="dc-composer-mic">
              <DesktopMicIcon />
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

// Dimensions match the native 390pt chat UI, uniformly scaled by its frame.
export function MobileDemo() {
  const cycle = useDemoCycle(5, [1300, 1400, 2000, 1700, 8500]);
  return (
    <div
      ref={cycle.ref}
      {...cycle.props}
      className="dm-mobile-autoplay"
      data-mobile-stage={cycle.index}
    >
      <figure className="dm-mobile-scene" aria-label="Example OpenTeam conversation on iPhone">
        <div className="dm-phone-frame">
          <div className="dm-phone">
            <div className="dm-status">
              <span>9:41</span>
              <i />
              <span>••• ▰</span>
            </div>
            <header className="dm-header">
              <span className="dm-circle">
                <ChevronLeft size={21} strokeWidth={2.2} />
              </span>
              <div className="dm-identity">
                <BotAvatar shape="helmet" color="#ff7a1a" size={24} mode="idle" />
                <strong>Research</strong>
              </div>
              <span className="dm-circle dm-more">
                <Ellipsis size={21} strokeWidth={2.4} />
              </span>
            </header>
            <div className="dm-messages">
              <time>Today, 9:41 AM</time>
              <div className="dm-bubble dm-user">Which vendor do you recommend?</div>
              <div className="dm-bubble" data-visible={cycle.index >= 1}>
                Northstar includes SSO and costs the least.
              </div>
              <div className="dm-bubble" data-visible={cycle.index >= 2}>
                I saved the comparison in vendor-review.md.
              </div>
              <div className="dm-file-row" data-visible={cycle.index >= 2}>
                <FileCard className="dm-file-card" fileName="vendor-review.md" detail="1 KB" />
              </div>
              <div className="dm-bubble dm-user" data-visible={cycle.index >= 3}>
                Check their pricing every Monday at 9 AM.
              </div>
              <div className="dm-bubble" data-visible={cycle.index >= 4}>
                Scheduled. I’ll update the comparison.
              </div>
            </div>
            <div className="dm-composer-row">
              <span className="dm-circle">
                <Plus size={20} />
              </span>
              <div className="dm-composer">
                <span>Ask Research</span>
                <span className="dm-mic">
                  <Mic size={17} />
                </span>
              </div>
            </div>
            <div className="dm-home" />
          </div>
        </div>
      </figure>
    </div>
  );
}
