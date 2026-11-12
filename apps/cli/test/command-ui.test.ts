import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
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
