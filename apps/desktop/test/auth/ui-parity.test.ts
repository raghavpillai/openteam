import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grok desktop authentication UI parity", () => {
  test("matches the animated glass mobile onboarding treatment", async () => {
    const [source, styles] = await Promise.all([
      read("../../src/renderer/components/openteam/auth-gate.tsx"),
      read("../../src/renderer/styles.css"),
    ]);

    expect(source).toContain("<AuthBotField />");
    expect(source).toContain("<BotAvatarGlyph");
    expect(source).toContain('data-exits={index >= 6 ? "true" : undefined}');
    expect(source).toContain('className="auth-glass auth-brand-card"');
    expect(source).toContain('className="auth-stage-frame"');
    expect(source).toContain('setStage("endpoint")');
    expect(source).toContain('setStage("credentials")');
    expect(source).toContain('setStage("welcome")');
    expect(styles).toContain("@keyframes auth-bot-idle");
    expect(styles).toContain("backdrop-filter: blur(28px) saturate(155%)");
    expect(styles).toContain('.auth-shell[data-stage="endpoint"]');
    expect(styles).toContain('.auth-shell[data-stage="credentials"]');
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("keeps username and password authentication native", async () => {
    const source = await read("../../src/renderer/components/openteam/auth-gate.tsx");

    expect(source).toContain('autoComplete="username"');
    expect(source).toContain('autoComplete="current-password"');
    expect(source).toContain('type="password"');
    expect(source).toContain("await signIn(username, password)");
    expect(source).toContain("Back");
    expect(source).not.toContain("openExternal");
    expect(source).not.toContain("browser");
  });

  test("verifies and persists a configurable endpoint before credentials", async () => {
    const source = await read("../../src/renderer/components/openteam/auth-gate.tsx");

    expect(source).toContain('autoComplete="url"');
    expect(source).toContain('type="url"');
    expect(source).toContain("await testServerConnection(serverUrl)");
    expect(source).toContain("saveConfiguredApiBase(localStorage, connection.baseUrl)");
    expect(source).toContain("await clearAuthCredentialsForServerChange()");
    expect(source).toContain("await signInToServer(connectedApiBase, username, password)");
    expect(source).toContain("window.location.reload()");
  });
});
