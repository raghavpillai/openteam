import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type InferenceProviderAuthSessionView,
  normalizeInferenceProviderId,
  type ServerInferenceSettings,
} from "@openteam/contracts";
import { ChatProviderRegistry } from "./chat-provider-registry";

interface AuthSessionState extends InferenceProviderAuthSessionView {
  controller: AbortController;
  createdAt: number;
  promptResolver: ((value: string) => void) | null;
  promptRejecter: ((error: Error) => void) | null;
}

const terminalStatus = (status: AuthSessionState["status"]): boolean =>
  status === "connected" || status === "failed" || status === "cancelled";
const MAX_AUTH_SESSIONS = 64;

const sessionView = (session: AuthSessionState): InferenceProviderAuthSessionView => ({
  id: session.id,
  providerId: session.providerId,
  authType: session.authType,
  status: session.status,
  prompt: session.prompt,
  authorizationUrl: session.authorizationUrl,
  deviceCode: session.deviceCode,
  messages: [...session.messages],
  error: session.error,
});

export class InferenceProviderService {
  private readonly sessions = new Map<string, AuthSessionState>();

  constructor(
    private readonly runtime: () => ModelRuntime,
    private readonly modelsPath: string,
    fetchImpl: typeof fetch = fetch
  ) {
    this.registry = new ChatProviderRegistry(this.runtime, this.modelsPath, fetchImpl);
  }

  private readonly registry: ChatProviderRegistry;

  async catalog(providerId?: string) {
    const catalog = await this.registry.catalog(providerId);
    return {
      ...catalog,
      models: catalog.models.map((model) => ({
        providerId: model.provider,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    };
  }

  async verify(settings: ServerInferenceSettings): Promise<void> {
    await this.registry.verify(settings);
  }

  async disconnect(providerId: string): Promise<void> {
    await this.runtime().logout(normalizeInferenceProviderId(providerId));
  }

  startAuthSession(providerId: string, authType: AuthType): InferenceProviderAuthSessionView {
    this.pruneSessions();
    if (this.sessions.size >= MAX_AUTH_SESSIONS) {
      const terminalSessions = [...this.sessions.values()]
        .filter((session) => terminalStatus(session.status))
        .sort((left, right) => left.createdAt - right.createdAt);
      for (const session of terminalSessions) {
        this.sessions.delete(session.id);
        if (this.sessions.size < MAX_AUTH_SESSIONS) break;
      }
    }
    if (this.sessions.size >= MAX_AUTH_SESSIONS) {
      throw new Error("Too many provider connections are in progress");
    }
    const runtime = this.runtime();
    const normalizedProviderId = normalizeInferenceProviderId(providerId);
    const provider = runtime.getProvider(normalizedProviderId);
    if (!provider) throw new Error(`Unknown Pi inference provider: ${normalizedProviderId}`);
    const supported =
      authType === "api_key" ? Boolean(provider.auth.apiKey?.login) : Boolean(provider.auth.oauth);
    if (!supported) {
      throw new Error(`${provider.name} does not support ${authType.replace("_", " ")}`);
    }
    for (const session of this.sessions.values()) {
      if (session.providerId === normalizedProviderId && !terminalStatus(session.status)) {
        throw new Error(`${provider.name} already has a connection in progress`);
      }
    }
    const session: AuthSessionState = {
      id: randomUUID(),
      providerId: normalizedProviderId,
      authType,
      status: "running",
      prompt: null,
      authorizationUrl: null,
      deviceCode: null,
      messages: [],
      error: null,
      controller: new AbortController(),
      createdAt: Date.now(),
      promptResolver: null,
      promptRejecter: null,
    };
    this.sessions.set(session.id, session);
    void this.login(session);
    return sessionView(session);
  }

  authSession(sessionId: string): InferenceProviderAuthSessionView {
    const session = this.requireSession(sessionId);
    return sessionView(session);
  }

  respond(sessionId: string, promptId: string, value: string): InferenceProviderAuthSessionView {
    const session = this.requireSession(sessionId);
    if (!session.prompt || session.prompt.id !== promptId || !session.promptResolver) {
      throw new Error("This provider connection prompt is no longer active");
    }
    const resolve = session.promptResolver;
    session.prompt = null;
    session.promptResolver = null;
    session.promptRejecter = null;
    session.status = "running";
    resolve(value);
    return sessionView(session);
  }

  cancel(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.cancelSession(session);
  }

  private cancelSession(session: AuthSessionState): void {
    if (terminalStatus(session.status)) return;
    session.status = "cancelled";
    session.prompt = null;
    session.controller.abort();
    session.promptRejecter?.(new Error("Provider connection was cancelled"));
    session.promptResolver = null;
    session.promptRejecter = null;
  }

  private async login(session: AuthSessionState): Promise<void> {
    const runtime = this.runtime();
    try {
      await runtime.login(session.providerId, session.authType, {
        signal: session.controller.signal,
        prompt: (prompt) => this.waitForPrompt(session, prompt),
        notify: (event) => this.handleEvent(session, event),
      });
      if (session.controller.signal.aborted) return;
      await runtime.refresh({ allowNetwork: true, providers: [session.providerId] });
      session.status = "connected";
      session.prompt = null;
    } catch (error) {
      if (session.controller.signal.aborted) {
        session.status = "cancelled";
      } else {
        session.status = "failed";
        session.error = error instanceof Error ? error.message : String(error);
      }
      session.prompt = null;
      session.promptResolver = null;
      session.promptRejecter = null;
    }
  }

  private waitForPrompt(session: AuthSessionState, prompt: AuthPrompt): Promise<string> {
    if (session.controller.signal.aborted) {
      return Promise.reject(new Error("Provider connection was cancelled"));
    }
    const promptId = randomUUID();
    session.prompt = {
      id: promptId,
      type: prompt.type,
      message: prompt.message,
      ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === "select" ? { options: [...prompt.options] } : {}),
    };
    session.status = "waiting";
    return new Promise<string>((resolve, reject) => {
      session.promptResolver = resolve;
      session.promptRejecter = reject;
      const abort = () => {
        if (session.prompt?.id !== promptId) return;
        session.prompt = null;
        session.promptResolver = null;
        session.promptRejecter = null;
        reject(new Error("Provider connection prompt was cancelled"));
      };
      prompt.signal?.addEventListener("abort", abort, { once: true });
      session.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private handleEvent(session: AuthSessionState, event: AuthEvent): void {
    if (event.type === "auth_url") {
      session.authorizationUrl = event.url;
      if (event.instructions) session.messages.push(event.instructions);
    } else if (event.type === "device_code") {
      session.deviceCode = {
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: event.expiresInSeconds }),
      };
    } else {
      session.messages.push(event.message);
      if (event.type === "info") {
        for (const link of event.links ?? []) session.messages.push(link.url);
      }
    }
    session.messages = session.messages.slice(-8);
  }

  private requireSession(sessionId: string): AuthSessionState {
    this.pruneSessions();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Provider connection session was not found");
    return session;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const age = now - session.createdAt;
      if (!terminalStatus(session.status) && age > 15 * 60_000) this.cancelSession(session);
      if (terminalStatus(session.status) && age > 30 * 60_000) this.sessions.delete(id);
    }
  }
}
