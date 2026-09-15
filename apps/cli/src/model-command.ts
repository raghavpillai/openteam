import { installationCommand, renderSummary } from "./command-ui";
import { installationExists, type InstallationPaths } from "./config";
import { CLI_VERSION } from "./constants";
import { providerLoginCommand } from "./providers";
import { SystemCommandRunner } from "./process";
import { CliError, errorMessage } from "./errors";
import { runInteractiveSession } from "./interactive-session";
import { ModelSession } from "./model-session";
import { createModelSettingsAPI } from "./model-settings";
import { printMessage } from "./terminal";

export const modelCommand = async (paths: InstallationPaths): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliError(
      "openteam model needs an interactive terminal. Use openteam model list or openteam model use <provider> <model> for scripts; use openteam model --help for details."
    );
  if (process.env.TERM === "dumb")
    throw new CliError(
      "The model editor needs a terminal with cursor support. Open a regular terminal, or use openteam model list and openteam model use <provider> <model>."
    );
  if (!installationExists(paths))
    throw new CliError(
      `OpenTeam is not installed at ${paths.directory}. Run openteam install first, or select an installation with --dir.`
    );
  const session = new ModelSession(createModelSettingsAPI(paths), CLI_VERSION, (provider) =>
    installationCommand(paths, `provider login ${provider}`)
  );
  printMessage("Loading inference and transcription settings…");
  await session.load();
  for (;;) {
    const outcome = await runInteractiveSession(
      session,
      "Model selection cancelled. Unsaved edits were discarded."
    );
    if (!outcome || outcome === true) break;
    let error: string | undefined;
    try {
      await providerLoginCommand(paths, new SystemCommandRunner(), {
        providerId: outcome.connectProvider,
      });
    } catch (cause) {
      error = errorMessage(cause);
    }
    await session.providerConnected(error);
  }
  console.log(
    renderSummary(
      "model",
      "SAVED SETTINGS",
      [
        {
          label: "Inference",
          value: session.savedInference
            ? `${session.savedInference.providerId}/${session.savedInference.modelId}`
            : "Could not load",
        },
        { label: "Thinking", value: session.savedInference?.reasoning ?? "Unknown" },
        {
          label: "Transcription",
          value: session.savedTranscription
            ? session.savedTranscription.enabled
              ? session.savedTranscription.model
              : "Disabled"
            : "Could not load",
        },
      ],
      [{ text: "Only changes confirmed with Save were applied.", tone: "muted" }]
    )
  );
};
