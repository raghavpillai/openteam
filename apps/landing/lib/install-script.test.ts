import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("gives up on a stalled download instead of waiting forever", () => {
    const downloads = installScript.split("\n").filter((line) => line.includes("curl -f"));
    expect(downloads).toHaveLength(4);
    for (const line of downloads) expect(line).toContain("--speed-limit 1 --speed-time 20");
    expect(installScript).toContain(
      'fail "could not look up the latest OpenTeam release on GitHub. Check your internet connection and try again, or set OPENTEAM_VERSION to install a specific version."'
    );
  });

  test("download-script glyphs survive raw-template bundling", () => {
    for (const script of [installScript, powerShellInstallScript]) {
      expect(script).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    }
    expect(installScript).toContain("checkmark=$(printf '\\342\\234\\223')");
    expect(powerShellInstallScript).toContain("([char]0x2713)");
  });

  test("PowerShell puts the CLI on PATH for new terminals and this one", () => {
    expect(powerShellInstallScript).toContain(
      '[Environment]::SetEnvironmentVariable("Path", $newPath, "User")'
    );
    expect(powerShellInstallScript).toContain("$env:Path =");
    expect(powerShellInstallScript).toContain('$env:OPENTEAM_NO_MODIFY_PATH -ne "1"');
  });
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Run the real installer against local release files. A fake curl serves them, a fake
 * uname picks the platform, and the installed "CLI" only records that setup was handed off.
 */
const runInstaller = async (
  options: {
    shell?: string;
    os?: "Darwin" | "Linux";
    env?: (home: string) => Record<string, string>;
    files?: Record<string, string>;
    binDirectory?: (home: string) => string;
    onPath?: boolean;
  } = {}
) => {
  const root = mkdtempSync(join(tmpdir(), "openteam-installer-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const tools = join(root, "tools");
  const assets = join(root, "assets");
  for (const directory of [home, tools, assets]) mkdirSync(directory);
  const cli = "#!/bin/sh\nprintf 'handoff %s\\n' \"$*\"\n";
  const checksum = createHash("sha256").update(cli).digest("hex");
  const names = ["darwin", "linux"].flatMap((os) =>
    ["x64", "arm64"].map((arch) => `openteam-${os}-${arch}`)
  );
  for (const name of names) writeFileSync(join(assets, name), cli);
  writeFileSync(join(assets, "SHA256SUMS"), names.map((name) => `${checksum}  ${name}\n`).join(""));
  writeFileSync(
    join(tools, "curl"),
    `#!/bin/sh
output=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
source="${assets}/$(basename "$url")"
[ -f "$source" ] || exit 22
cp "$source" "$output"
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(tools, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${options.os ?? "Linux"} ;; *) echo x86_64 ;; esac\n`,
    { mode: 0o755 }
  );
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), contents);
  }
  const script = join(root, "install.sh");
  writeFileSync(script, installScript);
  const binDirectory = options.binDirectory?.(home) ?? join(home, ".local", "bin");
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin${options.onPath ? `:${binDirectory}` : ""}`,
    OPENTEAM_VERSION: "0.0.1",
    NO_COLOR: "1",
    TERM: "dumb",
    ...(options.shell ? { SHELL: options.shell } : {}),
    ...(options.binDirectory ? { OPENTEAM_BIN_DIR: binDirectory } : {}),
    ...options.env?.(home),
  };
  const run = async () => {
    const child = Bun.spawn(["/bin/sh", script, "--dir", join(root, "server")], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output: `${stdout}${stderr}`, code };
  };
  const read = (path: string) =>
    existsSync(join(home, path)) ? readFileSync(join(home, path), "utf8") : null;
  return { home, binDirectory, run, read };
};

const resolvesOpenTeam = async (shell: string, profile: string, home: string) => {
  const child = Bun.spawn([shell, "-c", `. '${profile}'; command -v openteam`], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout.trim();
};

describe.skipIf(process.platform === "win32")("installer PATH setup", () => {
  test("adds the CLI to zsh once, honoring ZDOTDIR, and hands off with the absolute path", async () => {
    const installer = await runInstaller({
      shell: "/bin/zsh",
      os: "Darwin",
      env: () => ({ ZDOTDIR: "" }),
    });
    const first = await installer.run();
    expect(first.code).toBe(0);
    expect(first.output).toContain(
      "Added ~/.local/bin to your PATH in ~/.zshrc. Open a new terminal to use openteam."
    );
    expect(first.output).toContain("handoff install --dir");
    const profile = installer.read(".zshrc");
    expect(profile).toBe(
      `# Added by the OpenTeam installer\nexport PATH='${installer.binDirectory}':"$PATH"\n`
    );
    const second = await installer.run();
    expect(second.output).toContain("Open a new terminal to use openteam.");
    expect(second.output).not.toContain("Added ~/.local/bin");
    expect(installer.read(".zshrc")).toBe(profile);

    const custom = await runInstaller({
      shell: "/usr/local/bin/zsh",
      files: { "zsh-config/.zshrc": "alias ll='ls -l'" },
      env: (home) => ({ ZDOTDIR: join(home, "zsh-config") }),
    });
    expect((await custom.run()).output).toContain("in ~/zsh-config/.zshrc.");
    expect(custom.read("zsh-config/.zshrc")).toStartWith(
      "alias ll='ls -l'\n# Added by the OpenTeam installer\nexport PATH="
    );
    expect(custom.read(".zshrc")).toBeNull();
  });

  test("bash on macOS updates .bashrc and the login profile Terminal reads", async () => {
    const fresh = await runInstaller({ shell: "/bin/bash", os: "Darwin" });
    expect((await fresh.run()).output).toContain(
      "Added ~/.local/bin to your PATH in ~/.bashrc and ~/.bash_profile."
    );
    expect(fresh.read(".bash_profile")).toContain("# Added by the OpenTeam installer");

    // Creating .bash_profile would stop bash from reading an existing .profile.
    const existing = await runInstaller({
      shell: "/bin/bash",
      os: "Darwin",
      files: { ".profile": "export EDITOR=vi\n" },
    });
    expect((await existing.run()).output).toContain("in ~/.bashrc and ~/.profile.");
    expect(existing.read(".bash_profile")).toBeNull();
    expect(existing.read(".profile")).toStartWith(
      "export EDITOR=vi\n\n# Added by the OpenTeam installer\n"
    );
  });

  test("bash on Linux updates only .bashrc, and other shells use .profile", async () => {
    const bash = await runInstaller({ shell: "/bin/bash", os: "Linux" });
    expect((await bash.run()).output).toContain("Added ~/.local/bin to your PATH in ~/.bashrc.");
    expect(bash.read(".bash_profile")).toBeNull();
    expect(bash.read(".profile")).toBeNull();

    for (const shell of [undefined, "/bin/dash"]) {
      const other = await runInstaller({ shell, os: "Linux" });
      expect((await other.run()).output).toContain("in ~/.profile.");
      expect(other.read(".profile")).toContain("export PATH=");
    }
  });

  test("fish gets a conf.d snippet using fish_add_path", async () => {
    const fish = await runInstaller({ shell: "/opt/homebrew/bin/fish" });
    expect((await fish.run()).output).toContain(
      "Added ~/.local/bin to your PATH in ~/.config/fish/conf.d/openteam.fish."
    );
    expect(fish.read(".config/fish/conf.d/openteam.fish")).toBe(
      `# Added by the OpenTeam installer\nfish_add_path -g '${fish.binDirectory}'\n`
    );
  });

  test("the written line resolves openteam, even for a directory with spaces and quotes", async () => {
    const installer = await runInstaller({
      shell: "/bin/sh",
      binDirectory: (home) => join(home, "tools dir", "it's here"),
    });
    const { output, code } = await installer.run();
    expect(code).toBe(0);
    expect(output).toContain("~/tools dir/it's here to your PATH in ~/.profile.");
    const resolved = await resolvesOpenTeam(
      "/bin/sh",
      join(installer.home, ".profile"),
      installer.home
    );
    expect(realpathSync(resolved)).toBe(realpathSync(join(installer.binDirectory, "openteam")));
  });

  test("leaves profiles alone when opted out or already on PATH", async () => {
    const optedOut = await runInstaller({
      shell: "/bin/zsh",
      env: () => ({ OPENTEAM_NO_MODIFY_PATH: "1" }),
    });
    const skipped = await optedOut.run();
    expect(skipped.output).toContain(
      `Add ${optedOut.binDirectory} to PATH to run openteam from new terminals.`
    );
    expect(optedOut.read(".zshrc")).toBeNull();

    const onPath = await runInstaller({ shell: "/bin/zsh", onPath: true });
    const result = await onPath.run();
    expect(result.output).not.toContain("PATH");
    expect(onPath.read(".zshrc")).toBeNull();
  });
});
