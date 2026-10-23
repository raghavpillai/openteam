import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canManageLocalInstallation,
  readManagedInstallation,
} from "../src/main/local-installation";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only permits the client to manage its matching loopback installation", () => {
  const home = mkdtempSync(join(tmpdir(), "openteam-desktop-updater-"));
  temporaryDirectories.push(home);
  const directory = join(home, ".openteam");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "installation.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, ".env"), "OPENTEAM_API_PORT=9444\n");
  writeFileSync(join(directory, "compose.yaml"), "services: {}\n");
  const installation = readManagedInstallation({}, "darwin", home);
  expect(installation?.version).toBe("1.2.3");
  expect(canManageLocalInstallation("http://127.0.0.1:9444", installation)).toBe(true);
  expect(canManageLocalInstallation("https://127.0.0.1:9444", installation)).toBe(false);
  expect(canManageLocalInstallation("http://server.example:9444", installation)).toBe(false);
  expect(canManageLocalInstallation("http://127.0.0.1:8787", installation)).toBe(false);
});
