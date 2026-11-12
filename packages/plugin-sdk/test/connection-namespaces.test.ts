import { expect, test } from "bun:test";
import { connectionNamespaces } from "../src";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

test("a newer colliding connection gets a short id suffix and the older keeps its name", () => {
  const older = { id: "11111111-aaaa-4000-8000-000000000001", name: "Linear", alias: "default", createdAt: at(1) };
  const newer = { id: "22222222-bbbb-4000-8000-000000000002", name: "linear", alias: "default", createdAt: at(2) };
  const cursor = { id: "33333333-cccc-4000-8000-000000000003", name: "Cursor", alias: "default", createdAt: at(3) };
  const names = connectionNamespaces([newer, cursor, older]);
  expect(names.get(older.id)).toBe("linear");
  expect(names.get(newer.id)).toBe("linear-222222");
  // The first-party namespace name is reserved.
  expect(names.get(cursor.id)).toBe("cursor-333333");
  expect(new Set(names.values()).size).toBe(3);
  expect(connectionNamespaces([{ id: "x", name: "★", alias: "☆", createdAt: at(1) }]).get("x")).toBe("connector--account");
});
