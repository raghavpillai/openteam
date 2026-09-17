"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileJson, FileText, MessageSquare } from "lucide-react";
import "./data-stream.css";

type Packet = { id: number; lane: number; direction: number; duration: number; kind: number };

/** Two independent, lightly spaced exchanges; one packet per direction at a time. */
export function DataStream({ playing }: { playing: boolean }) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const serial = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const timers: number[] = [];
    const emit = (lane: number) => {
      const packet = {
        id: serial.current++, lane,
        direction: lane === 0 ? 1 : -1,
        duration: 3200 + Math.random() * 900,
        kind: Math.random() < 0.55 ? 1 + Math.floor(Math.random() * 3) : 0,
      };
      setPackets((current) => [...current.filter((item) => item.lane !== lane), packet]);
      timers[lane] = window.setTimeout(() => emit(lane), packet.duration + 1000 + Math.random() * 1600);
    };
    const firstLane = Math.random() < 0.5 ? 0 : 1;
    for (const lane of [0, 1]) {
      timers[lane] = window.setTimeout(() => emit(lane), 200 + (lane === firstLane ? 0 : 1300) + Math.random() * 500);
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [playing]);

  return (
    <div className="data-stream" data-playing={playing} aria-hidden="true">
      {[0, 1].map((lane) => <i className="data-stream-track" key={lane} style={{ "--lane": lane } as CSSProperties} />)}
      {packets.map((packet) => (
        <span className="data-stream-packet" data-direction={packet.direction} data-kind={packet.kind} key={packet.id}
          onAnimationEnd={() => setPackets((current) => current.filter((item) => item.id !== packet.id))}
          style={{ "--lane": packet.lane, "--flight": `${packet.duration}ms` } as CSSProperties}>
          {packet.kind === 1 ? <FileJson size={12} /> : packet.kind === 2 ? <FileText size={12} /> : packet.kind === 3 ? <MessageSquare size={11} /> : null}
        </span>
      ))}
    </div>
  );
}
