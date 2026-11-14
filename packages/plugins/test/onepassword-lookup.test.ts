import { expect, test } from "bun:test";

test("the documented 1Password lookup propagates CLI errors through a successful filter", async () => {
  const skill = await Bun.file(
    new URL("../1password/skills/1password/SKILL.md", import.meta.url)
  ).text();
  const command = skill.match(/Logins for a site: `([^`]+)`/)![1]!.replace("<op>", "op");
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      `
    op() { echo 'connection reset by peer' >&2; return 17; }
    jq() { cat >/dev/null; }
    ${command}
  `,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(17);
  expect(stdout).toBe("");
  expect(stderr).toContain("connection reset by peer");
});
