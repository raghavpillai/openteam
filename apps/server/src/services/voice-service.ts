import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  ApiError,
  VOICE_MAX_SESSION_MS,
  VOICE_MAX_TURN_MS,
  VOICE_PROTOCOL,
  VOICE_PROTOCOL_VERSION,
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
  decodeVoiceFrame,
  voiceMessageMetadata,
  type VoiceClientPlatform,
  type VoiceProviderId,
  type VoiceSessionCreateInput,
  type VoiceSessionTicketView,
  type VoiceSessionView,
  type VoiceTurnView,
} from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import type { ChannelService } from "./channel-service";
import type { RunService } from "./run-service";
import { VoiceReplySource } from "./voice-reply";
import { VoiceSessionConnection, voiceInputConfig, voiceOutputConfig, type VoiceConnectionData } from "./voice-session";
import { VoiceSettingsService } from "./voice-settings";
import { VoiceProviderRegistry } from "./voice-provider-registry";
import { NativeOpusCodec } from "./native-opus";
import { PcmPreroll, VoiceVad } from "./voice-vad";
import { isMeaningfulTranscript } from "./voice-text";
import { WarmTtsPool } from "./voice-tts-warm";
import type { StreamingStt, StreamingTts } from "./voice-provider";

type Ticket = { sessionId: string; ownerSessionId: string | null; origin: string | null; expiresAt: number };

const nativeOrigin = (value: string | null) => value === "null" || value === "file://" || value === "http://openteam-vnc.invalid" ? null : value;
const providerId = (value: string): VoiceProviderId => value === "deepgram" ? "deepgram" : "volcengine";

export class VoiceService {
  readonly settings: VoiceSettingsService;
  readonly providers = new VoiceProviderRegistry(provider => this.settings.runtime(provider));
  readonly replies: VoiceReplySource;
  private readonly tickets = new Map<string, Ticket>();
  private readonly connections = new Map<string, VoiceSessionConnection>();
  private readonly echoes = new Map<string, boolean>();
  private readonly sessionRuns = new Map<string, Set<string>>();

  constructor(private readonly prisma: PrismaClient, private readonly channels: ChannelService, private readonly runs: RunService) {
    this.settings = new VoiceSettingsService(prisma);
    this.replies = new VoiceReplySource(prisma);
  }

  private view(session: { id: string; botId: string; conversationId: string; channelId: string; clientPlatform: string; provider: string; status: string; expiresAt: Date; createdAt: Date }): VoiceSessionView {
    return { id: session.id, botId: session.botId, conversationId: session.conversationId, channelId: session.channelId, clientPlatform: session.clientPlatform as VoiceClientPlatform, provider: providerId(session.provider), status: session.status as VoiceSessionView["status"], expiresAt: session.expiresAt.toISOString(), createdAt: session.createdAt.toISOString(), input: voiceInputConfig(), output: voiceOutputConfig(), limits: { maxSessionMs: VOICE_MAX_SESSION_MS, maxTurnMs: VOICE_MAX_TURN_MS } };
  }

  private async authorizedSession(sessionId: string, ownerSessionId: string | null) {
    const session = await this.prisma.voiceSession.findUnique({ where: { id: sessionId } });
    if (!session || (ownerSessionId && session.ownerSessionId !== ownerSessionId) || session.expiresAt <= new Date()) throw new ApiError(404, "voice_session_not_found", "Voice session was not found");
    return session;
  }

  private async ticket(session: { id: string; ownerSessionId: string | null }, origin: string | null): Promise<[string, string]> {
    const now = Date.now();
    for (const [key, value] of this.tickets) if (value.expiresAt <= now || value.sessionId === session.id) this.tickets.delete(key);
    const token = `ticket.${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 50);
    this.tickets.set(token, { sessionId: session.id, ownerSessionId: session.ownerSessionId, origin: nativeOrigin(origin), expiresAt: now + 30_000 });
    return [VOICE_PROTOCOL, token];
  }

  async create(input: VoiceSessionCreateInput, ownerSessionId: string | null, origin: string | null): Promise<VoiceSessionTicketView> {
    const settings = this.settings.runtime();
    if (!settings.enabled) throw new ApiError(404, "voice_unavailable", "Realtime voice is not enabled");
    const channel = await this.prisma.channel.findFirst({ where: { id: input.channelId, kind: "bot_dm", archivedAt: null, members: { some: { botId: input.botId } } }, include: { members: { where: { botId: input.botId }, include: { bot: { include: { conversation: true } } } } } });
    const bot = channel?.members[0]?.bot;
    if (!channel || !bot?.conversation) throw new ApiError(404, "voice_target_not_found", "Bot conversation was not found");
    if (ownerSessionId) {
      const active = await this.prisma.voiceSession.count({ where: { ownerSessionId, status: { in: ["created", "active"] }, expiresAt: { gt: new Date() } } });
      if (active >= 3) throw new ApiError(429, "voice_concurrency_limit", "Too many active voice sessions");
    }
    const provider = input.provider ?? settings.defaultProvider;
    if (!this.settings.providerConfigured(provider)) throw new ApiError(409, "voice_provider_unconfigured", "The selected voice provider is not configured");
    const session = await this.prisma.voiceSession.create({
      data: {
        botId: input.botId,
        conversationId: bot.conversation.id,
        channelId: input.channelId,
        ownerSessionId,
        clientPlatform: input.clientPlatform,
        clientInstanceId: input.clientInstanceId,
        provider,
        // Blank means "use the provider default"; it is resolved when speaking.
        voice: bot.voice.trim(),
        status: "created",
        expiresAt: new Date(Date.now() + VOICE_MAX_SESSION_MS),
      },
    });
    return this.ticketView(session, origin);
  }

  private async ticketView(session: Parameters<VoiceService["view"]>[0], origin: string | null): Promise<VoiceSessionTicketView> {
    const protocols = await this.ticket({ id: session.id, ownerSessionId: (session as { ownerSessionId?: string | null }).ownerSessionId ?? null }, origin);
    return { ...this.view(session), path: `/api/v0/voice/sessions/${encodeURIComponent(session.id)}/stream`, protocols: protocols as [typeof VOICE_PROTOCOL, string] };
  }

  async get(sessionId: string, ownerSessionId: string | null): Promise<{ session: VoiceSessionView; turns: VoiceTurnView[] }> {
    const session = await this.authorizedSession(sessionId, ownerSessionId);
    const turns = await this.prisma.voiceTurn.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
    return { session: this.view(session), turns: turns.map(turn => ({ id: turn.id, sessionId: turn.sessionId, status: turn.status as VoiceTurnView["status"], transcript: turn.transcript, userMessageId: turn.userMessageId, runId: turn.runId, assistantMessageIds: turn.assistantMessageIds, generation: turn.generation, createdAt: turn.createdAt.toISOString(), completedAt: turn.completedAt?.toISOString() ?? null })) };
  }

  async issueReconnectTicket(sessionId: string, ownerSessionId: string | null, origin: string | null) {
    const session = await this.authorizedSession(sessionId, ownerSessionId);
    if (["ended", "failed", "closing"].includes(session.status)) throw new ApiError(409, "voice_session_ended", "Voice session has ended");
    return this.ticketView(session, origin);
  }

  async end(sessionId: string, ownerSessionId: string | null, reason = "stop") {
    await this.authorizedSession(sessionId, ownerSessionId);
    await this.closeSession(sessionId, reason);
    return { ok: true };
  }

  async upgrade(request: Request, server: Server<VoiceConnectionData>, sessionId: string) {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
    const token = protocols.find(value => value.startsWith("ticket."));
    const ticket = token ? this.tickets.get(token) : undefined;
    if (token) this.tickets.delete(token);
    if (!ticket || !protocols.includes(VOICE_PROTOCOL) || ticket.sessionId !== sessionId || ticket.expiresAt <= Date.now() || ticket.origin !== nativeOrigin(request.headers.get("origin"))) return new Response("Voice access denied", { status: 403 });
    const session = await this.prisma.voiceSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt <= new Date() || ["ended", "failed"].includes(session.status)) return new Response("Voice session has ended", { status: 409 });
    const previous = this.connections.get(sessionId);
    await previous?.close(1000, "Voice session reconnected");
    let inputCodec: NativeOpusCodec | null = null;
    let outputCodec: NativeOpusCodec | null = null;
    let stt: StreamingStt | null = null;
    let activeTts: StreamingTts | null = null;
    let ttsChain = Promise.resolve();
    // Narration waiting in the chain that has not begun speaking. A real answer drops these;
    // a narration that already started is always read to the end.
    const queuedNarrations = new Set<{ dropped: boolean }>();
    let currentTurn: { id: string; startedAt: number } | null = null;
    let finalSttText = "";
    let echoCancellation = true;
    const vad = new VoiceVad();
    const preroll = new PcmPreroll();
    const provider = this.providers.get(providerId(session.provider));
    const sessionProvider = providerId(session.provider);
    const language = this.settings.runtime(sessionProvider).language;
    // One synthesis connection is kept open ahead of time so the first spoken line skips the handshake.
    const ttsPool = new WarmTtsPool(() => provider.tts({ language, voice: session.voice || this.settings.runtime(sessionProvider).voice }));
    const startStt = async () => {
      if (stt) return stt;
      stt = await provider.stt({ language });
      stt.onResult((event) => {
        if (!currentTurn || event.isFinal) {
          if (event.isFinal) finalSttText = event.text;
          return;
        }
        connection.send({ type: "transcript.partial", turnId: currentTurn.id, text: event.text, isFinal: false });
      });
      return stt;
    };
    const finishTurn = async () => {
      const turn = currentTurn;
      if (!turn) return;
      currentTurn = null;
      const currentStt = stt;
      stt = null;
      const result = await currentStt?.finish().catch(() => null);
      const text = (finalSttText || result?.text || "").trim();
      finalSttText = "";
      if (!text || !isMeaningfulTranscript(text)) {
        // Noise or a stray sound: drop it and clear the partial text the client was showing.
        if (text) console.info(JSON.stringify({ event: "voice.turn_discarded", sessionId, turnId: turn.id, reason: "not_meaningful", characters: text.length, durationMs: Date.now() - turn.startedAt }));
        connection.send({ type: "transcript.partial", turnId: turn.id, text: "", isFinal: false });
        return;
      }
      connection.send({ type: "transcript.final", turnId: turn.id, text, isFinal: true });
      await this.acceptTranscript({
        sessionId,
        turnId: turn.id,
        text,
        durationMs: Date.now() - turn.startedAt,
        onReply: (text, _generation, kind) => speak(text, connection.media.currentGeneration, kind),
      }, session.ownerSessionId);
    };
    const cancelTts = async () => {
      const stream = activeTts;
      activeTts = null;
      await stream?.cancel().catch(() => undefined);
    };
    const speak = (text: string, generation: number, kind: "answer" | "narration" = "answer") => {
      const narration = kind === "narration" ? { dropped: false } : null;
      if (narration) queuedNarrations.add(narration);
      else for (const queued of queuedNarrations) queued.dropped = true;
      ttsChain = ttsChain.catch(() => undefined).then(async () => {
        if (narration) {
          queuedNarrations.delete(narration);
          if (narration.dropped) return;
        }
        if (!outputCodec || generation !== connection.media.currentGeneration) return;
        // A warmed connection may have gone stale while idle; if it fails before any audio, retry once on a fresh one.
        for (let attempt = 0; attempt < 2; attempt += 1) {
        const { stream, warmed } = attempt === 0
          ? await ttsPool.take()
          : { stream: await provider.tts({ language, voice: session.voice || this.settings.runtime(sessionProvider).voice }), warmed: false };
        activeTts = stream;
        let started = false;
        try {
          await stream.writeText(text);
          await stream.end();
          let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
          for await (const chunk of stream.audio) {
            if (generation !== connection.media.currentGeneration) return;
            pending = concatBytes(pending, chunk);
            while (pending.byteLength >= 960) {
              const pcm = new Int16Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + 960));
              pending = pending.slice(960);
              const packet = await outputCodec.encode(pcm);
              if (!started) {
                started = true;
                connection.send({ type: "audio.started", turnId: "", generation });
              }
              await connection.queueAudio(packet, Date.now());
            }
          }
          if (pending.byteLength > 0 && generation === connection.media.currentGeneration) {
            const padded = new Uint8Array(960);
            padded.set(pending);
            await connection.queueAudio(await outputCodec.encode(new Int16Array(padded.buffer)), Date.now());
          }
          return;
        } catch (error) {
          if (warmed && !started && attempt === 0 && generation === connection.media.currentGeneration) continue;
          // A rejected synthesis request must reach the user instead of leaving a silent call.
          connection.send({ type: "error", code: "voice_tts_failed", message: error instanceof Error ? error.message : "Voice synthesis failed", retryable: true });
          return;
        } finally {
          if (activeTts === stream) activeTts = null;
        }
        }
      });
      return ttsChain;
    };
    const connection = new VoiceSessionConnection({
      sessionId,
      onHello: async echoCancellation => {
        try {
          inputCodec = new NativeOpusCodec(VOICE_INPUT_SAMPLE_RATE);
          outputCodec = new NativeOpusCodec(VOICE_OUTPUT_SAMPLE_RATE);
        } catch (error) {
          connection.send({ type: "error", code: "voice_codec_unavailable", message: error instanceof Error ? error.message : "Voice codec is unavailable", retryable: false });
          await connection.close(1011, "Voice codec unavailable");
          return;
        }
        echoCancellation = echoCancellation !== false;
        this.echoes.set(sessionId, echoCancellation);
        ttsPool.warm();
        await this.prisma.voiceSession.update({ where: { id: sessionId }, data: { status: "active" } });
        connection.send({ type: "ready", input: voiceInputConfig(), output: voiceOutputConfig(), echoCancellation });
      },
      onControl: async message => {
        if (message.type === "ping") connection.send({ type: "pong" });
        if (message.type === "playback.ack") {
          connection.acknowledgePlayback(message.generation, message.frameSequence);
        }
        if (message.type === "stop") await this.closeSession(sessionId, "stop");
        if (message.type === "cancel_turn" && message.turnId) await this.cancelTurn(sessionId, message.turnId);
      },
      onInputFrame: async bytes => {
        const frame = decodeVoiceFrame(bytes, "input");
        if (!inputCodec) throw new Error("Voice codec is not ready");
        const pcm = await inputCodec.decode(frame.payload);
        const sttPcm = resamplePcm16(pcm, VOICE_INPUT_SAMPLE_RATE, 16_000);
        const events = vad.observe(sttPcm, connection.media.bufferedMs > 0, echoCancellation);
        let turnOpened = false;
        for (const event of events) {
          if (event.type === "barge_in") {
            const generation = connection.stopOutputGeneration();
            await cancelTts();
            connection.send({ type: "barge_in", turnId: currentTurn?.id ?? "", generation });
            connection.send({ type: "audio.stopped", generation, reason: "barge_in" });
            vad.reset();
            continue;
          }
          if (event.type === "started") {
            currentTurn = { id: crypto.randomUUID(), startedAt: Date.now() };
            finalSttText = "";
            turnOpened = true;
            connection.send({ type: "turn.started", turnId: currentTurn.id });
            // The user is speaking, so a reply is coming; make sure a connection is ready for it.
            ttsPool.warm();
            await startStt();
          }
          if (event.type === "ended") await finishTurn();
        }
        if (currentTurn) {
          const currentStt = await startStt();
          // The turn opens a few hundred ms after speech began; send that lead-in first.
          if (turnOpened) for (const buffered of preroll.drain()) await currentStt.pushPcm(buffered);
          await currentStt.pushPcm(sttPcm);
        } else {
          preroll.push(sttPcm);
        }
      },
      onClose: async () => {
        await stt?.cancel().catch(() => undefined);
        ttsPool.close();
        await cancelTts();
        await inputCodec?.close();
        await outputCodec?.close();
        inputCodec = null;
        outputCodec = null;
        if (this.connections.get(sessionId) === connection) this.connections.delete(sessionId);
      },
    });
    this.connections.set(sessionId, connection);
    const data: VoiceConnectionData = { sessionId, connection };
    if (server.upgrade(request, { data, headers: { "sec-websocket-protocol": VOICE_PROTOCOL } })) return;
    this.connections.delete(sessionId);
    return new Response("WebSocket upgrade required", { status: 400 });
  }

  websocket(): WebSocketHandler<VoiceConnectionData> { return VoiceSessionConnection.handler(); }

  async acceptTranscript(input: { sessionId: string; turnId?: string; text: string; durationMs: number; language?: string; onReply?: (text: string, generation: number, kind: "answer" | "narration") => Promise<void> }, ownerSessionId: string | null) {
    const session = await this.authorizedSession(input.sessionId, ownerSessionId);
    const text = input.text.trim().slice(0, 20_000);
    if (!text) return { accepted: false, reason: "empty_transcript" };
    const turn = await this.prisma.voiceTurn.create({ data: { ...(input.turnId ? { id: input.turnId } : {}), sessionId: session.id, status: "processing", transcript: text, durationMs: input.durationMs, language: input.language, providerMetadata: { provider: session.provider } } });
    const clientId = `voice:${session.id}:${turn.id}`;
    try {
      const response = await Effect.runPromise(this.channels.sendDirectMessage(session.conversationId, { content: text, clientId, voice: voiceMessageMetadata({ sessionId: session.id, turnId: turn.id, durationMs: input.durationMs, provider: providerId(session.provider), language: input.language }) }));
      const accepted = response as { message?: { id?: string }; run?: { id?: string } };
      const userMessageId = accepted.message?.id ?? null;
      const runId = accepted.run?.id ?? null;
      await this.prisma.voiceTurn.update({ where: { id: turn.id }, data: { userMessageId, runId, status: "speaking" } });
      if (runId) {
        this.replies.register(runId, this.replySink(session.id, turn.id, runId, input.onReply));
        const runs = this.sessionRuns.get(session.id) ?? new Set<string>();
        runs.add(runId);
        this.sessionRuns.set(session.id, runs);
        await this.replies.reconcileRun(runId);
      }
      return { accepted: true, turnId: turn.id, userMessageId, runId };
    } catch (error) {
      await this.prisma.voiceTurn.update({ where: { id: turn.id }, data: { status: "failed", completedAt: new Date() } });
      throw error;
    }
  }

  private replySink(sessionId: string, turnId: string, runId: string, onReply?: (text: string, generation: number, kind: "answer" | "narration") => Promise<void>) {
    let answered = false;
    return { deliverReply: async ({ messageId, content, metadata }: { turnId: string; messageId: string; content: string; metadata: unknown }) => {
      const narration = (metadata as { type?: unknown } | null)?.type === "voice-narration";
      // Narration that arrives after the real answer is stale: it stays in the chat but is not spoken.
      if (narration && answered) return;
      if (!narration) answered = true;
      const turn = await this.prisma.voiceTurn.findUnique({ where: { id: turnId } });
      if (!turn || turn.runId !== runId || turn.assistantMessageIds.includes(messageId)) return;
      const turnGeneration = (turn.generation + 1) >>> 0;
      await this.prisma.voiceTurn.update({ where: { id: turn.id }, data: { assistantMessageIds: { push: messageId }, generation: turnGeneration, status: "speaking" } });
      const connection = this.connections.get(sessionId);
      const outputGeneration = connection?.media.currentGeneration ?? turnGeneration;
      if (connection) connection.send({ type: "reply.message", turnId, messageId, text: content, generation: outputGeneration });
      if (onReply) await onReply(content, outputGeneration, narration ? "narration" : "answer");
    }, reconcileRun: async () => this.replies.reconcileRun(runId) };
  }

  async onVisibleMessage(runId: string, messageId: string) { await this.replies.onVisibleMessage(runId, messageId); }

  private async cancelTurn(sessionId: string, turnId: string) {
    const turn = await this.prisma.voiceTurn.findFirst({ where: { id: turnId, sessionId } });
    if (!turn || !turn.runId) return;
    await this.runs.cancel(turn.runId);
    await this.prisma.voiceTurn.update({ where: { id: turn.id }, data: { status: "interrupted", completedAt: new Date() } });
  }

  private async closeSession(sessionId: string, reason: string) {
    const connection = this.connections.get(sessionId);
    await connection?.close(1000, reason);
    for (const runId of this.sessionRuns.get(sessionId) ?? []) this.replies.unregister(runId);
    this.sessionRuns.delete(sessionId);
    await this.prisma.voiceSession.updateMany({ where: { id: sessionId, status: { notIn: ["ended", "failed"] } }, data: { status: "ended", endedAt: new Date(), closeReason: reason } });
  }
}

function resamplePcm16(samples: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate === outputRate) return samples;
  const length = Math.max(1, Math.round(samples.length * outputRate / inputRate));
  const result = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * inputRate / outputRate;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    result[index] = Math.round(samples[left]! * (1 - fraction) + samples[right]! * fraction);
  }
  return result;
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
