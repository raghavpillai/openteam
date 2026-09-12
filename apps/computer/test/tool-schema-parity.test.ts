import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BROWSER_USE_TOOLS } from "../src/browser/use";
import { dynamicCatalog } from "../src/runtime/dynamic-catalog";
import type { ActiveTurn } from "../src/runtime/types";
import { objectToolSchema } from "../src/tool-schema";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("tool schema extraction parity", () => {
  test("keeps every browser schema and description byte-for-byte compatible", () => {
    expect(digest(BROWSER_USE_TOOLS)).toBe(
      "c8b7a63f1dea875f0f4a5b2072d287a13144cc774f3320cf92c6f289a42eb07f"
    );
  });

  test("keeps dynamic namespace ordering, schemas, descriptions, and sources", () => {
    const unused = async (): Promise<never> => {
      throw new Error("catalog construction must not execute a tool");
    };
    const catalog = dynamicCatalog(unused, unused, unused, {
      runtimeProfile: "agent",
      pluginNamespaces: [],
    } as unknown as ActiveTurn).map((namespace) => ({
      ...namespace,
      tools: namespace.tools.map(({ execute, decodeArguments, ...tool }) => tool),
    }));
    expect(digest(catalog)).toBe(
      "4be3ad704092cc60e6d810c1003719fa2ad3d6bf670fb66e45fb5c7988c8ba6b"
    );
  });

  test("distinguishes an omitted required list from an explicit empty list", () => {
    expect(objectToolSchema({})).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(objectToolSchema({}, [])).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
