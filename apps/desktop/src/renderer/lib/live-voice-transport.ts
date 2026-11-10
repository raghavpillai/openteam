import type { VoiceSessionTicketView, VoiceServerMessage } from "@openteam/contracts/voice";
import { API_BASE } from "../client/http";
import { resolveVoiceSocketUrl } from "../client/runtime-url";

export interface LiveVoiceTransportEvents {
  onControl?: (message: VoiceServerMessage) => void;
  onAudio?: (frame: Uint8Array) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (error: unknown) => void;
}

export class LiveVoiceTransport {
  private socket: WebSocket | null = null;
  private stopped = false;
  private clientSequence = 0;
  private stoppedGeneration = -1;
  constructor(private readonly ticket: VoiceSessionTicketView, private readonly events: LiveVoiceTransportEvents = {}) {}

  connect(): Promise<void> {
    this.stopped = false;
    const url = resolveVoiceSocketUrl(API_BASE, this.ticket.path);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, this.ticket.protocols);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => resolve();
      socket.onerror = event => { this.events.onError?.(event); reject(new Error("Voice WebSocket failed")); };
      socket.onclose = event => this.events.onClose?.(event);
      socket.onmessage = event => {
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as VoiceServerMessage;
            if (message.type === "audio.stopped" || message.type === "barge_in") this.stoppedGeneration = Math.max(this.stoppedGeneration, message.generation);
            this.events.onControl?.(message);
          } catch (error) { this.events.onError?.(error); }
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.byteLength >= 12) {
          const generation = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
          if (generation <= this.stoppedGeneration) return;
        }
        this.events.onAudio?.(bytes);
      };
      this.socket = socket;
    });
  }

  hello(echoCancellation: boolean) { this.control({ type: "hello", echoCancellation }); }
  ready() { this.control({ type: "client_ready" }); }
  acknowledge(generation: number, frameSequence: number) { this.control({ type: "playback.ack", generation, frameSequence }); }
  ping() { this.control({ type: "ping" }); }
  stop() { this.stopped = true; this.control({ type: "stop" }); this.socket?.close(1000, "Voice session stopped"); }
  sendFrame(frame: Uint8Array) { if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame); }
  private control(message: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ ...message, version: 1, sessionId: this.ticket.id, sequence: this.clientSequence++ }));
  }
}
