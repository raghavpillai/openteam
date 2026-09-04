import type { HelpTopic } from "./arguments";
import { CLI_VERSION } from "./constants";

const heading = (usage: string, summary: string): string => `OpenTeam CLI ${CLI_VERSION}

Usage:
  ${usage}

${summary}`;

const helpHint = "  --help, -h            Show this help";
const directoryOption = "  --dir <path>          Override the installation directory";

const pages: Record<HelpTopic, string> = {
  global: `OpenTeam CLI ${CLI_VERSION}

Usage:
  openteam <command> [options]

Commands:
  install       Install and start OpenTeam
  setup         Configure an installation
  status        Show health and services
  doctor        Diagnose installation problems
  update        Update OpenTeam
  start         Start OpenTeam
  stop          Stop OpenTeam
  logs          Show service logs
  provider      Manage provider connections and endpoints
  model         List or select inference models
  account       Update owner credentials
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
  --allow-unsigned           Permit unsigned test bundles (unsafe)
  --compose-url <url>        Override the Compose asset URL
  --checksum-url <url>       Override the SHA256SUMS asset URL
  --signature-url <url>      Override the Sigstore bundle asset URL
  --project-name <name>      Override and persist the Compose project name
  --image-prefix <prefix>    Override the container image prefix`,

  setup: `${heading(
    "openteam setup [options]",
    "Reconfigure access, runtime, provider, and model, then review and relaunch.\nExisting owner credentials are preserved."
  )}

Options:
${directoryOption}
  --advanced            Show port, time-zone, concurrency, and reasoning controls
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
    "Show the installed version, access settings, Compose services, and server health."
  )}

Options:
${directoryOption}
${helpHint}`,

  update: `${heading(
    "openteam update [options]",
    "Run one durable update job, restart the server stack, verify health, and roll back on failure."
  )}

The update continues if the terminal, SSH connection, or Desktop app closes. Running the same
command again reconnects to the active update and resumes high-level progress output.

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

  logs: `${heading("openteam logs [options]", "Show recent Compose service logs.")}

Options:
${directoryOption}
  --follow, -f          Stream logs until interrupted
  --tail <lines>        Number of recent lines to show (default: 200)
  --service <name>      Limit output to one Compose service
${helpHint}`,

  provider: `${heading(
    "openteam provider <command> [options]",
    "Manage inference-provider credentials and custom endpoints."
  )}

Commands:
  list                  List providers and authentication state
  login [provider]      Configure OAuth or an API key/password
  logout [provider]     Remove a provider credential
  add <id>              Add a compatible custom endpoint
  remove <id>           Remove a custom endpoint

Run "openteam provider <command> --help" for command options.`,

  "provider-list": `${heading(
    "openteam provider list [options]",
    "List inference providers, model counts, and authentication state."
  )}

Options:
${directoryOption}
${helpHint}`,

  "provider-login": `${heading(
    "openteam provider login [provider] [options]",
    "Configure OAuth or an API key/password for a provider.\nThe active provider is used when omitted."
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
    "Add an OpenAI-, Anthropic-, or Google-compatible custom endpoint\nand configure its credential."
  )}

Required options:
  --name <name>          Provider display name
  --base-url <url>      Provider API endpoint
  --api <protocol>      Pi-compatible API protocol
  --model <id>          Initial model id

Additional options:
${directoryOption}
  --context-window <n>  Model context size
  --max-tokens <n>      Model maximum output tokens
  --reasoning           Mark the model as reasoning-capable
${helpHint}

Protocols: openai-completions, openai-responses, anthropic-messages, google-generative-ai`,

  "provider-remove": `${heading(
    "openteam provider remove <id> [options]",
    "Remove a custom inference provider. The active provider cannot be removed."
  )}

Options:
${directoryOption}
${helpHint}`,

  model: `${heading(
    "openteam model <command> [options]",
    "List available inference models or select the installation-wide model."
  )}

Commands:
  list [provider]         List available models
  use <provider> <model>  Select the active model

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
    "Manage the OpenTeam owner account. Credential changes revoke all active sessions."
  )}

Commands:
  update                Update the owner username and/or password

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
