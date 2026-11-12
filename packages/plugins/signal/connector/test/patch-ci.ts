import { dirname, resolve } from "node:path";
import { ManagedRuntimeCache } from "@openteam/plugin-sdk/runtime-assets";
import type { PluginRuntimeAsset } from "@openteam/plugin-sdk";
import assets from "../runtime-assets.json";

if (!process.env.JAVA_HOME)
  throw new Error("JDK 25 JAVA_HOME is required to verify the bundled patch");
// Public artifacts only; account tests create isolated temporary directories.
const runtime = await new ManagedRuntimeCache(
  resolve(process.env.SIGNAL_RUNTIME_CACHE ?? "output/signal-validation/ci-runtime")
).resolve(assets as PluginRuntimeAsset[]);
const environment = {
  ...process.env,
  SIGNAL_PATCH_JDK: process.env.JAVA_HOME,
  SIGNAL_PATCH_CLI: dirname(dirname(runtime.OPENTEAM_RUNTIME_SIGNAL_CLI!)),
  SIGNAL_TEST_EXECUTABLE: runtime.OPENTEAM_RUNTIME_SIGNAL_CLI!,
  SIGNAL_TEST_JAVA_HOME: dirname(dirname(runtime.OPENTEAM_RUNTIME_JAVA!)),
  ...(runtime.OPENTEAM_RUNTIME_LIBSIGNAL
    ? { SIGNAL_TEST_LIBSIGNAL: runtime.OPENTEAM_RUNTIME_LIBSIGNAL }
    : {}),
};
// Provisioning deliberately contacts Signal. CI covers real unlinked Java/RPC and
// the real protobuf pipeline without opening device-link sessions on every PR.
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "packages/plugins/signal/connector/test",
    "apps/server/test/plugin/device-link.test.ts",
    "packages/plugin-sdk/src/runtime-assets.test.ts",
    "packages/plugin-sdk/src/runtime-asset-definition.test.ts",
    "apps/computer/test/runtime/managed-account-state.test.ts",
    "--test-name-pattern",
    "^(?!.*real provisioning).*$",
  ],
  { env: environment, stdout: "inherit", stderr: "inherit" }
);
process.exit(await child.exited);
