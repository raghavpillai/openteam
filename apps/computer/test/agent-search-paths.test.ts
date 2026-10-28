import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SEARCH_PATHS, withAgentSearchPaths } from "../src/agent-process";

test("bots search the system folders before their home folder's, and the image's Node libraries first", () => {
  const path = AGENT_SEARCH_PATHS.PATH.split(":");
  expect(path.indexOf("/usr/local/bin")).toBeLessThan(path.indexOf("/usr/bin"));
  expect(path.indexOf("/usr/bin")).toBeLessThan(path.indexOf("/home/box/.local/bin"));
  expect(AGENT_SEARCH_PATHS.NODE_PATH.split(":")[0]).toBe("/usr/lib/openteam/node/lib/node_modules");
});

test("a saved Shell keeps its PATH, gains the bot entries it lacks, and always gets the image's libraries", () => {
  // Saved on an older image: no home folders on PATH, and NODE_PATH without the image's own folder.
  const saved = { PATH: "/workspace/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", NODE_PATH: "/usr/local/lib/node_modules", BUN_INSTALL_BIN: "/usr/local/bin", FOO: "1" };
  expect(withAgentSearchPaths(saved)).toEqual({
    PATH: "/workspace/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/home/box/.local/bin:/home/box/.bun/bin:/home/box/.cargo/bin:/home/box/go/bin",
    NODE_PATH: "/usr/lib/openteam/node/lib/node_modules:/usr/local/lib/node_modules",
    BUN_INSTALL_BIN: "/home/box/.bun/bin",
    FOO: "1",
  });
  const current = withAgentSearchPaths({ ...AGENT_SEARCH_PATHS, NODE_PATH: "/opt/mine:/usr/lib/openteam/node/lib/node_modules:/usr/local/lib/node_modules" });
  expect(current.PATH).toBe(AGENT_SEARCH_PATHS.PATH);
  expect(current.NODE_PATH).toBe("/usr/lib/openteam/node/lib/node_modules:/opt/mine:/usr/local/lib/node_modules");
});

const repo = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

test("OpenTeam's own processes start with absolute paths and a PATH without bot folders", () => {
  const dockerfile = read("docker/computer.Dockerfile");
  expect(dockerfile).toContain('CMD ["/usr/lib/openteam/bin/bun", "/app/apps/computer/dist/main.js"]');
  expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "/usr/lib/openteam/bin/openteam-computer-entrypoint"]');
  expect(dockerfile).toContain("ENV PATH=/usr/lib/openteam/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  // An empty /usr/local volume must not hide anything the image needs.
  expect(dockerfile).toContain("the image must ship no files in /usr/local");
  const entrypoint = read("docker/computer-entrypoint.sh");
  expect(entrypoint).toContain("PATH=/usr/lib/openteam/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  for (const hook of [read("docker/apt-keep-installs.conf"), read("docker/dpkg-keep-installs.cfg")])
    expect(hook.match(/\/\S*bun /g)?.every((bun) => bun === "/usr/lib/openteam/bin/bun ")).toBe(true);
  for (const compose of [read("deploy/compose.yaml"), read("docker-compose.yml")]) {
    expect(compose).toContain('test: ["CMD", "/usr/lib/openteam/bin/bun", "-e", "const r=await fetch(\'http://127.0.0.1:8790/health\')');
    expect(compose).toContain("- openteam_computer_local:/usr/local");
    expect(compose).toMatch(/^volumes:\n(?: {2}\S+:\n)*? {2}openteam_computer_local:$/m);
    expect(compose).toContain('entrypoint: ["/usr/lib/openteam/bin/openteam-memory-init"]');
  }
});
