import { describe, expect, test } from "bun:test";
import { installationPaths } from "../src/config";
import {
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
import { TerminalReport } from "../src/terminal";

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
  test.each([
    24, 40, 60, 90, 110,
  ])("reports fit %d columns, including long identifiers and paths", (width) => {
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
  test("keeps complete model identifiers, highlights selection, and represents empty catalogs", () => {
    const text = renderModelCatalog(models, selected, paths, undefined, {
      width: 110,
      color: false,
    });
    for (const model of models)
      expect(text.replace(/\s+/g, "")).toContain(`${model.providerId}/${model.modelId}`);
    expect(text).toContain("● openai-codex/gpt-5.6-sol");
    expect(text).toContain("272,000 context");
    expect(renderModelCatalog([], selected, paths, "unknown")).toContain(
      "No models found for unknown"
    );
    expect(renderProviderCatalog([], selected.providerId, paths)).toContain(
      "No providers are available"
    );
  });
  test("distinguishes connections from supported login methods", () => {
    const text = renderProviderCatalog(providers, selected.providerId, paths);
    expect(text.indexOf("CONNECTED ACCOUNTS")).toBeLessThan(text.indexOf("AVAILABLE TO CONNECT"));
    expect(text.indexOf("openai-codex")).toBeLessThan(text.indexOf("anthropic"));
    expect(text).toContain("Connected · OAuth");
    expect(text).toContain("API key");
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
  });
  test("falls back to a sensible width for unavailable terminal dimensions", () => {
    expect(new TerminalReport({ width: Number.NaN }).width).toBe(90);
    expect(new TerminalReport({ width: 0 }).width).toBe(90);
  });
});
