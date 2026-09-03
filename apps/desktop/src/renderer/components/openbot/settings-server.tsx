import {
  PI_REASONING_LEVELS,
  type InferenceProviderAuthSessionView,
  type ServerSettingsView,
} from "@openbot/contracts/inference";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../client/openbot-api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionLabel, SettingsGroup, SettingsRow } from "./settings-ui";

const actionButton =
  "inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-black px-3 text-[12px] text-white outline-none hover:opacity-80 disabled:opacity-50 dark:bg-white dark:text-black";
const secondaryButton =
  "inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-black/[0.07] px-3 text-[12px] outline-none hover:bg-black/[0.1] disabled:opacity-50 dark:bg-white/[0.09] dark:hover:bg-white/[0.13]";
const inputClass =
  "h-8 min-w-0 flex-1 rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.1]";

const reasoningLabel = (value: string): string =>
  value === "off"
    ? "Off"
    : value === "xhigh"
      ? "Extra high"
      : `${value[0]?.toUpperCase()}${value.slice(1)}`;

export default function ServerSettings() {
  const [data, setData] = useState<ServerSettingsView | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoning, setReasoning] = useState<(typeof PI_REASONING_LEVELS)[number]>("high");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("oauth");
  const [authSession, setAuthSession] = useState<InferenceProviderAuthSessionView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (requestedProvider?: string) => {
    const next = await api.serverSettings(requestedProvider);
    setData(next);
    const selectedProvider = requestedProvider ?? next.inference.providerId;
    setProviderId(selectedProvider);
    setModelId(
      next.inference.providerId === selectedProvider
        ? next.inference.modelId
        : (next.models[0]?.modelId ?? "")
    );
    setReasoning(next.inference.reasoning);
    const provider = next.providers.find((candidate) => candidate.id === selectedProvider);
    setAuthType(provider?.authMethods[0]?.type ?? "api_key");
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    setBusy("load");
    load()
      .catch((cause) => {
        if (active) setError(clientErrorMessage(cause, "Could not load server settings"));
      })
      .finally(() => active && setBusy(null));
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    setPromptValue("");
  }, [authSession?.prompt?.id]);

  useEffect(() => {
    if (!authSession || ["connected", "failed", "cancelled"].includes(authSession.status)) {
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const next = await api.inferenceProviderAuthSession(authSession.id);
        if (!active) return;
        setAuthSession(next);
        if (next.status === "connected") await load(providerId);
      } catch (cause) {
        if (active) setError(clientErrorMessage(cause, "Could not check provider connection"));
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [authSession, load, providerId]);

  const provider = useMemo(
    () => data?.providers.find((candidate) => candidate.id === providerId) ?? null,
    [data, providerId]
  );
  const selectedModel = data?.models.find((model) => model.modelId === modelId);
  const effectiveReasoning = selectedModel?.reasoning ? reasoning : "off";
  const changed = Boolean(
    data &&
      (data.inference.providerId !== providerId ||
        data.inference.modelId !== modelId ||
        data.inference.reasoning !== effectiveReasoning)
  );

  const selectProvider = async (nextProviderId: string) => {
    setError(null);
    setSaved(false);
    if (authSession && !["connected", "failed", "cancelled"].includes(authSession.status)) {
      void api.cancelInferenceProviderAuth(authSession.id);
    }
    setAuthSession(null);
    setProviderId(nextProviderId);
    setBusy("provider");
    try {
      await load(nextProviderId);
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not load provider models"));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!provider) return;
    setBusy("connect");
    setError(null);
    try {
      setAuthSession(await api.startInferenceProviderAuth(provider.id, authType));
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not start provider connection"));
    } finally {
      setBusy(null);
    }
  };

  const respond = async () => {
    if (!authSession?.prompt || !promptValue) return;
    setBusy("respond");
    setError(null);
    try {
      setAuthSession(
        await api.respondToInferenceProviderAuth(authSession.id, authSession.prompt.id, promptValue)
      );
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not continue provider connection"));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!provider) return;
    setBusy("disconnect");
    setError(null);
    try {
      await api.disconnectInferenceProvider(provider.id);
      setAuthSession(null);
      await load(provider.id);
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not disconnect provider"));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!providerId || !modelId) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      await api.updateInferenceSettings({
        providerId,
        modelId,
        reasoning: effectiveReasoning,
      });
      await load(providerId);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1_800);
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not apply inference settings"));
    } finally {
      setBusy(null);
    }
  };

  const prompt = authSession?.prompt;

  return (
    <>
      <SectionLabel>Provider connection</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["inference-provider"]}
          control={
            <Select
              disabled={!data || busy === "provider"}
              onValueChange={(value) => void selectProvider(value)}
              value={providerId}
            >
              <SelectTrigger className="h-7 w-[210px] rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]">
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                {(data?.providers ?? []).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          description="Credentials stay in the server computer's private Pi credential store."
          title="Provider"
        />
        <SettingsRow
          control={
            <div className="flex items-center gap-2">
              <Select
                disabled={!provider || provider.authMethods.length < 2 || Boolean(authSession)}
                onValueChange={(value) => setAuthType(value as "api_key" | "oauth")}
                value={authType}
              >
                <SelectTrigger className="h-7 w-[150px] rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(provider?.authMethods ?? []).map((method) => (
                    <SelectItem key={method.type} value={method.type}>
                      {method.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {provider?.connected ? (
                <button
                  className={secondaryButton}
                  disabled={Boolean(busy)}
                  onClick={() => void disconnect()}
                  type="button"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className={actionButton}
                  disabled={!provider?.authMethods.length || Boolean(busy) || Boolean(authSession)}
                  onClick={() => void connect()}
                  type="button"
                >
                  {busy === "connect" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                  Connect
                </button>
              )}
            </div>
          }
          description={
            provider?.connected
              ? `${provider.authType === "oauth" ? "OAuth" : "API key"} connected${provider.authSource ? ` via ${provider.authSource}` : ""}`
              : "Connect this provider before making it active."
          }
          title="Connection"
        />
        {authSession ? (
          <div className="border-t border-black/[0.065] py-3 dark:border-white/[0.07]">
            <div className="text-[12.5px] text-foreground">
              {authSession.status === "connected"
                ? "Provider connected"
                : authSession.status === "failed"
                  ? "Connection failed"
                  : "Finish connecting"}
            </div>
            {authSession.authorizationUrl ? (
              <button
                className="mt-2 inline-flex items-center gap-1 text-[12px] text-foreground underline underline-offset-2"
                onClick={() =>
                  window.open(authSession.authorizationUrl ?? "", "_blank", "noopener,noreferrer")
                }
                type="button"
              >
                Open authorization page <ExternalLink className="size-3" />
              </button>
            ) : null}
            {authSession.deviceCode ? (
              <div className="mt-2 rounded-[8px] bg-background px-3 py-2 text-[12px]">
                Open {authSession.deviceCode.verificationUri} and enter code{" "}
                <span className="font-mono font-medium">{authSession.deviceCode.userCode}</span>
              </div>
            ) : null}
            {authSession.messages.map((message, index) => (
              <div
                className="mt-1 text-[11.5px] text-foreground-secondary"
                key={`${index}:${message}`}
              >
                {message}
              </div>
            ))}
            {prompt ? (
              <div className="mt-3 flex items-center gap-2">
                {prompt.type === "select" ? (
                  <Select onValueChange={setPromptValue} value={promptValue}>
                    <SelectTrigger className={`${inputClass} w-auto`}>
                      <SelectValue placeholder={prompt.message} />
                    </SelectTrigger>
                    <SelectContent>
                      {(prompt.options ?? []).map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <input
                    aria-label={prompt.message}
                    autoComplete="off"
                    className={inputClass}
                    maxLength={20_000}
                    onChange={(event) => setPromptValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void respond()}
                    placeholder={prompt.placeholder ?? prompt.message}
                    type={prompt.type === "secret" ? "password" : "text"}
                    value={promptValue}
                  />
                )}
                <button
                  className={actionButton}
                  disabled={!promptValue || busy === "respond"}
                  onClick={() => void respond()}
                  type="button"
                >
                  Continue
                </button>
                <button
                  className={secondaryButton}
                  onClick={() => {
                    void api.cancelInferenceProviderAuth(authSession.id);
                    setAuthSession(null);
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {authSession.error ? (
              <div className="mt-2 text-[12px] text-red-600 dark:text-red-400">
                {authSession.error}
              </div>
            ) : null}
            {["connected", "failed", "cancelled"].includes(authSession.status) ? (
              <button
                className={`${secondaryButton} mt-3`}
                onClick={() => setAuthSession(null)}
                type="button"
              >
                {authSession.status === "failed" ? "Try again" : "Done"}
              </button>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>

      <SectionLabel>Model and reasoning</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["inference-model"]}
          control={
            <Select disabled={!data?.models.length} onValueChange={setModelId} value={modelId}>
              <SelectTrigger className="h-7 w-[250px] rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]">
                <SelectValue placeholder="No models available" />
              </SelectTrigger>
              <SelectContent>
                {(data?.models ?? []).map((model) => (
                  <SelectItem key={model.modelId} value={model.modelId}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          description="Applied to new agent turns and server background inference."
          title="Model"
        />
        <SettingsRow
          anchors={["inference-reasoning"]}
          control={
            <Select
              disabled={!selectedModel?.reasoning}
              onValueChange={(value) => setReasoning(value as (typeof PI_REASONING_LEVELS)[number])}
              value={selectedModel?.reasoning ? reasoning : "off"}
            >
              <SelectTrigger className="h-7 w-[130px] rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PI_REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {reasoningLabel(level)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          description={
            selectedModel?.reasoning
              ? "The runtime clamps unsupported levels to the closest model capability."
              : "This model does not expose reasoning controls."
          }
          title="Reasoning effort"
        />
        <div className="flex min-h-[52px] items-center justify-between border-t border-black/[0.065] py-2 dark:border-white/[0.07]">
          <div className="text-[12px] text-foreground-secondary">
            Active: {data ? `${data.inference.providerId}/${data.inference.modelId}` : "Loading…"}
          </div>
          <button
            className={actionButton}
            disabled={!changed || !provider?.connected || !modelId || Boolean(busy)}
            onClick={() => void save()}
            type="button"
          >
            {busy === "save" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : saved ? (
              <Check className="size-3.5" />
            ) : null}
            {saved ? "Applied" : "Apply"}
          </button>
        </div>
      </SettingsGroup>
      {error ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>
      ) : null}
    </>
  );
}
