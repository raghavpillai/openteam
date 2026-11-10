import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Published docs name app controls in bold, e.g. **Settings → General → Timezone** or "choose **Save**".
// When a control is renamed or removed, the docs keep pointing at it. This test fails until every such
// label still exists as text in the desktop app, the iPhone app, or a bundled plugin manifest.

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const docsDirectory = path.join(repositoryRoot, "docs");

const SOURCE_DIRECTORIES = [
  "apps/desktop/src",
  "apps/ios/Sources",
  "apps/ios/Resources",
  "apps/cli/src",
  "apps/server/src/routes",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".swift", ".strings", ".plist", ".json"]);

// Labels from other products' screens (Slack, Google Cloud, Apple, Tailscale, mail providers) and
// example device names. Add a label here only when it isn't OpenTeam's own UI text.
const EXTERNAL_LABELS = new Set<string>(["Apple Push Notification service", "MacBook Air", "Mac mini"]);

// Labels the apps build at runtime, so no source file contains them whole. Name where each one is built.
const ASSEMBLED_LABELS = new Set<string>([
  "Use for Search", // apps/ios/Sources/App/ProvidersSettingsView.swift: "Use for " + WebTool.title
  "Use for Fetch",
]);

const ACTION_BEFORE_BOLD =
  /\b(?:choose|chooses|select|selects|open|opens|tap|taps|click|clicks|press|presses|turn on|turn off|enable|disable|toggle|then|use|under|in|from|find)\s+(?:the\s+)?$/i;

function walk(directory: string, files: string[] = []) {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (SOURCE_EXTENSIONS.has(path.extname(name))) files.push(full);
  }
  return files;
}

function normalize(text: string) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&apos;|\\'/g, "'")
    .replace(/\s+/g, " ");
}

function sourceCorpus() {
  const files = SOURCE_DIRECTORIES.flatMap((directory) => walk(path.join(repositoryRoot, directory)));
  const plugins = path.join(repositoryRoot, "packages/plugins");
  for (const name of readdirSync(plugins)) {
    const manifest = path.join(plugins, name, "plugin.json");
    try {
      if (statSync(manifest).isFile()) files.push(manifest);
    } catch {}
  }
  return normalize(files.map((file) => readFileSync(file, "utf8")).join("\n"));
}

function publishedPages(): string[] {
  const config = JSON.parse(readFileSync(path.join(docsDirectory, "config.json"), "utf8")) as {
    groups: { pages: { file: string }[] }[];
  };
  return config.groups.flatMap((group) => group.pages.map((page) => page.file));
}

export interface UiLabel {
  file: string;
  line: number;
  label: string;
}

/** Bold spans that name app controls: arrow paths, and bold text right after an action word. */
export function uiLabels(file: string, markdown: string): UiLabel[] {
  const labels: UiLabel[] = [];
  let inCode = false;
  markdown.split("\n").forEach((text, index) => {
    if (text.trimStart().startsWith("```")) inCode = !inCode;
    if (inCode) return;
    const withoutCode = text.replace(/`[^`]*`/g, "``");
    for (const match of withoutCode.matchAll(/\*\*([^*]+)\*\*/g)) {
      const bold = match[1].trim();
      const before = withoutCode.slice(0, match.index);
      const isPath = bold.includes("→");
      if (!isPath && !ACTION_BEFORE_BOLD.test(before)) continue;
      for (const part of bold.split("→")) {
        const label = normalize(part.trim()).replace(/[.:]$/, "");
        // Skip placeholders ("Stop <bot>"), truncated labels ("No internet through…"), keyboard
        // shortcuts ("⌘K", "Ctrl+K") and plain values ("10 GiB").
        if (label.length < 2 || /[<>…⌘⌥⇧]|\.\.\./.test(label) || /^(?:ctrl|cmd|alt|shift)\+/i.test(label)) continue;
        if (/^[\d\s.,%×x-]+(?:[KMGT]i?B)?$/i.test(label)) continue;
        labels.push({ file, line: index + 1, label });
      }
    }
  });
  return labels;
}

describe("docs UI labels", () => {
  test("detects arrow paths and labels after action words", () => {
    const found = uiLabels(
      "page.md",
      "Open **Settings → General**, then choose **Save**. A **bold idea** stays prose.\n`**Code → Ignored**`"
    ).map((entry) => entry.label);
    expect(found).toEqual(["Settings", "General", "Save"]);
  });

  test("every UI label in the published docs exists in the apps", () => {
    const corpus = sourceCorpus();
    const missing = publishedPages()
      .flatMap((file) => uiLabels(file, readFileSync(path.join(docsDirectory, file), "utf8")))
      .filter((entry) => !EXTERNAL_LABELS.has(entry.label) && !ASSEMBLED_LABELS.has(entry.label))
      .filter((entry) => !corpus.includes(entry.label))
      .map((entry) => `docs/${entry.file}:${entry.line}: ${entry.label}`);
    expect(missing).toEqual([]);
  });
});
