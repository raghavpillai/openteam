"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileJson, FileText, MessageSquare } from "lucide-react";
import "./data-stream.css";

type Packet = { id: number; lane: number; direction: number; duration: number; kind: number; created: number };

/** Independent bursts of files and context, with traffic moving in both directions. */
export function DataStream({ playing }: { playing: boolean }) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const serial = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let timer: number;
    const emit = () => {
      const now = performance.now();
      const burst = Array.from({ length: Math.random() < 0.45 ? 3 : 2 }, () => ({
        id: serial.current++, lane: Math.floor(Math.random() * 3),
        direction: Math.random() < 0.5 ? -1 : 1,
        duration: 900 + Math.random() * 1300,
        kind: Math.random() < 0.22 ? 1 + Math.floor(Math.random() * 3) : 0,
        created: now,
      }));
      setPackets((current) => [...current.filter((packet) => now - packet.created < packet.duration), ...burst].slice(-24));
      timer = window.setTimeout(emit, 180 + Math.random() * 420);
    };
    emit();
    return () => window.clearTimeout(timer);
  }, [playing]);

  return (
    <div className="data-stream" data-playing={playing} aria-hidden="true">
      {[0, 1, 2].map((lane) => <i className="data-stream-track" key={lane} style={{ "--lane": lane } as CSSProperties} />)}
      {packets.map((packet) => (
        <span className="data-stream-packet" data-direction={packet.direction} data-kind={packet.kind} key={packet.id}
          style={{ "--lane": packet.lane, "--flight": `${packet.duration}ms` } as CSSProperties}>
          {packet.kind === 1 ? <FileJson size={12} /> : packet.kind === 2 ? <FileText size={12} /> : packet.kind === 3 ? <MessageSquare size={11} /> : null}
        </span>
      ))}
    </div>
  );
}
