import { describe, expect, test } from "bun:test";
import { installScript, powerShellInstallScript } from "./install-script";

describe("install script", () => {
  test("is a POSIX shell script with supported host detection", () => {
    expect(installScript.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
    expect(installScript).toContain('Darwin) platform="macOS"');
    expect(installScript).toContain('Linux) platform="Linux"');
    expect(installScript).toContain('x86_64|amd64) architecture="x64"');
    expect(installScript).toContain('arm64|aarch64) architecture="arm64"');
  });

  test("preserves version overrides and an interactive terminal", () => {
    expect(installScript).toContain("printenv OPENTEAM_VERSION");
    expect(installScript).toContain("releases/latest");
    expect(installScript).toContain('asset_name="openteam-$binary_os-$architecture"');
    expect(installScript).toContain("SHA256SUMS");
    expect(installScript).toContain('installed_binary="$bin_directory/openteam"');
    expect(installScript).toContain('"$installed_binary" install "$@" </dev/tty');
  });

  test("accepts both Docker Compose command forms", () => {
    expect(installScript).toContain("docker compose version");
    expect(installScript).toContain("command_exists docker-compose");
    expect(installScript).toContain("docker-compose version");
    expect(powerShellInstallScript).toContain("Get-Command docker-compose");
  });

  test("ships a checksum-verified Windows installer", () => {
    expect(powerShellInstallScript).toContain('"openteam-windows-x64.exe"');
    expect(powerShellInstallScript).toContain("Get-FileHash -Algorithm SHA256");
    expect(powerShellInstallScript).toContain('Join-Path $env:LOCALAPPDATA "OpenTeam\\bin"');
    expect(powerShellInstallScript).toContain("& $installedBinary install @args");
  });
});
