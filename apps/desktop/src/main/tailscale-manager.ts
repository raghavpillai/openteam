import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DesktopTailscaleStatus, TailscaleStatus } from "@openteam/contracts/tailscale";
import { safeErrorMessage } from "@openteam/product-core/redaction";
import { canManageServer, readManagedInstallation } from "./server-updater";

export interface TailscaleRequest {
  serverUrl: string;
  action: "status" | "enable" | "disable";
  httpsPort?: string;
}
export function tailscaleRequest(value: unknown): TailscaleRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid Tailscale request");
  const r = value as Record<string, unknown>;
  if (
    typeof r.serverUrl !== "string" ||
    r.serverUrl.length > 2048 ||
    !["status", "enable", "disable"].includes(String(r.action))
  )
    throw new Error("Invalid Tailscale request");
  const url = new URL(r.serverUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("Invalid server URL");
  if (
    r.httpsPort !== undefined &&
    (typeof r.httpsPort !== "string" ||
      !/^\d+$/.test(r.httpsPort) ||
      Number(r.httpsPort) < 1 ||
      Number(r.httpsPort) > 65535)
  )
    throw new Error("HTTPS port must be between 1 and 65535");
  return {
    serverUrl: url.origin,
    action: r.action as TailscaleRequest["action"],
    ...(r.httpsPort !== undefined ? { httpsPort: String(Number(r.httpsPort)) } : {}),
  };
}

/** Only the matching local installation may be mutated. Never execute on a remote host. */
export function canManageTailscale(
  serverUrl: string,
  installation: ReturnType<typeof readManagedInstallation>
): boolean {
  if (canManageServer(serverUrl, installation)) return true;
  if (!installation) return false;
  try {
    const env = readFileSync(join(installation.directory, ".env"), "utf8");
    const configured = env
      .match(/^OPENTEAM_PUBLIC_URL=(.+)$/m)?.[1]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    const mode = env.match(/^OPENTEAM_ACCESS_MODE=(.+)$/m)?.[1]?.trim();
    return (
      mode === "tailscale" &&
      !!configured &&
      new URL(configured).origin === new URL(serverUrl).origin
    );
  } catch {
    return false;
  }
}

export class TailscaleManager {
  private busy = false;
  constructor(
    private readonly options: {
      executablePath: string;
      cliPath: string;
      environment?: NodeJS.ProcessEnv;
      run?: (args: string[], environment: NodeJS.ProcessEnv) => Promise<string>;
    }
  ) {}

  async request(value: unknown): Promise<DesktopTailscaleStatus> {
    const request = tailscaleRequest(value);
    const environment = this.options.environment ?? process.env;
    const installation = readManagedInstallation(environment);
    if (!canManageTailscale(request.serverUrl, installation)) {
      if (request.action !== "status")
        throw new Error(
          "Run openteam tailscale on the server host. This app cannot manage that installation locally."
        );
      return {
        canManage: false,
        status: null,
        message: "Run these commands on your OpenTeam server host to manage Tailscale HTTPS.",
      };
    }
    if (this.busy)
      throw new Error("A Tailscale operation is already running. Wait for it to finish.");
    this.busy = true;
    try {
      const args = [
        this.options.cliPath,
        "tailscale",
        request.action,
        "--dir",
        installation!.directory,
        "--json",
        ...(request.action === "enable" && request.httpsPort
          ? ["--https-port", request.httpsPort]
          : []),
      ];
      const env = {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
        PATH: [
          environment.PATH,
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/Applications/Tailscale.app/Contents/MacOS",
          "/Applications/Docker.app/Contents/Resources/bin",
          "/usr/bin",
          "/bin",
        ]
          .filter(Boolean)
          .join(delimiter),
      };
      const output = this.options.run
        ? await this.options.run(args, env)
        : await new Promise<string>((resolve, reject) => {
            execFile(
              this.options.executablePath,
              args,
              {
                env,
                timeout: request.action === "status" ? 60_000 : 0,
                maxBuffer: 256 * 1024,
                encoding: "utf8",
              },
              (error, stdout, stderr) => {
                // Status exit 2 still carries a structured, actionable result.
                if (error && !(request.action === "status" && stdout.trim().startsWith("{"))) {
                  reject(
                    new Error(safeErrorMessage(new Error(stderr.slice(-8000) || error.message)))
                  );
                } else resolve(stdout);
              }
            );
          });
      const status = JSON.parse(output) as TailscaleStatus;
      if (
        typeof status.enabled !== "boolean" ||
        typeof status.publicUrl !== "string" ||
        typeof status.backendUrl !== "string" ||
        typeof status.httpsPort !== "string" ||
        !["matching", "missing", "conflict", "unavailable", "disabled"].includes(status.route)
      )
        throw new Error(
          "The management CLI returned invalid Tailscale status. Update OpenTeam and retry."
        );
      return { canManage: true, status, message: null };
    } finally {
      this.busy = false;
    }
  }
}
