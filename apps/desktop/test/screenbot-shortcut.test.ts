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
import { insertDictation } from "../src/renderer/screenbot/dictation";

describe("screenbot shortcuts", () => {
  test("defaults to both Command keys on macOS", () => {
    expect(defaultScreenBotShortcut("darwin")).toEqual({ kind: "chord", modifier: "command" });
    expect(defaultScreenBotShortcut("win32")).toEqual({ kind: "accelerator", accelerator: "CommandOrControl+Shift+2" });
  });

  test("accepts real shortcuts and both-key chords, and rejects the rest", () => {
    expect(isValidAccelerator("Command+Shift+2")).toBe(true);
    expect(isValidAccelerator("Control+Alt+Space")).toBe(true);
    expect(isValidAccelerator("Shift+A")).toBe(false); // would fire while typing capitals
    expect(isValidAccelerator("A")).toBe(false);
    expect(isValidAccelerator("Command+Command+A")).toBe(false);
    expect(isValidAccelerator("Command+Bogus")).toBe(false);
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "option" }, "darwin")).toEqual({ kind: "chord", modifier: "option" });
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "option" }, "win32")).toBeNull();
    expect(parseScreenBotShortcut({ kind: "chord", modifier: "fn" }, "darwin")).toBeNull();
    expect(parseScreenBotShortcut({ kind: "accelerator", accelerator: "Shift+2" }, "darwin")).toBeNull();
  });

  test("refuses shortcuts every app relies on, however they're spelled", () => {
    for (const taken of ["Command+C", "CmdOrCtrl+w", "Command+Q", "CommandOrControl+,", "Shift+Command+4", "Command+Tab", "Command+Space"]) {
      expect(reservedShortcutReason(taken, "darwin")).not.toBeNull();
      expect(parseScreenBotShortcut({ kind: "accelerator", accelerator: taken }, "darwin")).toBeNull();
    }
    expect(reservedShortcutReason("Command+Shift+2", "darwin")).toBeNull();
    expect(reservedShortcutReason("Control+C", "win32")).not.toBeNull();
    expect(reservedShortcutReason("Control+Alt+E", "win32")).not.toBeNull(); // AltGr+E types €
    expect(reservedShortcutReason("Control+Alt+E", "darwin")).toBeNull();
    expect(reservedShortcutReason("Control+Shift+2", "win32")).toBeNull();
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

describe("dictation", () => {
  test("inserts words at the caret with natural spacing", () => {
    expect(insertDictation("", 0, 0, " hello there ")).toEqual({ value: "hello there", caret: 11 });
    expect(insertDictation("Look at", 7, 7, "this chart")).toEqual({ value: "Look at this chart", caret: 18 });
    expect(insertDictation("Look at.", 7, 7, "this")).toEqual({ value: "Look at this.", caret: 12 });
    expect(insertDictation("one three", 4, 4, "two")).toEqual({ value: "one two three", caret: 7 });
    expect(insertDictation("replace ME please", 8, 10, "you")).toEqual({ value: "replace you please", caret: 11 });
    expect(insertDictation("keep", 4, 4, "   ")).toEqual({ value: "keep", caret: 4 });
  });
});
