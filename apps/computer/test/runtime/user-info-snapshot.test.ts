import { expect, test } from "bun:test";
import { pinUserInfo } from "../../src/runtime/user-info-snapshot";
import { enrichUserInfo, renderDynamicToolCatalog } from "../../src/runtime/prompt-context";
import { pinDynamicToolCatalog } from "../../src/runtime/catalog-snapshot";

const log = () => {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  return {
    getEntries: () => entries,
    appendCustomEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
  };
};

test("first epoch preserves the reference layout exactly; the next epoch adopts live context", () => {
  const session = log();
  const original = enrichUserInfo(
    "<user_info>\nToday's date: Friday Nov 13, 2026\n</user_info>\n\n<teammates>old</teammates>",
    { cwd: "/workspace", catalog: null }
  );
  const catalog = renderDynamicToolCatalog([{ name: "gmail", tools: [{ name: "Search" }] }]);
  const first = pinUserInfo(session, 0, original, catalog);
  expect(first.content).toBe(
    enrichUserInfo(
      "<user_info>\nToday's date: Friday Nov 13, 2026\n</user_info>\n\n<teammates>old</teammates>",
      { cwd: "/workspace", catalog }
    )
  );
  expect(first.update).toBeNull();
  const changed = original
    .replace("Friday Nov 13", "Saturday Nov 14")
    .replace("old</teammates>", "new</teammates>");
  const next = pinUserInfo(session, 1, changed, null);
  expect(next.content).toBe(changed);
  expect(next.update).toBeNull();
  expect(pinUserInfo(session, 1, changed, null).content).toBe(changed);
});

test("failed delivery retries; successful delivery survives a serialized restart without repeating", () => {
  const session = log();
  const first = pinUserInfo(session, 0, "original", null);
  const failed = pinUserInfo(session, 0, "changed", null);
  expect(failed.content).toBe(first.content);
  expect(failed.update).not.toBeNull();
  // Simulate a sendCustomMessage failure by withholding acknowledgement.
  const retry = pinUserInfo(session, 0, "changed", null);
  expect(retry.update).toBe(failed.update);
  retry.acknowledge();
  const restored = log();
  for (const entry of JSON.parse(JSON.stringify(session.getEntries())))
    restored.appendCustomEntry(entry.customType, entry.data);
  expect(pinUserInfo(restored, 0, "changed", null)).toMatchObject({
    content: "original",
    update: null,
  });
  const reverted = pinUserInfo(restored, 0, "original", null);
  expect(reverted.update).not.toBeNull();
  reverted.acknowledge();
  expect(pinUserInfo(restored, 0, "original", null).update).toBeNull();
});

test("removed sections explicitly clear old data and do not rewrite the original message", () => {
  const session = log();
  const original =
    "<user_info>date</user_info>\n\n<teammates>removed bot</teammates>\n\n<agent_skills>removed skill</agent_skills>";
  pinUserInfo(session, 0, original, null);
  const removed = pinUserInfo(session, 0, "<user_info>new date</user_info>", null);
  expect(removed.content).toBe(original);
  expect(removed.update).toContain("A section omitted below is now empty.");
  expect(removed.update).not.toContain("removed bot");
  expect(removed.update).not.toContain("removed skill");
});

test("full-context updates cannot reintroduce an outdated tool catalog", () => {
  const session = log();
  const initial = [{ name: "cursor", tools: [{ name: "Old" }] }];
  const changed = [{ name: "cursor", tools: [{ name: "New" }] }];
  const toolStart = pinDynamicToolCatalog(session, 0, initial);
  const start = pinUserInfo(session, 0, "original", toolStart.catalog);
  const toolUpdate = pinDynamicToolCatalog(session, 0, changed);
  expect(toolUpdate.update).toContain('tools="New"');
  const userUpdate = pinUserInfo(session, 0, "new roster", toolUpdate.catalog);
  expect(userUpdate.content).toBe(start.content);
  expect(userUpdate.update).not.toContain("<dynamic_tool_catalog>");
  expect(userUpdate.update).not.toContain('tools="Old"');
  expect(userUpdate.update).toContain("its separate updates still apply");
  userUpdate.acknowledge();
  expect(pinUserInfo(session, 0, "new roster", toolUpdate.catalog).update).toBeNull();
  expect(pinDynamicToolCatalog(session, 0, changed).update).toBeNull();
});

test("contexts with the same epoch keep independent opening snapshots", () => {
  const a = log(),
    b = log();
  pinUserInfo(a, 0, "A", null);
  pinUserInfo(b, 0, "B", null);
  expect(pinUserInfo(a, 0, "current", null).content).toBe("A");
  expect(pinUserInfo(b, 0, "current", null).content).toBe("B");
});
