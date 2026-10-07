import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (relativePath: string) =>
  readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");

describe("Bot window chrome parity", () => {
  test("uses the measured macOS traffic-light inset", async () => {
    const main = await source("main/index.ts");

    expect(main).toContain(
      'titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"'
    );
    expect(main).toContain("trafficLightPosition: { x: 16, y: 15 }");
  });

  test("lets the whole chat header move the window while its buttons stay clickable", async () => {
    const [header, styles] = await Promise.all([
      source("renderer/components/openteam/desktop-header.tsx"),
      source("renderer/styles.css"),
    ]);

    expect(header).toContain('<header className="electron-drag pointer-events-none absolute');
    expect(header).not.toContain('"electron-no-drag pointer-events-auto relative h-full');
    expect(styles).toMatch(/\.electron-no-drag,\s*button,/);
  });

  test("matches the top-right and compact-sidebar bottom edge spacing", async () => {
    const [header, sidebar] = await Promise.all([
      source("renderer/components/openteam/desktop-header.tsx"),
      source("renderer/components/openteam/sidebar.tsx"),
    ]);

    expect(header).toContain(
      '"absolute inset-y-0 right-3 flex items-center transition-opacity duration-[var(--motion-reveal)] ease-[var(--ease-pane)]"'
    );
    expect(sidebar).toContain('className="flex shrink-0 flex-col items-center gap-0 pt-2"');
  });

  test("uses Bot's exact compact-sidebar footer controls and geometry", async () => {
    const sidebar = await source("renderer/components/openteam/sidebar.tsx");
    const compactFooter = sidebar.slice(
      sidebar.indexOf("function CompactSidebarContent"),
      sidebar.indexOf("const SIDEBAR_WIDTH_KEY")
    );

    expect(compactFooter).not.toContain('aria-label="Expand sidebar"');
    expect(sidebar).not.toContain("<PanelLeft");
    expect(compactFooter).toContain('className="size-7 rounded-[7px] p-0');
    expect(compactFooter).toContain('<Plus className="size-5" strokeWidth={1.8} />');
    expect(compactFooter).not.toContain('aria-label="Plugins"');
    expect(sidebar).toContain('data-sidebar-account-avatar=""');
    expect(sidebar).toContain("toggleCompactSidebar");
    expect(compactFooter).toContain("<UnreadJumpPill");
  });
});
