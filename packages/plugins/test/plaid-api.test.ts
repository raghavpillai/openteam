import { expect, test } from "bun:test";

test("Plaid read-only helper preserves selection, errors, config and credential boundaries", async () => {
  const child = Bun.spawn(["python3", new URL("./plaid-api.test.py", import.meta.url).pathname], {
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
