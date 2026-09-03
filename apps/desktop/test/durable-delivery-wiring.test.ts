import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

describe("desktop durable delivery wiring", () => {
  test("keeps journals in the trusted host and migrates legacy renderer storage", async () => {
    const [main, preload, renderer, environment] = await Promise.all([
      source("main/index.ts"),
      source("preload/index.ts"),
      source("renderer/lib/durable-sends.ts"),
      source("renderer/env.d.ts"),
    ]);

    expect(main).toContain('ipcMain.handle("openteam:delivery-journal:read"');
    expect(main).toContain('ipcMain.handle("openteam:delivery-journal:write"');
    expect(main).toContain("requireDeliveryStageSender(event)");
    expect(preload).toContain('ipcRenderer.invoke("openteam:delivery-journal:read"');
    expect(preload).toContain('ipcRenderer.invoke("openteam:delivery-journal:write"');
    expect(environment).toContain("deliveryJournal:");
    expect(renderer).toContain("window.openteam?.deliveryJournal");
    expect(renderer).toContain("localStorage.removeItem(storageKey(scope))");
  });

  test("tears down account-scoped controllers and records delivery transitions", async () => {
    const renderer = await source("renderer/lib/durable-sends.ts");

    expect(renderer).toContain("subscribeAuthSnapshot");
    expect(renderer).toContain("disposeInactiveControllers");
    expect(renderer).toContain("controller.dispose()");
    expect(renderer).toContain("onTelemetry:");
    expect(renderer).toContain("recordPerformance(`delivery.${event.outcome}`");
  });
});
