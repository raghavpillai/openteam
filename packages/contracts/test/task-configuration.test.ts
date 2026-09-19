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

test("configured effort choices apply only to new executors and resume ignores model", () => {
  expect(taskToolContract(config).inputSchema.properties.model.enum).toEqual(["quick", "deep"]);
  expect(taskInference(config, {}, inherited)).toMatchObject({
    modelId: "small-model",
    reasoning: "low",
  });
  expect(taskInference(config, { model: "deep" }, inherited)).toMatchObject({
    providerId: "anthropic",
    modelId: "large-model",
  });
  expect(() => taskInference(config, { model: "unconfigured" }, inherited)).toThrow("effort level");
  for (const subagent_type of ["computerUse", "browserUse", "videoReview", "watchVideo"])
    expect(taskInference(config, { subagent_type, model: "unconfigured" }, inherited)).toEqual(
      inherited
    );
  expect(taskInference(config, { resume: "previous", model: "unconfigured" }, inherited)).toEqual(
    inherited
  );
  expect(taskInference({ ...config, defaultExecutorProfile: undefined }, {}, inherited)).toEqual(
    inherited
  );
  expect(taskUserInfo(config)).toContain("quick: Small bounded tasks (default)");
  expect(taskUserInfo(config)).not.toContain("small-model");
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
