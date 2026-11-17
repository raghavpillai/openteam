import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mock } from "bun:test";

const scenario = process.argv[2]!;
const target = "0.0.20";
const accepted = scenario === "restored-accepted";
const values = new Map<string, string>();
const effects: Array<() => unknown> = [];
let account = "A";
let downloaded = false;
let downloads = 0;
let posts = 0;
let observations = 0;
let version = scenario === "restored-old" || accepted ? "0.0.19" : target;
let releaseVersion!: () => void;
let reachedVersion!: () => void;
const enteredVersion = new Promise<void>((resolve) => { reachedVersion = resolve; });
const versionBarrier = new Promise<void>((resolve) => { releaseVersion = resolve; });

mock.module(Bun.resolveSync("react", resolve(import.meta.dir, "../..")), () => ({
  useEffect: (effect: () => unknown) => effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
const user = () => ({ id: account, username: account, name: account, email: `${account}@example.invalid`, image: null });
const desktop = () => ({ currentVersion: "0.0.19", latestVersion: target, status: downloaded ? "downloaded" : "available" });
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  location: { href: "file:///owned/index.html" },
  dispatchEvent: () => true,
  setTimeout: (callback: () => void) => setTimeout(callback, 0),
  openteam: {
    versions: { app: "0.0.19" },
    auth: {
      signIn: async (_base: string, name: string) => { account = name; return { token: `synthetic-${name}`, user: user() }; },
      readToken: async () => ({ token: null }), writeToken: async () => {},
      clearToken: async () => {}, signOut: async () => {},
    },
    updates: {
      status: async () => desktop(), check: async () => desktop(),
      openDownload: async () => { downloads++; downloaded = true; },
    },
  },
} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/auth/config")) return Response.json({ mode: "required" });
  if (url.endsWith("/api/auth/get-session")) return Response.json({ session: { id: account }, user: user() });
  if (url.endsWith("/api/v0/system/version")) {
    observations++;
    if (scenario === "delayed-current-account-change") { reachedVersion(); await versionBarrier; }
    if (accepted && observations >= 2) version = target;
    return Response.json({ releaseVersion: version });
  }
  if (url.endsWith("/api/v0/system/busy-bots")) return Response.json({ bots: [] });
  if (url.endsWith("/api/v0/system/update")) {
    if (init?.method === "POST") { posts++; version = target; }
    return Response.json({
      status: accepted && observations < 2 ? "updating" : "ready",
      targetVersion: accepted ? target : null, jobId: accepted ? "accepted-host-job" : null,
      phase: null, updaterAvailable: true, message: "", safeToCloseDesktop: false,
    });
  }
  throw new Error(`Unexpected fixture network: ${url}`);
}) as typeof fetch;

const auth = await import("../../src/renderer/client/auth");
await auth.signIn(scenario.startsWith("restored") ? "B" : "A", "synthetic");
const { API_BASE } = await import("../../src/renderer/client/http");
if (scenario.startsWith("restored")) {
  values.set(`openteam:update-queue:${API_BASE}:0.0.19`, JSON.stringify({
    targetVersion: target, status: "running", step: scenario === "restored-complete" ? "desktop" : "server",
    serverComplete: scenario === "restored-complete", serverRequested: accepted, message: "Checking",
  }));
}
const { useUpdateQueue } = await import("../../src/renderer/hooks/use-update-queue");
const queue = useUpdateQueue();
if (scenario.startsWith("restored")) {
  for (const effect of effects) effect();
  for (let count = 0; count < 200 && useUpdateQueue().state?.status === "running"; count++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
} else {
  const pending = queue.start(target);
  if (scenario === "delayed-current-account-change") {
    await enteredVersion;
    await auth.signOut();
    await auth.signIn("B", "synthetic");
    releaseVersion();
  }
  await pending;
}
const blocked = !accepted && scenario !== "fresh-current";
assert.equal(posts, 0);
assert.equal(downloads, blocked ? 0 : 1);
assert.equal(useUpdateQueue().state?.status, blocked ? "error" : "complete");
assert.equal(useUpdateQueue().state?.serverRequested, accepted);
if (scenario === "restored-current-retry") {
  await useUpdateQueue().retry();
  assert.equal(posts, 0);
  assert.equal(downloads, 1);
  assert.equal(useUpdateQueue().state?.status, "complete");
  assert.equal(useUpdateQueue().state?.serverRequested, false);
}
for (const [key, value] of values) {
  if (key.includes("update-queue")) assert.ok(!value.includes("synthetic-") && !value.includes("Bearer"));
}
console.log("consent-scenario: passed", scenario);
