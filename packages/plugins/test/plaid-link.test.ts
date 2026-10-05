import { expect, test } from "bun:test";

test("Hosted Link preserves existing Items, resumes completion and avoids duplicate exchanges", async () => {
  const child = Bun.spawn(["python3", new URL("./plaid-link.test.py", import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: "" });
  expect(stderr).toContain("OK");
});
