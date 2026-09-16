import type { InstallationPaths } from "./config";
import { CliError } from "./errors";
import { runInteractiveSession } from "./interactive-session";
import type { CommandRunner } from "./process";
import { createProviderConnectionAPI, runConnectionProcess } from "./provider-connection-api";
import { ProviderConnectionSession } from "./provider-connection-session";

export const connectionLinks = {
  async open(url: string) {
    try {
      const invocation =
        process.platform === "darwin"
          ? { command: "open", args: [url] }
          : process.platform === "win32"
            ? { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
            : { command: "xdg-open", args: [url] };
      await runConnectionProcess(invocation, undefined, 5000);
    } catch {
      throw new CliError(
        "Could not open a browser. Choose Copy sign-in link or Show sign-in link."
      );
    }
  },
  async copy(url: string) {
    try {
      if (process.platform === "darwin")
        await runConnectionProcess({ command: "pbcopy", args: [] }, url, 3000);
      else if (process.platform === "win32")
        await runConnectionProcess({ command: "clip", args: [] }, url, 3000);
      else {
        try {
          await runConnectionProcess({ command: "wl-copy", args: [] }, url, 3000);
        } catch {
          await runConnectionProcess(
            { command: "xclip", args: ["-selection", "clipboard"] },
            url,
            3000
          );
        }
      }
    } catch {
      throw new CliError("Could not copy the link. Choose Show sign-in link to open it manually.");
    }
  },
};

export const providerConnectionCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  provider: string,
  authType: "oauth" | "api_key",
  context: "model" | "provider" = "model"
) => {
  const session = new ProviderConnectionSession(
    provider,
    authType,
    createProviderConnectionAPI(paths, runner),
    connectionLinks,
    undefined,
    context
  );
  try {
    return (await runInteractiveSession(session)) ?? "cancelled";
  } finally {
    await session.dispose();
  }
};
