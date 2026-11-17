import { expect, test } from "bun:test";
import type { PluginSetupFieldView } from "@openteam/contracts";
import { substituteConfiguration } from "@openteam/plugin-sdk/configuration";
import { pluginSetupValues } from "../src/renderer/lib/plugin-setup-values";

const fields: PluginSetupFieldView[] = [
  {
    key: "READ_ONLY",
    label: "Read-only access",
    type: "boolean",
    default: false,
    required: false,
    secret: false,
  },
  {
    key: "MEDIA_ROOT",
    label: "Attachment folder",
    default: "/workspace",
    required: false,
    secret: false,
  },
  {
    key: "MAX_MESSAGES",
    label: "Maximum stored messages",
    type: "integer",
    default: 100000,
    required: false,
    secret: false,
  },
];

test("untouched optional setup fields save defaults that resolve connector placeholders", () => {
  const values = pluginSetupValues(fields, {});
  expect(values).toEqual({ READ_ONLY: false, MEDIA_ROOT: "/workspace", MAX_MESSAGES: 100000 });
  expect(
    substituteConfiguration(
      {
        args: ["--read-only=${READ_ONLY}", "--max-messages=${MAX_MESSAGES}"],
        env: { MEDIA_ROOT: "${MEDIA_ROOT}" },
      },
      values
    )
  ).toEqual({
    args: ["--read-only=false", "--max-messages=100000"],
    env: { MEDIA_ROOT: "/workspace" },
  });
  expect(pluginSetupValues(fields, { MEDIA_ROOT: " ", MAX_MESSAGES: "" })).toEqual(values);
});

test("setup saves edited boolean and integer values with their declared types", () => {
  expect(
    pluginSetupValues(fields, { READ_ONLY: "true", MAX_MESSAGES: "2500", MEDIA_ROOT: " /data " })
  ).toEqual({ READ_ONLY: true, MAX_MESSAGES: 2500, MEDIA_ROOT: "/data" });
  expect(pluginSetupValues(fields, { READ_ONLY: "false" }).READ_ONLY).toBe(false);
});

test("invalid typed setup values fail before Connect", () => {
  expect(() => pluginSetupValues(fields, { MAX_MESSAGES: "1.5" })).toThrow("must be integer");
  expect(() => pluginSetupValues(fields, { MAX_MESSAGES: "many" })).toThrow("must be integer");
  expect(() => pluginSetupValues(fields, { READ_ONLY: "yes" })).toThrow("must be boolean");
});

test("required fields still validate and secret whitespace is preserved", () => {
  const secret: PluginSetupFieldView[] = [
    { key: "token", label: "Token", required: true, secret: true },
  ];
  expect(() => pluginSetupValues(secret, {})).toThrow("Token is required");
  expect(pluginSetupValues(secret, { token: " secret " })).toEqual({ token: " secret " });
});
