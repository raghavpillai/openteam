import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../src/errors";
import { cliProgram, renderCommandError } from "../src/command-ui";

describe("CLI presentation", () => {
  test("redacts secrets and strips terminal escapes before styling dynamic data", () => {
    const secret = "sk-proj-renderInvalid0123456789012345";
    const text = renderCommandError(
      `Invalid API key ${secret}\x1b]8;;https://bad.test\x07spoof\x1b]8;;\x07\r`,
      { color: false }
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("bad.test");
    expect(
      errorMessage(new Error("compose failed with OPENTEAM_POSTGRES_PASSWORD=database-secret"))
    ).toBe("compose failed with OPENTEAM_POSTGRES_PASSWORD=[REDACTED]");
  });
});

describe("CLI name in hints", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test("uses the absolute path until the installed directory is on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "openteam-cli-name-"));
    directories.push(root);
    const bin = join(root, "bin");
    const linked = join(root, "linked");
    mkdirSync(bin);
    mkdirSync(linked);
    const executable = join(bin, "openteam");
    writeFileSync(executable, "", { mode: 0o755 });
    symlinkSync(executable, join(linked, "openteam"));
    const program = (path: string) =>
      cliProgram({ executable, standalone: true, path, platform: "linux" });

    expect(program("/usr/bin:/bin")).toBe(executable);
    expect(program(`/usr/bin:${bin}`)).toBe("openteam");
    expect(program(`${linked}:/usr/bin`)).toBe("openteam");
    // Another name for the same file, like a Windows short name (RUNNER~1), still counts.
    const aliased = join(root, "aliased");
    mkdirSync(aliased);
    linkSync(executable, join(aliased, "openteam"));
    expect(program(`/usr/bin:${aliased}`)).toBe("openteam");
    // Running from source, or bundled in the desktop app, keeps the short name.
    expect(cliProgram({ executable, standalone: false, path: "" })).toBe("openteam");
  });

  test("quotes paths the shell would split", () => {
    expect(
      cliProgram({
        executable: "/home/Jane Doe/.local/bin/openteam",
        standalone: true,
        path: "",
        platform: "linux",
      })
    ).toBe("'/home/Jane Doe/.local/bin/openteam'");
    expect(
      cliProgram({
        executable: "C:\\Users\\Jane Doe\\AppData\\Local\\OpenTeam\\bin\\openteam.exe",
        standalone: true,
        path: "",
        platform: "win32",
      })
    ).toBe("& 'C:\\Users\\Jane Doe\\AppData\\Local\\OpenTeam\\bin\\openteam.exe'");
  });
});
