import { expect, test } from "bun:test";
import {
  parseTaskConfiguration,
  taskInference,
  taskUserInfo,
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
