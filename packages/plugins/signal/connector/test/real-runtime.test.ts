import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SignalRpc, SignalRpcError } from "../rpc";

// The packaged real runtime through MCP is covered by runtime-patch.test.ts.
const executable = process.env.SIGNAL_TEST_EXECUTABLE;
const real = executable ? test : test.skip;
const processes: SignalRpc[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((rpc) => rpc.close()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function runtime() {
  const directory = mkdtempSync(join(tmpdir(), "signal-real-unlinked-"));
  directories.push(directory);
  const { SIGNAL_TEST_JAVA_HOME: java, SIGNAL_TEST_LIBSIGNAL: libsignal } = process.env;
  const rpc = new SignalRpc([executable!, "--data-dir", directory, "jsonRpc", "--receive-mode=manual"], () => {}, {
    environment: {
      ...(java ? { JAVA_HOME: java } : {}),
      ...(libsignal ? { JAVA_OPTS: `-Djava.library.path=${dirname(libsignal)}` } : {}),
      XDG_CONFIG_HOME: directory,
    },
  });
  processes.push(rpc);
  return rpc;
}

real("real signal-cli starts empty, serves concurrent RPC, and unlinked reads never default to another account", async () => {
  const rpc = runtime();
  const results = await Promise.all(Array.from({ length: 50 }, () => rpc.request("listAccounts")));
  expect(results.every((value) => Array.isArray(value) && value.length === 0)).toBe(true);
  await expect(rpc.request("listContacts", { account: "+12025550100" })).rejects.toBeInstanceOf(SignalRpcError);
}, 20000);

real("real provisioning reaches Signal and returns a QR-link URI without creating an account", async () => {
  const rpc = runtime();
  const uri = new URL((await rpc.request("startLink", {}, 30_000)).deviceLinkUri);
  expect(uri.protocol).toBe("sgnl:");
  expect(uri.hostname).toBe("linkdevice");
  expect(uri.searchParams.get("uuid")).toBeTruthy();
  expect(uri.searchParams.get("pub_key")).toBeTruthy();
  expect(await rpc.request("listAccounts")).toEqual([]);
}, 40000);
