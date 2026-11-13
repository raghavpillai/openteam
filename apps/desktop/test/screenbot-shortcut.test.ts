import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ScreenBotShortcutController,
  defaultScreenBotShortcut,
  isValidAccelerator,
  parseScreenBotShortcut,
  reservedShortcutReason,
  type ScreenBotShortcutStatus,
} from "../src/main/screenbot-shortcut";

describe("screenbot shortcuts", () => {
  test("accepts real shortcuts and Mac both-key chords, refusing typing keys and ones every app relies on", () => {
    expect(isValidAccelerator("Control+Alt+Space")).toBe(true);
    for (const invalid of ["Shift+A", "A", "Command+Command+A", "Command+Bogus"]) expect(isValidAccelerator(invalid)).toBe(false);
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "option" }, "darwin")).toEqual({ kind: "chord", modifier: "option" });
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "option" }, "win32")).toBeNull();
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "fn" }, "darwin")).toBeNull();
    for (const taken of ["Command+C", "CmdOrCtrl+w", "CommandOrControl+,", "Shift+Command+4", "Command+Space"])
      expect(parseScreenBotShortcut({ kind: "accelerator", accelerator: taken }, "darwin")).toBeNull();
    expect(reservedShortcutReason("Command+Shift+2", "darwin")).toBeNull();
    expect(reservedShortcutReason("Control+Alt+E", "win32")).not.toBeNull(); // AltGr+E types €
    expect(reservedShortcutReason("Control+Alt+E", "darwin")).toBeNull();
  });

  test("saves a new shortcut, resets to the default, and pauses while recording", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenbot-shortcut-"));
    const settingsPath = join(directory, "screenbot-settings.json");
    const registered = new Set<string>();
    const statuses: ScreenBotShortcutStatus[] = [];
    let triggers = 0;
    const options = {
      platform: "win32" as const,
      settingsPath,
      helperPath: null,
      registerAccelerator: (accelerator: string, onPress: () => void) => {
        if (accelerator === "Control+Shift+T") return false; // owned by another app
        registered.add(accelerator);
        onPress();
        return true;
      },
      unregisterAccelerator: (accelerator: string) => void registered.delete(accelerator),
      onTrigger: () => { triggers += 1; },
      onStatus: (status: ScreenBotShortcutStatus) => void statuses.push(status),
    };
    try {
      const controller = new ScreenBotShortcutController(options);
      await controller.start();
      expect([...registered]).toEqual(["CommandOrControl+Shift+2"]);
      expect(controller.status()).toMatchObject({ isDefault: true, active: true, mode: "shortcut" });

      await controller.set({ kind: "accelerator", accelerator: "Control+Shift+K" });
      expect([...registered]).toEqual(["Control+Shift+K"]);
      expect(JSON.parse(await readFile(settingsPath, "utf8")).shortcut).toEqual({ kind: "accelerator", accelerator: "Control+Shift+K" });
      expect(controller.status().isDefault).toBe(false);

      controller.setRecording(true);
      expect(registered.size).toBe(0);
      controller.setRecording(false);
      expect([...registered]).toEqual(["Control+Shift+K"]);

      const taken = await controller.set({ kind: "accelerator", accelerator: "Control+Shift+T" });
      expect(taken).toMatchObject({ active: false, error: "Another app is using this shortcut." });

      await controller.set(null);
      expect([...registered]).toEqual(["CommandOrControl+Shift+2"]);
      expect(controller.status().isDefault).toBe(true);

      // A saved choice survives a restart.
      await controller.set({ kind: "accelerator", accelerator: "Control+Shift+K" });
      controller.dispose();
      expect(registered.size).toBe(0);
      const restarted = new ScreenBotShortcutController(options);
      await restarted.start();
      expect(restarted.status().shortcut).toEqual({ kind: "accelerator", accelerator: "Control+Shift+K" });
      restarted.dispose();
      await expect(restarted.set({ kind: "accelerator", accelerator: "Shift+A" })).rejects.toThrow();
      expect(triggers).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const helper = resolve(import.meta.dir, "../dist-electron/screenbot-keys");
  test.if(process.platform === "darwin" && existsSync(helper))("the native chord detector passes its self-test", async () => {
    const child = Bun.spawn([helper, "--self-test"], { stdout: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe("ok");
    expect(await child.exited).toBe(0);
  });
});
