import { expect, test } from "bun:test";
import { directoryPage } from "../directory";

test("encoded size determines page boundaries below the host's string limit", () => {
  const records = Array.from({ length: 120 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    name: "Group " + i,
    metadata: '\u0000\\"🐈'.repeat(500),
  }));
  const collected: unknown[] = [];
  let offset: number | null = 0,
    pages = 0;
  while (offset !== null) {
    const page = directoryPage("groups", records, { offset, limit: 100 });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(70_000);
    expect((page.groups as unknown[]).length).toBeGreaterThan(0);
    collected.push(...(page.groups as unknown[]));
    offset = page.nextOffset;
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(collected).toEqual(records);
});

test("invalid provider data and individually oversized records fail explicitly", () => {
  for (const value of [null, {}, [null], [[]]])
    expect(() => directoryPage("groups", value)).toThrow("invalid directory");
  expect(() => directoryPage("contacts", [{ uuid: "one", name: "x".repeat(80_000) }])).toThrow(
    "single directory entry"
  );
});
