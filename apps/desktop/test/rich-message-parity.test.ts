import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentPath = new URL(
  "../src/renderer/components/openbot/rich-message.tsx",
  import.meta.url
);
const stylesPath = new URL("../src/renderer/styles.css", import.meta.url);
const mobileComponentPath = new URL(
  "../../mobile/src/components/rich-message-card.tsx",
  import.meta.url
);

describe("Grok rich-message visual contract", () => {
  test("uses the renderer-matched card, option panel, and field geometry", async () => {
    const source = await readFile(componentPath, "utf8");

    expect(source).toContain("flex w-full max-w-[520px]");
    expect(source).toContain("rounded-2xl");
    expect(source).toContain("p-3");
    expect(source).toContain("gap-2.5");
    expect(source).toContain("rounded-lg border-[0.5px]");
    expect(source).toContain("gap-2 p-2");
    expect(source).toContain("min-w-[18px]");
    expect(source).toContain("size-5 shrink-0");
    expect(source).toContain("min-h-8");
    expect(source).toContain("px-2.5 py-[5px]");
  });

  test("keeps the same renderer geometry on mobile", async () => {
    const source = await readFile(mobileComponentPath, "utf8");

    expect(source).toContain("borderRadius: 16");
    expect(source).toContain("padding: 12");
    expect(source).toContain("gap: 10");
    expect(source).toContain("borderRadius: 8");
    expect(source).toContain("padding: 8");
    expect(source).toContain("minWidth: 18");
    expect(source).toMatch(/dismissButton:\s*\{\s*width: 20,\s*height: 20,/);
    expect(source).toContain("minHeight: 32");
  });

  test("matches Grok's entrance and conditional-submit motion", async () => {
    const source = await readFile(stylesPath, "utf8");

    expect(source).toContain("translateY(8px) scale(0.985)");
    expect(source).toContain("320ms cubic-bezier(0.22, 1, 0.36, 1)");
    expect(source).toContain("translateX(6px) scale(0.96)");
    expect(source).toContain("160ms cubic-bezier(0.22, 1, 0.36, 1)");
    expect(source).toContain("120ms ease-out");
  });

  test("keeps Grok's literal widget copy and accessibility contract on both clients", async () => {
    const [desktop, mobile] = await Promise.all([
      readFile(componentPath, "utf8"),
      readFile(mobileComponentPath, "utf8"),
    ]);

    for (const source of [desktop, mobile]) {
      expect(source).toContain('placeholder="Type your own answer"');
      expect(source).not.toContain('placeholder="Write another answer"');
      expect(source).toContain("Your answer");
      expect(source).toContain("Custom answer");
      expect(source).toContain("Dismiss question");
      expect(source).not.toContain('option.style === "danger"');
      expect(source).not.toContain("Submit custom answer");
    }
    expect(desktop).toContain('title="Dismiss without answering"');
  });

  test("keeps Grok's secure-request copy and field treatment on both clients", async () => {
    const [desktop, mobile] = await Promise.all([
      readFile(componentPath, "utf8"),
      readFile(mobileComponentPath, "utf8"),
    ]);

    for (const source of [desktop, mobile]) {
      expect(source).toContain("Save securely");
      expect(source).toContain("Stored securely, never shown to your Bot.");
      expect(source).toContain("Saved securely and kept private.");
      expect(source).not.toContain("Credential provided");
      expect(source).not.toContain("Saved to the connector, never sent in chat.");
      expect(source).toContain('autoComplete="off"');
      expect(source).toContain("spellCheck={false}");
    }
    expect(desktop).toContain('type="password"');
    expect(mobile).toContain("secureTextEntry");
  });
});
