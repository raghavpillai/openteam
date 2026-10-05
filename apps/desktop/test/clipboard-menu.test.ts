import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "../src/main/application-menu";

test("Edit clipboard actions route to the computer only when it owns focus", () => {
  let computerActive = true;
  const remote: string[] = [];
  const local: string[] = [];
  const window = { webContents: { copy: () => local.push("copy"), cut: () => local.push("cut"), paste: () => local.push("paste") } };
  const template = applicationMenuTemplate("darwin", () => {}, action => {
    if (!computerActive) return false;
    remote.push(action); return true;
  });
  const submenu = template.find(item => item.label === "Edit")?.submenu as MenuItemConstructorOptions[];
  for (const label of ["Copy", "Cut", "Paste"]) {
    const item = submenu.find(item => item.label === label)!;
    (item.click as Function)(item, window, {});
  }
  expect(remote).toEqual(["copy", "cut", "paste"]);
  expect(local).toEqual([]);
  computerActive = false;
  for (const label of ["Copy", "Cut", "Paste"]) {
    const item = submenu.find(item => item.label === label)!;
    (item.click as Function)(item, window, {});
  }
  expect(local).toEqual(["copy", "cut", "paste"]);
  expect(remote).toHaveLength(3);
});
