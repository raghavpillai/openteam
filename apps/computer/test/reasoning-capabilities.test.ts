import { describe, expect, test } from "bun:test";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { PI_REASONING_LEVELS } from "@openteam/contracts";
import { openRouterReasoning, reasoningCapabilities } from "../src/reasoning-capabilities";

const model: Model<Api> = {
  id: "author/never-bundled",
  name: "Unknown",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "https://offline.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("OpenRouter effort metadata", () => {
  test.each([
    [
      {
        supported_efforts: ["max", "xhigh", "high", "medium", "low"],
        mandatory: true,
        default_effort: "high",
      },
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    ],
    [{ supported_efforts: ["high", "low"] }, ["off", "low", "high"], "off"],
    [
      { supported_efforts: ["high", "low"], default_effort: "high" },
      ["off", "low", "high"],
      "high",
    ],
    [{ supported_efforts: ["none", "low"], default_effort: "none" }, ["off", "low"], "off"],
    [
      { supported_efforts: ["none", "low"], mandatory: true, default_effort: "none" },
      ["low"],
      "low",
    ],
    [{ supported_efforts: null }, [...PI_REASONING_LEVELS], "medium"],
    [
      { supported_efforts: null, mandatory: true },
      PI_REASONING_LEVELS.filter((x) => x !== "off"),
      "medium",
    ],
    [
      {
        supported_efforts: ["high", "high", "ultra", 2, null, { effort: "max" }],
        mandatory: true,
        default_effort: "ultra",
      },
      ["high"],
      "high",
    ],
    [{ supported_efforts: ["high"], mandatory: true, default_effort: "max" }, ["high"], "high"],
    [
      { supported_efforts: ["low", "medium"], default_effort: "off" },
      ["off", "low", "medium"],
      "off",
    ],
    [{ supported_efforts: ["ultra"], mandatory: true }, [], "off"],
    [{ supported_efforts: ["high", "low"], default_enabled: true }, ["off", "low", "high"], "low"],
    [
      { supported_efforts: ["high", "medium"], default_enabled: true },
      ["off", "medium", "high"],
      "medium",
    ],
    [
      { supported_efforts: ["high"], default_enabled: true, default_effort: "max" },
      ["off", "high"],
      "high",
    ],
    [{ supported_efforts: [] }, [], "off"],
    [{ supported_efforts: "high" }, [], "off"],
    [{ mandatory: true }, [], "off"],
    [{}, [], "off"],
    [undefined, [], "off"],
    [null, [], "off"],
  ] as const)("normalizes %j", (metadata, levels, defaultLevel) => {
    const normalized = { ...model, ...openRouterReasoning(metadata) };
    expect(reasoningCapabilities(normalized)).toEqual({
      reasoningLevels: [...levels],
      defaultReasoningLevel: defaultLevel,
    });
    expect(Object.keys(normalized.thinkingLevelMap!)).toEqual([...PI_REASONING_LEVELS]);
    for (const level of PI_REASONING_LEVELS) {
      expect(normalized.thinkingLevelMap![level]).toBe(
        (levels as readonly string[]).includes(level) ? (level === "off" ? "none" : level) : null
      );
    }
  });

  test("honors default-disabled reasoning without disabling mandatory reasoning", () => {
    for (const mandatory of [false, true]) {
      const normalized = {
        ...model,
        ...openRouterReasoning({
          supported_efforts: ["high"],
          default_effort: "high",
          default_enabled: false,
          mandatory,
        }),
      };
      expect(reasoningCapabilities(normalized).defaultReasoningLevel).toBe(
        mandatory ? "high" : "off"
      );
    }
  });

  test("non-reasoning models always offer only off regardless of stale defaults", () => {
    expect(
      reasoningCapabilities({ ...model, reasoning: false, defaultReasoningLevel: "max" })
    ).toEqual({ reasoningLevels: ["off"], defaultReasoningLevel: "off" });
  });
});
