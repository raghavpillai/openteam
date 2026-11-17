import { expect, test } from "bun:test";
import { parsePluginDefinition } from "@openteam/plugin-sdk";
import whatsapp from "../../../../packages/plugins/whatsapp/plugin.json";
import {
  connectionConfigured,
  connectionSetupPhase,
  runtimeConfiguration,
} from "../../src/services/plugin/values";

// Existing accounts can retain this older manifest until the installed package updates.
const fields = [
  {
    key: "WHATSAPP_READ_ONLY",
    label: "Read-only access",
    type: "boolean",
    default: false,
    required: false,
    secret: false,
  },
  {
    key: "WHATSAPP_MEDIA_ROOT",
    label: "Attachment folder",
    default: "/workspace",
    required: false,
    secret: false,
  },
  {
    key: "WHATSAPP_MAX_MESSAGES",
    label: "Maximum stored messages",
    type: "integer",
    default: 100000,
    required: false,
    secret: false,
  },
];
const configuration = {
  command: "bun",
  args: [
    "${PLUGIN_ROOT}/connector/server.mjs",
    "--read-only=${WHATSAPP_READ_ONLY}",
    "--max-messages=${WHATSAPP_MAX_MESSAGES}",
  ],
  env: { WHATSAPP_MEDIA_ROOT: "${WHATSAPP_MEDIA_ROOT}" },
};
const plugin = parsePluginDefinition({
  ...whatsapp,
  skills: [],
  setup: { ...whatsapp.setup, fields },
  connections: [{ ...whatsapp.connections[0], configuration }],
});
const connection = {
  connectorKey: "whatsapp",
  authType: "none",
  status: "disconnected",
  configuration,
  credentials: {},
  installation: { manifest: plugin },
};

test("WhatsApp accounts with no saved preferences are ready to connect using manifest defaults", () => {
  expect(connectionConfigured(connection, plugin)).toBe(true);
  expect(connectionSetupPhase(connection, plugin)).toBe("ready_to_connect");
  expect(runtimeConfiguration(connection)).toMatchObject({
    args: ["${PLUGIN_ROOT}/connector/server.mjs", "--read-only=false", "--max-messages=100000"],
    env: { WHATSAPP_MEDIA_ROOT: "/workspace" },
  });
  expect(connection.configuration).not.toHaveProperty("values");
});

test("saved WhatsApp preferences override defaults, including false and zero values", () => {
  const configured = {
    ...connection,
    configuration: {
      ...connection.configuration,
      values: {
        WHATSAPP_READ_ONLY: true,
        WHATSAPP_MAX_MESSAGES: 2500,
        WHATSAPP_MEDIA_ROOT: "/data",
      },
    },
  };
  expect(runtimeConfiguration(configured)).toMatchObject({
    args: ["${PLUGIN_ROOT}/connector/server.mjs", "--read-only=true", "--max-messages=2500"],
    env: { WHATSAPP_MEDIA_ROOT: "/data" },
  });
  expect(
    runtimeConfiguration({
      ...configured,
      credentials: { values: { WHATSAPP_READ_ONLY: false, WHATSAPP_MAX_MESSAGES: 0 } },
    })
  ).toMatchObject({
    args: ["${PLUGIN_ROOT}/connector/server.mjs", "--read-only=false", "--max-messages=0"],
  });
});

test("required setup without a default still blocks a connection", () => {
  const required = {
    ...plugin,
    setup: {
      ...plugin.setup!,
      fields: [
        ...plugin.setup!.fields,
        { key: "ADDRESS", label: "Address", required: true, secret: false },
      ],
    },
  };
  expect(connectionConfigured(connection, required)).toBe(false);
});
