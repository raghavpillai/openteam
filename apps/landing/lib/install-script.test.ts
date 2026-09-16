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

  test("leaves Docker preflight to the installed CLI on both platforms", () => {
    expect(installScript).not.toContain("command_exists docker");
    expect(powerShellInstallScript).not.toContain("Get-Command docker");
    expect(installScript).toContain('"CLI installed"');
    expect(powerShellInstallScript).toContain('"CLI installed"');
    expect(installScript).toContain('"$installed_binary" install "$@" </dev/null');
  });

  test("ships a checksum-verified Windows installer", () => {
    expect(powerShellInstallScript).toContain('"openteam-windows-x64.exe"');
    expect(powerShellInstallScript).toContain("Get-FileHash -Algorithm SHA256");
    expect(powerShellInstallScript).toContain('Join-Path $env:LOCALAPPDATA "OpenTeam\\bin"');
    expect(powerShellInstallScript).toContain("& $installedBinary install @args");
  });

  test("prefers the gzip download and falls back to the raw binary", () => {
    expect(installScript).toContain('"$release_base/$asset_name.gz" -o "$binary_path.gz"');
    expect(installScript).toContain('gunzip -f "$binary_path.gz"');
    expect(installScript).toContain('"$release_base/$asset_name" -o "$binary_path"');
    expect(powerShellInstallScript).toContain('"$releaseBase/$assetName.gz"');
    expect(powerShellInstallScript).toContain("System.IO.Compression.GZipStream");
    expect(powerShellInstallScript).toContain(
      '"$releaseBase/$assetName" -UseBasicParsing -OutFile $binaryPath'
    );
  });

  test("download-script glyphs survive raw-template bundling", () => {
    for (const script of [installScript, powerShellInstallScript]) {
      expect(script).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    }
    expect(installScript).toContain("checkmark=$(printf '\\342\\234\\223')");
    expect(powerShellInstallScript).toContain("([char]0x2713)");
  });
});
