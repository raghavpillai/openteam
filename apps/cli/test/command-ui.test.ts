import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { errorMessage } from "../src/errors";
import {
  cliProgram,
  renderCommandError,
  renderHelp,
  renderModelCatalog,
  renderProviderCatalog,
  renderStatus,
  renderSummary,
  renderUpdateEvent,
} from "../src/command-ui";
import { helpFor } from "../src/help";
import type { ModelRow, ProviderRow } from "../src/providers";

const paths = installationPaths("/tmp/a very long installation's path");
const selected = { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "medium" };
const models: ModelRow[] = [
  "gpt-5.6-sol",
  "a-model-with-an-extremely-long-name-that-must-never-be-truncated",
].map((modelId) => ({
  providerId: "openai-codex",
  modelId,
  name: modelId,
  reasoning: true,
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultReasoningLevel: "medium",
  input: ["text", "image"],
  contextWindow: 272000,
  maxTokens: 4096,
}));
const providers: ProviderRow[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    configured: false,
    authType: null,
    authSource: null,
    models: 13,
    custom: false,
    authMethods: [{ type: "api_key", label: "API key", subscription: false }],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    configured: true,
    authType: "oauth",
    authSource: "OAuth",
    models: 5,
    custom: false,
    authMethods: [{ type: "oauth", label: "ChatGPT", subscription: true }],
  },
];
const status = {
  version: "0.0.1",
  directory: paths.directory,
  connection: "Private network",
  server: "http://100.94.42.50:8787",
  expected: ["server", "worker"],
  services: [
    { Service: "server", State: "running", Health: "healthy" },
    { Service: "worker", State: "running" },
  ],
  health: { ok: true, detail: "ready", inference: "ready" },
  next: "openteam doctor",
};
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("CLI presentation", () => {
  test.each([24, 90])("reports fit %d columns, including long identifiers and paths", (width) => {
    for (const color of [false, true]) {
      const options = { width, color };
      const reports = [
        renderHelp(helpFor("global"), options),
        renderHelp(helpFor("provider-add"), options),
        renderModelCatalog(models, selected, paths, undefined, options),
        renderProviderCatalog(providers, selected.providerId, paths, options),
        renderStatus(status, options),
        renderSummary(
          "model",
          "MODEL SELECTED",
          [{ label: "Thinking", value: "medium" }],
          [],
          options
        ),
        renderCommandError(
          "Unknown model. Run openteam model list to see available models.",
          options
        ),
        renderUpdateEvent(
          {
            schemaVersion: 1,
            jobId: "test",
            status: "running",
            phase: "downloading",
            fromVersion: "1.0.0",
            targetVersion: "2.0.0",
            message: "Downloading and verifying the selected release",
            startedAt: "",
            updatedAt: "",
          },
          options
        ),
      ];
      for (const report of reports) {
        expect(
          plain(report)
            .split("\n")
            .every((line) => line.length <= width)
        ).toBe(true);
        if (!color) expect(report).not.toContain("\x1b");
      }
    }
  });
  test("shows stopped, missing, unhealthy and failed-initialization states accurately", () => {
    expect(
      renderStatus({ ...status, services: [], health: { ok: false, detail: "unreachable" } })
    ).toContain("STOPPED");
    expect(renderStatus({ ...status, services: status.services.slice(0, 1) })).toContain(
      "NEEDS ATTENTION"
    );
    expect(
      renderStatus({
        ...status,
        services: [
          { Service: "server", State: "running", Health: "unhealthy" },
          status.services[1]!,
        ],
      })
    ).toContain("NEEDS ATTENTION");
    expect(
      renderStatus({
        ...status,
        services: [...status.services, { Service: "migrate", State: "exited", ExitCode: 1 }],
      })
    ).toContain("NEEDS ATTENTION");
    expect(renderStatus(status)).toContain("RUNNING");
    expect(
      renderStatus({
        ...status,
        services: [...status.services, { Service: "worker", State: "exited" }],
      })
    ).toContain("NEEDS ATTENTION");
  });
  test("redacts secrets and strips terminal escapes before styling dynamic data", () => {
    const secret = "sk-proj-renderInvalid0123456789012345";
    const text = renderCommandError(
      `Invalid API key ${secret}\x1b]8;;https://bad.test\x07spoof\x1b]8;;\x07\r`,
      { color: false }
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("bad.test");
    expect(
      errorMessage(new Error("compose failed with OPENTEAM_POSTGRES_PASSWORD=database-secret"))
    ).toBe("compose failed with OPENTEAM_POSTGRES_PASSWORD=[REDACTED]");
  });
});

describe("CLI name in hints", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test("uses the absolute path until the installed directory is on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "openteam-cli-name-"));
    directories.push(root);
    const bin = join(root, "bin");
    const linked = join(root, "linked");
    mkdirSync(bin);
    mkdirSync(linked);
    const executable = join(bin, "openteam");
    writeFileSync(executable, "", { mode: 0o755 });
    symlinkSync(executable, join(linked, "openteam"));
    const program = (path: string) =>
      cliProgram({ executable, standalone: true, path, platform: "linux" });

    expect(program("/usr/bin:/bin")).toBe(executable);
    expect(program(`/usr/bin:${bin}`)).toBe("openteam");
    expect(program(`${linked}:/usr/bin`)).toBe("openteam");
    // Another name for the same file, like a Windows short name (RUNNER~1), still counts.
    const aliased = join(root, "aliased");
    mkdirSync(aliased);
    linkSync(executable, join(aliased, "openteam"));
    expect(program(`/usr/bin:${aliased}`)).toBe("openteam");
    // Running from source, or bundled in the desktop app, keeps the short name.
    expect(cliProgram({ executable, standalone: false, path: "" })).toBe("openteam");
  });

  test("quotes paths the shell would split", () => {
    expect(
      cliProgram({
        executable: "/home/Jane Doe/.local/bin/openteam",
        standalone: true,
        path: "",
        platform: "linux",
      })
    ).toBe("'/home/Jane Doe/.local/bin/openteam'");
    expect(
      cliProgram({
        executable: "C:\\Users\\Jane Doe\\AppData\\Local\\OpenTeam\\bin\\openteam.exe",
        standalone: true,
        path: "",
        platform: "win32",
      })
    ).toBe("& 'C:\\Users\\Jane Doe\\AppData\\Local\\OpenTeam\\bin\\openteam.exe'");
  });
});
