import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grok desktop authentication UI parity", () => {
  test("keeps the source-verified desktop landing geometry", async () => {
    const source = await read("../src/renderer/components/openbot/auth-gate.tsx");

    expect(source).toContain("size-16");
    expect(source).toContain("text-[68px]");
    expect(source).toContain("leading-[48px]");
    expect(source).toContain("tracking-[-0.68px]");
    expect(source).toContain("mb-12");
    expect(source).toContain("max-w-[336px]");
    expect(source).toContain("text-[22px]");
    expect(source).toContain("mb-10");
    expect(source).toContain("min-h-24");
    expect(source).toContain("translate-y-10");
    expect(source).toContain("rounded-full");
  });

  test("keeps username and password authentication native", async () => {
    const source = await read("../src/renderer/components/openbot/auth-gate.tsx");

    expect(source).toContain('autoComplete="username"');
    expect(source).toContain('autoComplete="current-password"');
    expect(source).toContain('type="password"');
    expect(source).toContain("await signIn(username, password)");
    expect(source).not.toContain("openExternal");
    expect(source).not.toContain("browser");
  });
});
