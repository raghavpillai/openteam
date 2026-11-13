import { Button } from "../../ui/button";
import { SettingsSelectContent } from "./select-content";
import { useModelSetup } from "../../../hooks/use-model-setup";
import { providerName } from "../../../lib/provider-names";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { ModelTestStatus, SignInProgress } from "../model-setup";
import { ModelPicker } from "../setup/model-picker";
import { ProviderMark } from "../setup/provider-marks";
import {
  SettingsGroup,
  SettingsRow,
  SettingsIntro,
  SettingsReveal,
  SkeletonControl,
  SkeletonText,
  settingsPrimaryButton,
  settingsSecondaryButton,
  settingsSelect,
  settingsRow,
  settingsInput,
} from "./ui";

const selectTrigger = settingsSelect;

const reasoningLabel = (value: string): string =>
  value === "off"
    ? "Off"
    : value === "xhigh"
      ? "Extra high"
      : `${value[0]?.toUpperCase()}${value.slice(1)}`;

export default function ModelSettings() {
  const setup = useModelSetup();
  const { data, provider, busy } = setup;
  // The skeleton covers loading; the controls shouldn't flash disabled as they appear.
  const working = (Boolean(busy) && busy !== "load") || setup.test.status === "running";
  const signingIn = Boolean(setup.authSession);
  // Until the settings arrive, every value is a skeleton of the control it becomes.
  const loading = !data && !setup.error;

  return (
    <>
      <SettingsIntro>Choose the AI provider and model for all bots on this server.</SettingsIntro>
      <SettingsGroup>
        <SettingsRow
          stackControl
          anchors={["inference-provider"]}
          control={
            loading ? (
              <SkeletonControl width={210} />
            ) : (
              <Select
                disabled={!data || working}
                onValueChange={(value) => void setup.selectProvider(value)}
                value={setup.providerId}
              >
                <SelectTrigger
                  aria-label="Provider"
                  className={`${selectTrigger} settings-reveal w-[210px]`}
                >
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SettingsSelectContent>
                  {(data?.providers ?? []).map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        {/* Names line up whether or not the provider has a mark. */}
                        <span className="grid size-3.5 shrink-0 place-items-center">
                          <ProviderMark id={candidate.id} />
                        </span>
                        <span className="truncate">
                          {providerName(candidate.id, candidate.name)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SettingsSelectContent>
              </Select>
            )
          }
          description="The account your bots use to think. Sign-ins and keys stay on your server."
          title="Provider"
        />
        <SettingsRow
          control={
            loading ? (
              <SkeletonControl width={76} />
            ) : provider?.connected ? (
              <Button
                size="xs"
                variant="secondary"
                className={`${settingsSecondaryButton} settings-reveal`}
                disabled={working || signingIn}
                onClick={() => void setup.disconnect()}
                type="button"
              >
                Disconnect
              </Button>
            ) : signingIn ? null : (
              // The sign-in or key form below replaces these while it's open.
              <div className="settings-reveal flex items-center gap-2">
                {(provider?.authMethods ?? []).map((method) => (
                  <Button
                    size="xs"
                    className={settingsPrimaryButton}
                    disabled={working || signingIn}
                    key={method.type}
                    onClick={() => void setup.connect(method.type)}
                    type="button"
                    loading={busy === "connect"}
                  >
                    {method.type === "oauth" ? "Sign in" : "Add API key"}
                  </Button>
                ))}
              </div>
            )
          }
          description={
            loading ? (
              <SkeletonText width={232} />
            ) : provider?.connected ? (
              provider.authType === "oauth" ? (
                `Signed in with your ${providerName(provider.id, provider.name)} account.`
              ) : /env/i.test(provider.authSource ?? "") ? (
                "Using an API key from the server's environment."
              ) : (
                "Connected with an API key."
              )
            ) : (
              "Not connected."
            )
          }
          title="Connection"
        />
        {signingIn ? (
          <SignInProgress
            setup={setup}
            controlStyles={{
              primaryButton: settingsPrimaryButton,
              secondaryButton: settingsSecondaryButton,
              input: settingsInput,
            }}
          />
        ) : null}
        <SettingsRow
          stackControl
          anchors={["inference-model"]}
          control={
            loading ? (
              <SkeletonControl width={250} />
            ) : (
              <SettingsReveal as="div">
                <ModelPicker
                  models={data?.models ?? []}
                  value={setup.modelId}
                  providerName={providerName(setup.providerId, provider?.name)}
                  disabled={working || !provider?.connected || !data?.models.length}
                  onChange={setup.selectModel}
                  variant="settings"
                />
              </SettingsReveal>
            )
          }
          description={provider?.modelMessage ?? "Used for every bot's work and background tasks."}
          title="Model"
        />
        <SettingsRow
          stackControl
          anchors={["inference-reasoning"]}
          control={
            loading ? (
              <SkeletonControl width={130} />
            ) : (
              <Select
                disabled={
                  working || !setup.selectedModel?.reasoning || !setup.reasoningLevels.length
                }
                onValueChange={(value) =>
                  setup.setReasoning(value as typeof setup.effectiveReasoning)
                }
                value={setup.effectiveReasoning}
              >
                <SelectTrigger
                  aria-label="Reasoning effort"
                  className={`${selectTrigger} settings-reveal w-[130px]`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SettingsSelectContent>
                  {(setup.reasoningLevels.length ? setup.reasoningLevels : ["off"]).map((level) => (
                    <SelectItem key={level} value={level}>
                      {!setup.reasoningLevels.length && setup.selectedModel?.reasoning
                        ? "Provider default"
                        : reasoningLabel(level)}
                    </SelectItem>
                  ))}
                </SettingsSelectContent>
              </Select>
            )
          }
          description={
            loading ? (
              <SkeletonText width={244} />
            ) : setup.selectedModel?.reasoning ? (
              setup.reasoningLevels.length ? (
                "Higher effort is slower but more careful."
              ) : (
                "This model manages reasoning automatically."
              )
            ) : (
              "This model doesn't offer reasoning levels."
            )
          }
          title="Reasoning effort"
        />
        <div className={`${settingsRow} flex-wrap justify-between`}>
          <div className="min-w-0 text-[12px] text-foreground-secondary">
            {setup.test.status !== "idle" ? (
              <ModelTestStatus test={setup.test} />
            ) : data?.inference.modelId ? (
              `In use: ${providerName(data.inference.providerId, data.providers.find((p) => p.id === data.inference.providerId)?.name)} · ${data.models.find((m) => m.modelId === data.inference.modelId)?.name ?? data.inference.modelId}`
            ) : data ? (
              "No model chosen yet. Bots can't reply until you choose one."
            ) : loading ? (
              <SkeletonText width={220} />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {setup.test.status === "failed" &&
            provider?.connected &&
            provider.authType === "oauth" &&
            !signingIn ? (
              // A plan sign-in that expired is fixed by signing in again, not by disconnecting.
              <Button
                size="xs"
                variant="secondary"
                className={settingsSecondaryButton}
                disabled={working}
                onClick={() => void setup.connect("oauth")}
                type="button"
              >
                Sign in again
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="secondary"
              className={settingsSecondaryButton}
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
            </Button>
            <Button
              size="xs"
              className={settingsPrimaryButton}
              disabled={!setup.changed || !provider?.connected || !setup.selectedModel || working}
              onClick={() => void setup.apply()}
              type="button"
              loading={busy === "save"}
            >
              Apply
            </Button>
          </div>
        </div>
      </SettingsGroup>
      {setup.error ? (
        <div className="mt-3 px-2 text-[12px] text-red-600 dark:text-red-400" role="alert">
          {setup.error}
          {!data ? (
            <Button
              size="xs"
              variant="secondary"
              className={settingsSecondaryButton}
              disabled={working}
              onClick={() => void setup.reload()}
              type="button"
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
