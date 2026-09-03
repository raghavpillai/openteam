import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (relativePath: string) =>
  readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");

describe("Grok window chrome parity", () => {
  test("uses the measured macOS traffic-light inset", async () => {
    const main = await source("main/index.ts");

    expect(main).toContain(
      'titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"'
    );
    expect(main).toContain("trafficLightPosition: { x: 16, y: 15 }");
  });

  test("matches the top-right and compact-sidebar bottom edge spacing", async () => {
    const [header, sidebar] = await Promise.all([
      source("renderer/components/openteam/desktop-header.tsx"),
      source("renderer/components/openteam/sidebar.tsx"),
    ]);

    expect(header).toContain(
      '"absolute inset-y-0 right-3 flex items-center transition-opacity duration-150"'
    );
    expect(sidebar).toContain('className="flex shrink-0 flex-col items-center gap-0 pb-2 pt-2"');
  });

  test("uses Grok's exact compact-sidebar footer controls and geometry", async () => {
    const sidebar = await source("renderer/components/openteam/sidebar.tsx");
    const compactFooter = sidebar.slice(
      sidebar.indexOf("function CompactSidebarContent"),
      sidebar.indexOf("const SIDEBAR_WIDTH_KEY")
    );

    expect(compactFooter).toContain('aria-label="Expand sidebar"');
    expect(compactFooter).toContain('<PanelLeft className="h-3.5 w-[18px]" strokeWidth={1.8} />');
    expect(compactFooter).toContain('className="size-7 rounded-[7px] p-0');
    expect(compactFooter).toContain('<Plus className="size-5" strokeWidth={1.8} />');
    expect(compactFooter).not.toContain('aria-label="Plugins"');
    expect(compactFooter).toContain('className="mt-1.5 size-[54px] rounded-[11px]');
    expect(compactFooter).toContain(
      "border-[0.5px] border-[#cbcbcb] bg-[#e6e6e6] text-[13px] font-medium text-[#575757]"
    );
    expect(sidebar).toContain("onToggleCompact={toggleCompactSidebar}");
  });
});
