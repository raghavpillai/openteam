import type { PrismaClient } from "@openteam/db";
import { normalizeVoiceText, splitVoiceSentences } from "./voice-text";

export interface VoiceReplySink {
  deliverReply(input: { turnId: string; messageId: string; content: string; metadata: unknown }): Promise<void>;
  reconcileRun(runId: string): Promise<void>;
}

export class VoiceReplySource {
  private readonly active = new Map<string, VoiceReplySink>();
  constructor(private readonly prisma: PrismaClient) {}

  register(runId: string, sink: VoiceReplySink) { this.active.set(runId, sink); }
  unregister(runId: string) { this.active.delete(runId); }

  async onVisibleMessage(runId: string, messageId: string): Promise<void> {
    const sink = this.active.get(runId);
    if (!sink) return;
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId }, select: { id: true, content: true, metadata: true } });
    if (!message) return;
    const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? message.metadata as Record<string, unknown> : {};
    const type = typeof metadata.type === "string" ? metadata.type : "text";
    const content = type === "text" || type === "voice-narration" ? normalizeVoiceText(message.content) : type === "attachment" ? "I sent an attachment." : type === "secret-request" ? "I need a secret from you." : "I sent an interactive message.";
    if (!content) return;
    await sink.deliverReply({ turnId: "", messageId: message.id, content, metadata: { ...metadata, sentences: splitVoiceSentences(content) } });
  }

  async reconcileRun(runId: string): Promise<void> {
    const sink = this.active.get(runId);
    if (!sink) return;
    const messages = await this.prisma.channelMessage.findMany({ where: { sourceRunId: runId, sender: "agent" }, orderBy: { sequence: "asc" }, select: { id: true, content: true, metadata: true } });
    for (const message of messages) {
      // Narration is spoken when it is generated, not replayed with the run's answers.
      const metadata = message.metadata as { type?: unknown } | null;
      if (metadata?.type === "voice-narration") continue;
      await this.onVisibleMessage(runId, message.id);
    }
  }
}
