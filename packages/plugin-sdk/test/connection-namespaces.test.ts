import { expect, test } from "bun:test";
import { connectionNamespaces } from "../src";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

test("namespaces are readable service names with the account after --", () => {
  const names = connectionNamespaces([
    { id: "a1b2c3d4-0000-4000-8000-000000000001", name: "Gmail", alias: "default", createdAt: at(1) },
    { id: "a1b2c3d4-0000-4000-8000-000000000002", name: "Gmail", alias: "personal 2", createdAt: at(2) },
    { id: "a1b2c3d4-0000-4000-8000-000000000003", name: "Google Calendar", alias: "Zealot", createdAt: at(3) },
    { id: "a1b2c3d4-0000-4000-8000-000000000004", name: "Slack (stealth)", alias: "default", createdAt: at(4) },
    { id: "a1b2c3d4-0000-4000-8000-000000000005", name: "Plaid (Sandbox)", alias: "default", createdAt: at(5) },
  ]);
  expect([...names.values()]).toEqual(["gmail", "gmail--personal-2", "google-calendar--zealot", "slack-stealth", "plaid-sandbox"]);
});

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
