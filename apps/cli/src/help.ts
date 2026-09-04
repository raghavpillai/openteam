import type { HelpTopic } from "./arguments";
import { CLI_VERSION } from "./constants";

const heading = (usage: string, summary: string): string => `OpenTeam ${CLI_VERSION}

Usage:
  ${usage}

${summary}`;

const helpHint = "  --help, -h            Show this help";
const directoryOption = "  --dir <path>          Use a different installation folder";

const pages: Record<HelpTopic, string> = {
  global: `OpenTeam ${CLI_VERSION}

Usage:
  openteam <command> [options]

Commands:
  install       Set up OpenTeam on this computer
  setup         Change inference or advanced server settings
  status        Show whether OpenTeam is running
  doctor        Check for installation problems
  update        Install the latest OpenTeam release
  start         Start OpenTeam
  stop          Stop OpenTeam
  logs          View troubleshooting logs
  provider      Manage AI accounts and connections
  model         View or change the AI model
  account       Change your username or password
  uninstall     Remove OpenTeam

Global options:
${directoryOption}
  --help, -h            Show help
  --version, -v         Show the CLI version

Run "openteam <command> --help" for command options.`,

  install: `${heading(
    "openteam install [options]",
    "Install the OpenTeam server stack, run guided setup, and wait for it to become healthy."
  )}

Options:
${directoryOption}
  --version <version>   Install a specific release
  --advanced            Show advanced prompts during guided setup
  --no-setup            Skip guided setup for automation
${helpHint}

Advanced release/testing options:
  --repository <owner/repo>  Override the GitHub release repository
  --allow-prerelease        Permit an explicit prerelease target
  --allow-unsigned           Permit unsigned test bundles (unsafe)
  --compose-url <url>        Override the Compose asset URL
  --checksum-url <url>       Override the SHA256SUMS asset URL
  --signature-url <url>      Override the Sigstore bundle asset URL
  --project-name <name>      Override and persist the Compose project name
  --image-prefix <prefix>    Override the container image prefix`,

  setup: `${heading(
    "openteam setup [options]",
    "Change which model account OpenTeam uses, or skip inference for now.\nYour connection and existing sign-in stay unchanged unless you choose advanced setup."
  )}

Options:
${directoryOption}
  --advanced            Also show connection, server, model, and performance settings
${helpHint}`,

  doctor: `${heading(
    "openteam doctor [options]",
    "Check Docker, system resources, ports, configuration, permissions, and readiness."
  )}

Options:
${directoryOption}
  --project-name <name> Override the Compose project name (advanced)
${helpHint}`,

  status: `${heading(
    "openteam status [options]",
    "Show the installed version, connection address, services, and overall health."
  )}

Options:
${directoryOption}
${helpHint}`,

  update: `${heading(
    "openteam update [options]",
    "Safely update the CLI and server stack in one durable job, with health checks and rollback."
  )}

The update continues if the terminal, SSH connection, or Desktop app closes. Running the same
command again reconnects to the active update and resumes high-level progress output. A standalone
CLI stages and verifies the target CLI before updating the server, then installs it only after the
new server is healthy. Desktop uses the CLI bundled with the app and updates that bundle with Desktop.

Options:
${directoryOption}
  --version <version>   Update to a specific release
  --force               Reapply the currently installed release
  --allow-downgrade     Permit an explicit downgrade for recovery
  --allow-prerelease    Permit an explicit prerelease target
${helpHint}

Advanced release/testing options:
  --repository <owner/repo>  Override the GitHub release repository
  --allow-unsigned           Permit unsigned test bundles (unsafe)
  --compose-url <url>        Override the Compose asset URL
  --checksum-url <url>       Override the SHA256SUMS asset URL
  --signature-url <url>      Override the Sigstore bundle asset URL
  --json-progress            Emit machine-readable progress`,

  start: `${heading(
    "openteam start [options]",
    "Start or recreate the installed OpenTeam services and wait for health."
  )}

Options:
${directoryOption}
${helpHint}`,

  stop: `${heading(
    "openteam stop [options]",
    "Stop OpenTeam while preserving its containers and data."
  )}

Options:
${directoryOption}
${helpHint}`,

  logs: `${heading("openteam logs [service] [options]", "Show recent troubleshooting logs.")}

Options:
${directoryOption}
  --follow, -f          Stream logs until interrupted
  --tail <lines>        Number of recent lines to show (default: 200)
  --service <name>      Show logs for one service (or pass its name directly)
${helpHint}`,

  provider: `${heading(
    "openteam provider <command> [options]",
    "Manage AI account sign-ins and custom providers."
  )}

Commands:
  list                  Show available AI providers and sign-in status
  login [provider]      Sign in to a provider (uses the active one by default)
  logout [provider]     Sign out of a provider
  add <id>              Connect another compatible AI provider
  remove <id>           Remove a custom AI provider

Run "openteam provider <command> --help" for command options.`,

  "provider-list": `${heading(
    "openteam provider list [options]",
    "Show AI providers, model counts, and sign-in status."
  )}

Options:
${directoryOption}
${helpHint}`,

  "provider-login": `${heading(
    "openteam provider login [provider] [options]",
    "Sign in through a browser or with an API key.\nThe active provider is used when omitted."
  )}

Options:
${directoryOption}
  --auth <oauth|api-key>  Select the authentication method
${helpHint}`,

  "provider-logout": `${heading(
    "openteam provider logout [provider] [options]",
    "Remove one provider credential. The active provider is used when omitted."
  )}

Options:
${directoryOption}
${helpHint}`,

  "provider-add": `${heading(
    "openteam provider add <id> [options]",
    "Connect an OpenAI-, Anthropic-, or Google-compatible provider."
  )}

Required options:
  --name <name>          Provider display name
  --base-url <url>      Provider API endpoint
  --api <format>        API format supported by the provider
  --model <id>          Initial model id

Additional options:
${directoryOption}
  --context-window <n>  Model context size
  --max-tokens <n>      Model maximum output tokens
  --reasoning           Mark the model as able to think through complex tasks
${helpHint}

Protocols: openai-completions, openai-responses, anthropic-messages, google-generative-ai`,

  "provider-remove": `${heading(
    "openteam provider remove <id> [options]",
    "Remove a custom AI provider. The active provider cannot be removed."
  )}

Options:
${directoryOption}
${helpHint}`,

  model: `${heading(
    "openteam model <command> [options]",
    "View available AI models or choose the model OpenTeam uses."
  )}

Commands:
  list [provider]         Show available models
  use <provider> <model>  Choose the active model

Run "openteam model <command> --help" for command options.`,

  "model-list": `${heading(
    "openteam model list [provider] [options]",
    "List models with context and capability information."
  )}

Options:
${directoryOption}
${helpHint}`,

  "model-use": `${heading(
    "openteam model use <provider> <model> [options]",
    "Select the installation-wide provider, model, and optional reasoning level."
  )}

Options:
${directoryOption}
  --thinking <level>    off, minimal, low, medium, high, xhigh, or max
${helpHint}`,

  account: `${heading(
    "openteam account <command> [options]",
    "Change the OpenTeam username or password. Changes sign out every app."
  )}

Commands:
  update                Change the username and/or password

Run "openteam account update --help" for command options.`,

  "account-update": `${heading(
    "openteam account update [options]",
    "Update the owner account and revoke all active desktop and mobile sessions.\nWith no credential flags, both are prompted."
  )}

Options:
${directoryOption}
  --username <name>     Update only the owner username
  --password            Prompt securely for a new password
${helpHint}`,

  uninstall: `${heading(
    "openteam uninstall [options]",
    "Remove OpenTeam containers while preserving configuration and data by default."
  )}

Options:
${directoryOption}
  --yes, -y             Skip confirmation
  --purge               Permanently delete containers, volumes, configuration, and data
${helpHint}`,
};

export const helpFor = (topic: HelpTopic = "global"): string => pages[topic];
