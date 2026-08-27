import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveControlToken } from "../src/main/control-token";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-control-token-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("desktop control token", () => {
  test("finds a project .env from the packaged app path and persists it", async () => {
    const root = await temporaryDirectory();
    const appPath = join(
      root,
      "apps",
      "desktop",
      "release",
      "OpenBot.app",
      "Contents",
      "Resources",
      "app.asar"
    );
    const userDataPath = join(root, "user-data");
    mkdirSync(join(root, "apps", "desktop", "release"), { recursive: true });
    writeFileSync(join(root, ".env"), "OPENBOT_CONTROL_TOKEN=project-secret\n");

    expect(
      resolveControlToken({
        cwd: "/",
        appPath,
        executablePath: join(root, "OpenBot"),
        userDataPath,
      })
    ).toBe("project-secret");
    expect(readFileSync(join(userDataPath, "control-token"), "utf8").trim()).toBe("project-secret");
    expect(statSync(join(userDataPath, "control-token")).mode & 0o777).toBe(0o600);
  });

  test("uses the persisted token after the app moves away from the repo", async () => {
    const root = await temporaryDirectory();
    const userDataPath = join(root, "user-data");
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(join(userDataPath, "control-token"), "persisted-secret\n");
    chmodSync(join(userDataPath, "control-token"), 0o600);

    expect(
      resolveControlToken({
        cwd: "/",
        appPath: "/Applications/OpenBot.app/Contents/Resources/app.asar",
        executablePath: "/Applications/OpenBot.app/Contents/MacOS/OpenBot",
        userDataPath,
      })
    ).toBe("persisted-secret");
  });

  test("an explicit environment token wins and is persisted", async () => {
    const root = await temporaryDirectory();
    const userDataPath = join(root, "user-data");

    expect(
      resolveControlToken({
        environmentToken: "environment-secret",
        cwd: root,
        appPath: root,
        executablePath: root,
        userDataPath,
      })
    ).toBe("environment-secret");
    expect(readFileSync(join(userDataPath, "control-token"), "utf8").trim()).toBe(
      "environment-secret"
    );
  });
});
