import type { BotView } from "@openteam/contracts";
import { useEffect, useState } from "react";
import type { GroupActivity } from "../../lib/group-chat-presentation";
import { BotAvatar } from "./avatar";
import { ThinkingCaption } from "./thinking-caption";

type ReaderSeat = { bot: BotView; departing: boolean; rank: number };

function GroupReaders({ readers }: { readers: BotView[] }) {
  const [seats, setSeats] = useState<ReaderSeat[]>(() =>
    readers.map((bot, rank) => ({ bot, rank, departing: false }))
  );
  const currentIds = new Set(readers.map((bot) => bot.id));
  if (
    readers.some((bot) => !seats.some((seat) => seat.bot === bot && !seat.departing)) ||
    seats.some((seat) => seat.departing === currentIds.has(seat.bot.id))
  ) {
    const retained = seats.map((seat) => ({
      ...seat,
      bot: readers.find((bot) => bot.id === seat.bot.id) ?? seat.bot,
      departing: !currentIds.has(seat.bot.id),
    }));
    const added = readers.filter((bot) => !seats.some((seat) => seat.bot.id === bot.id));
    setSeats([...retained, ...added.map((bot, rank) => ({ bot, rank, departing: false }))]);
  }
  // Also clean up when animations are disabled or the surface is offscreen.
  useEffect(() => {
    if (!seats.some((seat) => seat.departing)) return;
    const timer = window.setTimeout(
      () => setSeats((value) => value.filter((seat) => !seat.departing)),
      160
    );
    return () => window.clearTimeout(timer);
  }, [seats]);
  if (seats.length === 0) return null;
  let position = 0;
  return (
    <span
      className="group-reader-cluster"
      data-reading-count={readers.length}
      style={{ width: readers.length ? 18 + (readers.length - 1) * 22 : 0 }}
    >
      {seats.map((seat, index) => {
        const offset = position * 22;
        if (!seat.departing) position++;
        return (
          <span
            className="group-reader-seat"
            data-reader-id={seat.bot.id}
            data-departing={seat.departing || undefined}
            key={seat.bot.id}
            style={{ transform: `translateX(${offset}px)`, zIndex: seats.length - index }}
          >
            <span
              className="group-reader-disc"
              style={{ animationDelay: seat.departing ? "0ms" : `${seat.rank * 45}ms` }}
            >
              <span
                className="group-reader-breathe"
                style={{ animationDelay: `${index * -400}ms` }}
              >
                <BotAvatar bot={seat.bot} className="!size-[18px]" mode="still" />
              </span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function GroupActivityContent({ activity }: { activity: GroupActivity }) {
  const { workers, readers, typing, text } = activity;
  const [cycle, setCycle] = useState(0);
  const [presence, setPresence] = useState({ workers, arriving: false, departing: false });
  const workersPresent = workers.length > 0;
  if (workersPresent && (workers !== presence.workers || presence.departing)) {
    setPresence({
      workers,
      departing: false,
      arriving: presence.arriving || presence.workers.length === 0 || presence.departing,
    });
  } else if (!workersPresent && presence.workers.length > 0 && !presence.departing) {
    setPresence({ ...presence, departing: true });
  }
  useEffect(() => {
    if (workers.length < 2) return;
    const timer = window.setInterval(() => setCycle((value) => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, [workers.length]);
  useEffect(() => {
    if (!presence.departing) return;
    const timer = window.setTimeout(
      () => setPresence({ workers: [], arriving: false, departing: false }),
      140
    );
    return () => window.clearTimeout(timer);
  }, [presence.departing]);
  const visible = workersPresent ? workers : presence.workers;
  const bot = visible[cycle % visible.length];
  return (
    <>
      <span className="group-activity-mark-seat" data-present={workersPresent || undefined}>
        {bot && (
          <span
            className="group-activity-mark"
            data-departing={!workersPresent || undefined}
            data-arriving={presence.arriving || undefined}
            data-composing={typing || undefined}
            data-activity-bot-id={bot.id}
            onAnimationEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.animationName === "group-participant-enter"
              ) {
                setPresence((value) => ({ ...value, arriving: false }));
              }
            }}
          >
            <BotAvatar bot={bot} size="sm" mode="thinking" />
          </span>
        )}
      </span>
      <span className="group-activity-tail" data-has-mark={visible.length > 0 || undefined}>
        <GroupReaders readers={readers} />
        <ThinkingCaption text={text} group />
      </span>
    </>
  );
}
