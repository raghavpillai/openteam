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

test("graphical selection follows desktop and box availability", () => {
  for (const desktopAvailable of [true, false])
    for (const boxAvailable of [true, false]) {
      const selected = selectTaskConfiguration(config, { desktopAvailable, boxAvailable });
      expect(selected.graphicalAvailable).toBe(desktopAvailable && boxAvailable);
      expect(
        taskToolContract(selected).inputSchema.properties.subagent_type.enum.includes("computerUse")
      ).toBe(desktopAvailable && boxAvailable);
      expect(taskToolContract(selected).inputSchema.properties.subagent_type.enum).toContain(
        "videoReview"
      );
    }
  // Disabled tools leave the one graphical worker in place; its tool list drops them.
  for (const disabled of ["BROWSER_CLICK", "OPENAI_COMPUTER_USE", "SHELL", "READ"]) {
    const selected = selectTaskConfiguration(
      { ...config, disabledToolIdentifiers: [disabled] },
      { desktopAvailable: true, boxAvailable: true }
    );
    expect(selected.graphicalAvailable).toBe(true);
    expect(taskToolContract(selected).inputSchema.properties.subagent_type.enum).toEqual([
      "executor",
      "videoReview",
      "watchVideo",
      "computerUse",
      "knowledgeWork",
    ]);
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
  // The current catalog lists knowledgeWork after the captured types.
  const expected = structuredClone(reference.Task);
  expected.inputSchema.properties.subagent_type.enum.push("knowledgeWork");
  expected.inputSchema.properties.subagent_type.description =
    "Subagent type to use for this task. Must be one of: executor, videoReview, watchVideo, computerUse, knowledgeWork.";
  expect(taskToolContract()).toEqual(expected);
  expect(taskUserInfo()).not.toContain("available_subagent_models");
  expect(
    taskInference(defaultTaskConfiguration(), { model: "arbitrary/provider-model" }, inherited)
  ).toEqual(inherited);
});

test("legacy profiles and model arguments cannot override server inference", () => {
  expect(taskToolContract(config).inputSchema.properties.model).toBeUndefined();
  expect(taskUserInfo(config)).not.toContain("available_subagent_models");
  for (const reasoning of ["off", "minimal", "low", "medium", "high"] as const)
    for (const subagent_type of ["executor", "computerUse", "videoReview", "watchVideo"])
      for (const model of [undefined, "quick", "deep", "unconfigured", "provider/model"])
        for (const resume of [undefined, "previous"]) {
          const authority = { ...inherited, reasoning };
          expect(taskInference(config, { model, subagent_type, resume }, authority)).toEqual(authority);
        }
});

test("the roster names one graphical worker for browser and desktop work", () => {
  const info = taskUserInfo(config);
  expect(info).toContain("computerUse: Delegate a self-contained browser or desktop task to a background subagent that operates your box's browser and desktop");
  expect(info).toContain("Only one computerUse subagent can run at a time");
  expect(info).toContain("executor: Your workhorse:");
  expect(info).toContain("dispatch browser and desktop work to computerUse yourself.");
  expect(info).not.toContain("browserUse");
  expect(info).toContain("knowledgeWork: A higher-powered executor for five kinds of work, and only these:");
  expect(info).toContain("Use it when a skill names it or the deliverable is one of these.");
  const headless = taskUserInfo({ ...config, graphicalAvailable: false });
  expect(headless).toContain("Browser and desktop workers are unavailable on this computer.");
  expect(headless).not.toContain("dispatch browser and desktop work to computerUse");
});

test("settings outside the Task configuration are refused", () => {
  expect(() => parseTaskConfiguration({ ...config, combinedComputerUse: true })).toThrow("Unknown Task setting");
});

test("invalid and ambiguous profile configurations cannot be saved", () => {
  for (const input of [
    null,
    {},
    { ...config, executorProfiles: undefined },
    { ...config, browserWorker: true },
    { ...config, defaultExecutorProfile: "missing" },
    { ...config, executorProfiles: [config.executorProfiles[0], config.executorProfiles[0]] },
    { ...config, executorProfiles: [{ ...config.executorProfiles[0], reasoning: "imaginary" }] },
    { ...config, executorProfiles: [{ ...config.executorProfiles[0], name: "provider/model" }] },
  ])
    expect(() => parseTaskConfiguration(input)).toThrow();
});
