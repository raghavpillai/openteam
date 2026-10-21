import { useModelSetup } from "../../../hooks/use-model-setup";
import { providerName } from "../../../lib/provider-names";
import { LoadingOrb } from "../../ui/loading-orb";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { ModelTestStatus, primaryButton, secondaryButton, SignInProgress } from "../model-setup";
import { ProviderMark } from "../setup/provider-marks";
import { SettingsGroup, SettingsRow } from "./ui";

const selectTrigger =
  "h-7 rounded-[8px] border-black/[0.055] bg-black/[0.035] px-2 text-[12px] shadow-none dark:border-white/[0.07] dark:bg-white/[0.07]";

const reasoningLabel = (value: string): string =>
  value === "off"
    ? "Off"
    : value === "xhigh"
      ? "Extra high"
      : `${value[0]?.toUpperCase()}${value.slice(1)}`;

export default function ModelSettings() {
  const setup = useModelSetup();
  const { data, provider, busy } = setup;
  const working = Boolean(busy) || setup.test.status === "running";
  const signingIn = Boolean(setup.authSession);

  return (
    <>
      <p className="mb-5 text-[13px] text-foreground-secondary">
        Choose the AI provider and model for all bots on this server.
      </p>
      <SettingsGroup>
        <SettingsRow
          anchors={["inference-provider"]}
          control={
            <Select
              disabled={!data || working}
              onValueChange={(value) => void setup.selectProvider(value)}
              value={setup.providerId}
            >
              <SelectTrigger aria-label="Provider" className={`${selectTrigger} w-[210px]`}>
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                {(data?.providers ?? []).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      {/* Names line up whether or not the provider has a mark. */}
                      <span className="grid size-3.5 shrink-0 place-items-center">
                        <ProviderMark id={candidate.id} />
                      </span>
                      <span className="truncate">{providerName(candidate.id, candidate.name)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          description="The account your bots use to think. Sign-ins and keys stay on your server."
          title="Provider"
        />
        <SettingsRow
          control={
            provider?.connected ? (
              <button
                className={secondaryButton}
                disabled={working || signingIn}
                onClick={() => void setup.disconnect()}
                type="button"
              >
                Disconnect
              </button>
            ) : (
              <div className="flex items-center gap-2">
                {(provider?.authMethods ?? []).map((method) => (
                  <button
                    className={primaryButton}
                    disabled={working || signingIn}
                    key={method.type}
                    onClick={() => void setup.connect(method.type)}
                    type="button"
                  >
                    {busy === "connect" ? <LoadingOrb aria-hidden inverse size={14} /> : null}
                    {method.type === "oauth" ? "Sign in" : "Add API key"}
                  </button>
                ))}
              </div>
            )
          }
          description={
            provider?.connected
              ? provider.authType === "oauth"
                ? `Signed in with your ${providerName(provider.id, provider.name)} account.`
                : /env/i.test(provider.authSource ?? "")
                  ? "Using an API key from the server's environment."
                  : "Connected with an API key."
              : "Not connected."
          }
          title="Connection"
        />
        {signingIn ? <SignInProgress setup={setup} /> : null}
        <SettingsRow
          anchors={["inference-model"]}
          control={
            <Select
              disabled={working || !provider?.connected || !data?.models.length}
              onValueChange={setup.selectModel}
              value={setup.modelId}
            >
              <SelectTrigger aria-label="Model" className={`${selectTrigger} w-[250px]`}>
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
          description={provider?.modelMessage ?? "Used for every bot's work and background tasks."}
          title="Model"
        />
        <SettingsRow
          anchors={["inference-reasoning"]}
          control={
            <Select
              disabled={working || !setup.selectedModel?.reasoning}
              onValueChange={(value) =>
                setup.setReasoning(value as typeof setup.effectiveReasoning)
              }
              value={setup.effectiveReasoning}
            >
              <SelectTrigger aria-label="Reasoning effort" className={`${selectTrigger} w-[130px]`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(setup.reasoningLevels.length ? setup.reasoningLevels : ["off"]).map((level) => (
                  <SelectItem key={level} value={level}>
                    {reasoningLabel(level)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          description={
            setup.selectedModel?.reasoning
              ? "Higher effort is slower but more careful."
              : "This model doesn't offer reasoning levels."
          }
          title="Reasoning effort"
        />
        <div className="flex min-h-[52px] items-center justify-between gap-3 border-t border-black/[0.065] py-2 dark:border-white/[0.07]">
          <div className="min-w-0 text-[12px] text-foreground-secondary">
            {setup.test.status !== "idle" ? (
              <ModelTestStatus test={setup.test} />
            ) : data?.inference.modelId ? (
              `In use: ${providerName(data.inference.providerId, data.providers.find((p) => p.id === data.inference.providerId)?.name)} · ${data.models.find((m) => m.modelId === data.inference.modelId)?.name ?? data.inference.modelId}`
            ) : data ? (
              "No model chosen yet. Bots can't reply until you choose one."
            ) : (
              "Loading…"
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {setup.test.status === "failed" &&
            provider?.connected &&
            provider.authType === "oauth" &&
            !signingIn ? (
              // A plan sign-in that expired is fixed by signing in again, not by disconnecting.
              <button
                className={secondaryButton}
                disabled={working}
                onClick={() => void setup.connect("oauth")}
                type="button"
              >
                Sign in again
              </button>
            ) : null}
            <button
              className={secondaryButton}
              disabled={
                setup.changed ||
                !data?.inference.modelId ||
                working ||
                setup.test.status === "running"
              }
              onClick={() => void setup.runTest()}
              type="button"
            >
              Test
            </button>
            <button
              className={primaryButton}
              disabled={!setup.changed || !provider?.connected || !setup.selectedModel || working}
              onClick={() => void setup.apply()}
              type="button"
            >
              {busy === "save" ? <LoadingOrb aria-hidden inverse size={14} /> : null}
              Apply
            </button>
          </div>
        </div>
      </SettingsGroup>
      {setup.error ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400" role="alert">
          {setup.error}
          {!data ? (
            <button
              className={secondaryButton}
              disabled={working}
              onClick={() => void setup.reload()}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
