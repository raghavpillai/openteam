import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Bot desktop authentication UI parity", () => {
  test("uses compact desktop onboarding with accessible stage transitions", async () => {
    const [source, styles] = await Promise.all([
      read("../../src/renderer/components/openteam/auth-gate.tsx"),
      read("../../src/renderer/styles.css"),
    ]);

    expect(source).toContain("<BotAvatarGlyph");
    expect(source).toContain('className="auth-brand"');
    expect(source).toContain('className="auth-stage-frame"');
    expect(source).toContain('setStage("endpoint")');
    expect(source).toContain('setStage("credentials")');
    expect(source).toContain('setStage("welcome")');
    expect(source).toContain("inert={!endpointVisible}");
    expect(source).toContain("inert={!credentialsVisible}");
    expect(styles).toContain('.auth-stage-layer[aria-hidden="true"]');
    expect(source).toContain("ResizeObserver");
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
