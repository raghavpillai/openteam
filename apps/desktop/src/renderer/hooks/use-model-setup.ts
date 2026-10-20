import type {
  InferenceProviderAuthSessionView,
  InferenceTestResult,
  PiReasoningLevel,
  ServerSettingsView,
} from "@openteam/contracts/inference";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../client/openteam-api";
import { providerName } from "../lib/provider-names";
import {
  keyRejected,
  MODEL_TEST_DEADLINE_MS,
  modelTestErrorMessage,
  requestErrorMessage,
  timedOut,
  withDeadline,
} from "../lib/request-errors";
import { requestRuntimeRefresh } from "../lib/runtime-refresh";

export type ModelTestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "passed"; latencyMs: number }
  /** `rejected`: the provider turned the key or sign-in down. */
  | { status: "failed"; error: string; rejected?: boolean };

export type ModelSelection = { providerId: string; modelId: string; reasoning: PiReasoningLevel };

/**
 * What a load selects for `providerId`: the saved model when it's the saved provider,
 * otherwise the provider's recommended model, which its catalog lists first.
 */
const selectionFor = (next: ServerSettingsView, providerId: string): ModelSelection => {
  const saved = next.inference.providerId === providerId ? next.inference.modelId : "";
  const modelId =
    saved ||
    next.models.find((candidate) => candidate.recommended)?.modelId ||
    next.models[0]?.modelId ||
    "";
  const details = next.models.find((candidate) => candidate.modelId === modelId);
  const reasoning =
    saved && saved === modelId
      ? next.inference.reasoning
      : (details?.defaultReasoningLevel ?? next.inference.reasoning);
  return { providerId, modelId, reasoning };
};

/** Providers people usually mean, in the order onboarding offers them. */
export const FEATURED_PROVIDERS = [
  { id: "openai-codex", title: "ChatGPT", detail: "Sign in with your ChatGPT plan" },
  { id: "claude-code", title: "Claude", detail: "Sign in with your Claude plan" },
  { id: "openai", title: "OpenAI API key", detail: "Pay as you go with an OpenAI key" },
  { id: "anthropic", title: "Anthropic API key", detail: "Pay as you go with an Anthropic key" },
  { id: "openrouter", title: "OpenRouter", detail: "Many models with one OpenRouter account" },
] as const;

const terminal = (session: InferenceProviderAuthSessionView | null) =>
  !session || ["connected", "failed", "cancelled"].includes(session.status);

const localRedirect = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/**
 * Connects a model provider, chooses a model, and proves it works with one real
 * request. Shared by onboarding and Settings → Server.
 */
export function useModelSetup() {
  const [data, setData] = useState<ServerSettingsView | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoning, setReasoning] = useState<PiReasoningLevel>("medium");
  const [authSession, setAuthSession] = useState<InferenceProviderAuthSessionView | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ModelTestState>({ status: "idle" });
  const [capture, setCapture] = useState<"idle" | "waiting" | "unavailable">("idle");
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const answeredPrompts = useRef(new Set<string>());
  const capturedSessions = useRef(new Set<string>());
  const currentSession = useRef<string | null>(null);
  currentSession.current = authSession?.id ?? null;

  const load = useCallback(async (requestedProvider?: string) => {
    const next = await withDeadline((signal) => api.serverSettings(requestedProvider, signal));
    setData(next);
    const selection = selectionFor(next, requestedProvider ?? next.inference.providerId);
    setProviderId(selection.providerId);
    setModelId(selection.modelId);
    setReasoning(selection.reasoning);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    load()
      .catch((cause) => {
        if (active)
          setError(requestErrorMessage(cause, "Couldn't load your AI settings. Try again."));
      })
      .finally(() => active && setBusy(null));
    return () => {
      active = false;
    };
  }, [load]);

  // The first load can run while the server is still starting, so screens can ask again.
  const reload = useCallback(async () => {
    setBusy("load");
    setError(null);
    try {
      await load();
    } catch (cause) {
      setError(requestErrorMessage(cause, "Couldn't load your AI settings. Try again."));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const respond = useCallback(
    async (promptId: string, value: string) => {
      if (!authSession || !value) return;
      setBusy("respond");
      setError(null);
      try {
        setAuthSession(await api.respondToInferenceProviderAuth(authSession.id, promptId, value));
      } catch (cause) {
        setError(requestErrorMessage(cause, "Couldn't continue the sign-in. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [authSession]
  );

  // Poll the sign-in and take the steps a person would otherwise do by hand.
  useEffect(() => {
    if (!authSession || terminal(authSession)) return;
    let active = true;
    const prompt = authSession.prompt;
    if (
      prompt?.type === "select" &&
      !answeredPrompts.current.has(prompt.id) &&
      prompt.options?.some((option) => option.id === "browser") &&
      prompt.options.some((option) => option.id === "device_code")
    ) {
      answeredPrompts.current.add(prompt.id);
      void respond(prompt.id, window.openteam?.providerSignIn ? "browser" : "device_code");
    }
    const redirect = prompt?.type === "manual_code" ? localRedirect(prompt.placeholder) : null;
    const bridge = window.openteam?.providerSignIn;
    if (
      prompt &&
      redirect &&
      authSession.authorizationUrl &&
      bridge &&
      !capturedSessions.current.has(authSession.id)
    ) {
      capturedSessions.current.add(authSession.id);
      setCapture("waiting");
      const sessionId = authSession.id;
      void bridge.capture(authSession.authorizationUrl, redirect).then((result) => {
        // Polling replaces the session object every second; only a new sign-in makes this stale.
        if (currentSession.current !== sessionId) return;
        if (result.status === "captured") {
          setCapture("idle");
          void respond(prompt.id, result.callbackUrl);
        } else if (result.status === "unavailable") {
          setCapture("unavailable");
          setCaptureMessage(result.message);
        } else {
          setCapture("idle");
        }
      });
    }
    let failures = 0;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.inferenceProviderAuthSession(authSession.id);
        if (!active) return;
        setAuthSession(next);
      } catch (cause) {
        if (!active) return;
        const message = requestErrorMessage(cause, "Couldn't check the sign-in.");
        // A server restart forgets sign-ins; end this one instead of polling it forever.
        failures += 1;
        if (failures >= 3 || /not found/i.test(message)) {
          setAuthSession({
            ...authSession,
            status: "failed",
            prompt: null,
            error: /not found/i.test(message)
              ? "Your server stopped this sign-in, for example by restarting. Try again."
              : message,
          });
        } else setError(message);
      }
    }, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [authSession, load, respond]);

  // A finished sign-in no longer needs the local redirect listener, and a connected
  // provider's models load whether polling or a prompt answer reported it.
  const finishedSession = authSession && terminal(authSession) ? authSession : null;
  useEffect(() => {
    if (!finishedSession) return;
    void window.openteam?.providerSignIn?.cancel();
    setCapture("idle");
    if (finishedSession.status === "connected") {
      load(finishedSession.providerId).catch((cause) =>
        setError(requestErrorMessage(cause, "Couldn't load this provider's models. Try again."))
      );
    }
  }, [finishedSession?.id, finishedSession?.status]);

  const provider = useMemo(
    () => data?.providers.find((candidate) => candidate.id === providerId) ?? null,
    [data, providerId]
  );
  const selectedModel = data?.models.find((model) => model.modelId === modelId);
  const reasoningLevels = selectedModel?.reasoningLevels ?? [];
  const effectiveReasoning = reasoningLevels.includes(reasoning)
    ? reasoning
    : (selectedModel?.defaultReasoningLevel ?? "off");
  const saved = data?.inference;
  const changed = Boolean(
    saved &&
      (saved.providerId !== providerId ||
        saved.modelId !== modelId ||
        saved.reasoning !== effectiveReasoning)
  );

  const resetSignIn = () => {
    void window.openteam?.providerSignIn?.cancel();
    setCapture("idle");
    setCaptureMessage(null);
  };

  // The server allows one sign-in per provider, so a new one waits for the old one to stop.
  const cancelling = useRef<Promise<unknown>>(Promise.resolve());
  const cancelSignIn = useCallback(() => {
    resetSignIn();
    if (authSession && !terminal(authSession)) {
      cancelling.current = api.cancelInferenceProviderAuth(authSession.id).catch(() => {});
    }
    setAuthSession(null);
    setError(null);
    return cancelling.current;
  }, [authSession]);

  const selectProvider = async (nextProviderId: string) => {
    if (nextProviderId === providerId && data) return;
    cancelSignIn();
    setError(null);
    setTest({ status: "idle" });
    setProviderId(nextProviderId);
    setBusy("provider");
    try {
      await load(nextProviderId);
    } catch (cause) {
      setError(requestErrorMessage(cause, "Couldn't load this provider's models. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const selectModel = (nextModelId: string) => {
    setModelId(nextModelId);
    setTest({ status: "idle" });
    const model = data?.models.find((candidate) => candidate.modelId === nextModelId);
    if (model && !model.reasoningLevels.includes(reasoning)) {
      setReasoning(model.defaultReasoningLevel);
    }
  };

  /** Starts a sign-in and returns it, or null when it couldn't start (see error). */
  const connect = async (
    authType = provider?.authMethods[0]?.type
  ): Promise<InferenceProviderAuthSessionView | null> => {
    if (!provider || !authType) return null;
    resetSignIn();
    setBusy("connect");
    setError(null);
    setTest({ status: "idle" });
    try {
      await cancelling.current;
      const session = await api.startInferenceProviderAuth(provider.id, authType);
      setAuthSession(session);
      return session;
    } catch (cause) {
      setError(requestErrorMessage(cause, "Couldn't start the sign-in. Try again."));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!provider) return;
    setBusy("disconnect");
    setError(null);
    setTest({ status: "idle" });
    try {
      await api.disconnectInferenceProvider(provider.id);
      setAuthSession(null);
      await load(provider.id);
      requestRuntimeRefresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, "Couldn't disconnect this provider. Try again."));
    } finally {
      setBusy(null);
    }
  };

  // The provider as people know it ("ChatGPT", not "OpenAI Codex").
  const nameOf = (id: string) =>
    providerName(id, data?.providers.find((candidate) => candidate.id === id)?.name);

  /** Tests the saved model with one real request; resolves to how it went. */
  const runTest = async (testedProvider = providerId): Promise<ModelTestState> => {
    setTest({ status: "running" });
    let outcome: ModelTestState;
    try {
      const result: InferenceTestResult = await withDeadline(
        (signal) => api.testInferenceSettings(undefined, signal),
        MODEL_TEST_DEADLINE_MS
      );
      outcome = result.ok
        ? { status: "passed", latencyMs: result.latencyMs }
        : {
            status: "failed",
            error: modelTestErrorMessage(result.error, nameOf(result.providerId)),
            rejected: keyRejected(result.error),
          };
    } catch (cause) {
      outcome = {
        status: "failed",
        error: timedOut(cause)
          ? `${nameOf(testedProvider)} didn't answer in time. Try again.`
          : requestErrorMessage(cause, "Couldn't test the model. Try again."),
      };
    }
    setTest(outcome);
    return outcome;
  };

  /**
   * Saves the selection (or `selection`, when the caller has just loaded it), then sends one
   * real request so problems show up now.
   */
  const apply = async (selection?: ModelSelection): Promise<ModelTestState> => {
    const chosen = selection ?? { providerId, modelId, reasoning: effectiveReasoning };
    if (!chosen.providerId || !chosen.modelId) return test;
    setBusy("save");
    setError(null);
    try {
      await withDeadline(() => api.updateInferenceSettings(chosen));
      await load(chosen.providerId);
      requestRuntimeRefresh();
    } catch (cause) {
      // Reported as a failed test, so the screen showing the test offers Try again.
      const failed: ModelTestState = {
        status: "failed",
        error: requestErrorMessage(cause, "Couldn't save the model. Try again."),
      };
      setTest(failed);
      setBusy(null);
      return failed;
    }
    const outcome = await runTest(chosen.providerId);
    setBusy(null);
    requestRuntimeRefresh();
    return outcome;
  };

  /**
   * Loads a provider's details and models now, for a screen that acts on the result
   * (checking a key); resolves to them and the model they select, or why they didn't load.
   */
  const loadProvider = async (
    nextProviderId: string
  ): Promise<{ data: ServerSettingsView; selection: ModelSelection } | { error: string }> => {
    setBusy("provider");
    setError(null);
    try {
      const next = await load(nextProviderId);
      return { data: next, selection: selectionFor(next, nextProviderId) };
    } catch (cause) {
      return {
        error: requestErrorMessage(cause, "Couldn't load this provider's models. Try again."),
      };
    } finally {
      setBusy(null);
    }
  };

  return {
    data,
    provider,
    providerId,
    modelId,
    selectedModel,
    reasoningLevels,
    effectiveReasoning,
    authSession,
    capture,
    captureMessage,
    busy,
    error,
    test,
    changed,
    selectProvider,
    selectModel,
    setReasoning,
    connect,
    respond,
    cancelSignIn,
    clearSignIn: () => setAuthSession(null),
    disconnect,
    apply,
    runTest,
    reload,
    loadProvider,
  };
}

export type ModelSetup = ReturnType<typeof useModelSetup>;
