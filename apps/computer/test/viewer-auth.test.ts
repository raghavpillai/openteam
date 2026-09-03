import { describe, expect, test } from "bun:test";
import { createViewerPassword } from "../src/screen-broker";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("screen viewer authentication", () => {
  test("generates the full 48 bits supported by classic VNC authentication", () => {
    const passwords = new Set(Array.from({ length: 32 }, createViewerPassword));

    expect(passwords.size).toBe(32);
    for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  test("requires a private password file instead of launching x11vnc without auth", async () => {
    const source = await read("../src/screen-broker.ts");

    expect(source).toContain('"-passwdfile"');
    expect(source).toContain('join(session.runtimeDirectory, "viewer-password")');
    expect(source).toContain("{ mode: 0o600 }");
    expect(source).not.toContain('"-nopw"');
  });

  test("reads the credential from the URL fragment and removes it before connecting", async () => {
    const source = await read("../../../docker/openbot-vnc.html");

    expect(source).toContain("window.location.hash.slice(1)");
    expect(source).toContain("credentials: { password }");
    expect(source).toContain("history.replaceState");
    expect(source).not.toContain('query.get("password")');
  });

  test("reconnects dropped viewers with bounded backoff but stops on an authentication failure", async () => {
    const source = await read("../../../docker/openbot-vnc.html");

    expect(source).toContain('connection.addEventListener("disconnect"');
    expect(source).toContain("scheduleReconnect()");
    expect(source).toContain("Math.min(reconnectDelayMs * 2, 5_000)");
    expect(source).toContain('connection.addEventListener("securityfailure"');
    expect(source).toContain("shouldReconnect = false");
    expect(source).toContain("screen.dataset.connectionState = state");
  });
});
