import { expect, test } from "bun:test";
import { directoryPage } from "../directory";

test("directory paging keeps every record intact and sorts stable IDs", () => {
  const records = Array.from({ length: 75 }, (_, i) => ({
    uuid: String(i).padStart(3, "0"),
    name: "Contact " + i,
    profile: { givenName: "日本語 🐈" },
  })).reverse();
  const collected: unknown[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = directoryPage("contacts", records, { offset, limit: 13 });
    collected.push(...(page.contacts as unknown[]));
    offset = page.nextOffset;
  }
  expect(collected).toEqual([...records].reverse());
  expect(records[0]!.uuid).toBe("074");
});

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

test("empty and exhausted directory pages finish without a repeated cursor", () => {
  expect(directoryPage("contacts", []).nextOffset).toBeNull();
  expect(directoryPage("contacts", [{ uuid: "one" }], { offset: 1 })).toMatchObject({
    contacts: [],
    nextOffset: null,
    total: 1,
  });
});

test.each([
  { offset: -1 },
  { offset: 0.5 },
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
])("invalid directory pagination fails: %j", (options) => {
  expect(() => directoryPage("contacts", [], options)).toThrow();
});

test("invalid provider data and individually oversized records fail explicitly", () => {
  for (const value of [null, {}, [null], [[]]])
    expect(() => directoryPage("groups", value)).toThrow("invalid directory");
  expect(() => directoryPage("contacts", [{ uuid: "one", name: "x".repeat(80_000) }])).toThrow(
    "single directory entry"
  );
});
