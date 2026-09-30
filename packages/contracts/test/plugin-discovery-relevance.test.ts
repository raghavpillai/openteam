import { expect, test } from "bun:test";
import { rankPluginsLexically } from "../src/reference-formatters";

const plugins = [
  { name: "notes", displayName: "Notes", category: "productivity", description: "Search your notes", skills: [] },
  { name: "travel", displayName: "Travel", category: "travel", description: "Find flights and airfare", skills: [] },
];
test("subject queries exclude connectors matching only generic search words", () => {
  expect(rankPluginsLexically(plugins, "search live flights airfare travel").map((p: { name: string }) => p.name)).toEqual(["travel"]);
  expect(rankPluginsLexically(plugins, "search live hotels")).toEqual([]);
  expect(rankPluginsLexically(plugins, "search").map((p: { name: string }) => p.name)).toEqual(["notes"]);
  expect(rankPluginsLexically(plugins, "notes search").map((p: { name: string }) => p.name)).toEqual(["notes"]);
  expect(rankPluginsLexically(plugins, "")).toHaveLength(2);
});
