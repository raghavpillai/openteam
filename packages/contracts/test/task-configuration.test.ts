import { expect, test } from "bun:test";
import {
  defaultTaskConfiguration,
  parseTaskConfiguration,
  taskInference,
  taskUserInfo,
  selectTaskConfiguration,
  taskToolEnabled,
} from "../src/task-configuration";
import { taskToolContract } from "../src/tool-contracts";
import reference from "../src/tool-reference.json";

const inherited = { providerId: "openai", modelId: "parent-model", reasoning: "high" as const };
const config = parseTaskConfiguration({
  combinedComputerUse: true,
  executorProfiles: [
    {
      name: "quick",
      description: "Small bounded tasks",
      providerId: "openai",
      modelId: "small-model",
      reasoning: "low",
    },
    {
      name: "deep",
      description: "Difficult reasoning",
      providerId: "anthropic",
      modelId: "large-model",
      reasoning: "high",
    },
  ],
  defaultExecutorProfile: "quick",
});

test("graphical selection follows desktop, box and tool availability", () => {
  for (const desktopAvailable of [true, false])
    for (const boxAvailable of [true, false]) {
      const selected = selectTaskConfiguration(config, { desktopAvailable, boxAvailable });
      expect(selected.combinedComputerUse).toBe(desktopAvailable && boxAvailable);
      expect(
        taskToolContract(selected).inputSchema.properties.subagent_type.enum.includes("computerUse")
      ).toBe(desktopAvailable && boxAvailable);
      expect(taskToolContract(selected).inputSchema.properties.subagent_type.enum).toContain(
        "videoReview"
      );
    }
  for (const disabled of ["BROWSER_CLICK", "OPENAI_COMPUTER_USE", "SHELL", "READ"]) {
    const selected = selectTaskConfiguration(
      { ...config, disabledToolIdentifiers: [disabled] },
      { desktopAvailable: true, boxAvailable: true }
    );
    expect(selected.combinedComputerUse).toBe(false);
    expect(taskToolContract(selected).inputSchema.properties.subagent_type.enum).toContain(
      "browserUse"
    );
  }
  expect(
    taskToolEnabled(
      { ...config, disabledToolIdentifiers: ["BROWSER_CLICK", "OPENAI_COMPUTER_USE"] },
      "browser_click"
    )
  ).toBe(false);
  expect(
    taskToolEnabled({ ...config, disabledToolIdentifiers: ["OPENAI_COMPUTER_USE"] }, "Computer")
  ).toBe(false);
});

test("default Task contract matches the captured combined-worker catalog exactly", () => {
  expect(taskToolContract()).toEqual(reference.Task);
  expect(taskUserInfo()).not.toContain("browserUse:");
  expect(taskUserInfo()).not.toContain("available_subagent_models");
  expect(
    taskInference(defaultTaskConfiguration(), { model: "arbitrary/provider-model" }, inherited)
  ).toEqual(inherited);
});

test("legacy profiles and model arguments cannot override server inference", () => {
  expect(taskToolContract(config).inputSchema.properties.model).toBeUndefined();
  expect(taskUserInfo(config)).not.toContain("available_subagent_models");
  for (const reasoning of ["off", "minimal", "low", "medium", "high"] as const)
    for (const subagent_type of ["executor", "computerUse", "browserUse", "videoReview", "watchVideo"])
      for (const model of [undefined, "quick", "deep", "unconfigured", "provider/model"])
        for (const resume of [undefined, "previous"]) {
          const authority = { ...inherited, reasoning };
          expect(taskInference(config, { model, subagent_type, resume }, authority)).toEqual(authority);
        }
});

test("split mode exposes browserUse without losing existing types", () => {
  const split = { ...config, combinedComputerUse: false };
  expect(taskToolContract(split).inputSchema.properties.subagent_type.enum).toEqual([
    "executor",
    "videoReview",
    "watchVideo",
    "computerUse",
    "browserUse",
  ]);
  expect(taskUserInfo(split)).toContain("browserUse:");
});

test("graphical capability hints respect disabled tools and unavailable workers", () => {
  for (const combinedComputerUse of [true, false]) {
    const selected = { ...config, combinedComputerUse };
    expect(taskUserInfo(selected)).toContain("browser_console_messages");
    expect(taskUserInfo(selected)).toContain("browser_take_screenshot");
    expect(taskUserInfo(selected)).toContain("browser_file_upload");
    const restricted = taskUserInfo({ ...selected, disabledToolIdentifiers: ["BROWSER_CONSOLE_MESSAGES"] });
    expect(restricted).not.toContain("browser_console_messages");
    expect(restricted).toContain("browser_take_screenshot");
    expect(taskUserInfo({ ...selected, graphicalAvailable: false })).not.toContain("Browser capabilities");
  }
});

test("invalid and ambiguous profile configurations cannot be saved", () => {
  for (const input of [
    null,
    {},
    { ...config, combinedComputerUse: "true" },
    { ...config, defaultExecutorProfile: "missing" },
    { ...config, executorProfiles: [config.executorProfiles[0], config.executorProfiles[0]] },
    { ...config, executorProfiles: [{ ...config.executorProfiles[0], reasoning: "imaginary" }] },
    { ...config, executorProfiles: [{ ...config.executorProfiles[0], name: "provider/model" }] },
  ])
    expect(() => parseTaskConfiguration(input)).toThrow();
});
