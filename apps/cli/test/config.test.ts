import { describe, expect, test } from "bun:test";
import { createEnvironment, defaultInstallDirectory, parseEnvironment } from "../src/config";

describe("installation configuration", () => {
  test("uses a cross-platform per-user installation directory", () => {
    expect(defaultInstallDirectory({}, "darwin", "/Users/tester")).toBe("/Users/tester/.openteam");
    expect(defaultInstallDirectory({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/tester")).toBe(
      "/config/openteam"
    );
    expect(
      defaultInstallDirectory(
        { LOCALAPPDATA: "C:\\Users\\tester\\Local" },
        "win32",
        "C:\\Users\\tester"
      )
    ).toContain("OpenTeam");
  });

  test("creates random single-line secrets and stable release settings", () => {
    const first = parseEnvironment(createEnvironment({ version: "1.2.3", workerConcurrency: "8" }));
    const second = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    expect(first.get("OPENTEAM_VERSION")).toBe("1.2.3");
    expect(first.get("OPENTEAM_BIND_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_VIEWER_BIND_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_PUBLIC_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_PUBLIC_URL")).toBe("http://127.0.0.1:8787");
    expect(first.get("OPENTEAM_ACCESS_MODE")).toBe("local");
    expect(first.get("OPENTEAM_WORKER_CONCURRENCY")).toBe("8");
    expect(first.get("COMPOSE_PROFILES")).toBe("direct");
    expect(first.get("OPENTEAM_AUTH_MODE")).toBe("required");
    expect(first.has("OPENTEAM_PI_PROVIDER")).toBe(false);
    expect(first.has("OPENTEAM_PI_MODEL")).toBe(false);
    expect(first.has("OPENTEAM_PI_THINKING")).toBe(false);
    expect(first.get("OPENTEAM_CONTROL_TOKEN")).toHaveLength(64);
    expect(first.get("OPENTEAM_AUTH_SECRET")).toHaveLength(64);
    expect(first.get("OPENTEAM_PROXY_SECRET")).toHaveLength(64);
    expect(first.get("OPENTEAM_POSTGRES_PASSWORD")).toHaveLength(64);
    expect(first.get("OPENTEAM_CONTROL_TOKEN")).not.toBe(second.get("OPENTEAM_CONTROL_TOKEN"));
    expect(first.get("OPENTEAM_AUTH_SECRET")).not.toBe(second.get("OPENTEAM_AUTH_SECRET"));
    expect(first.get("OPENTEAM_PROXY_SECRET")).not.toBe(second.get("OPENTEAM_PROXY_SECRET"));
  });
});
