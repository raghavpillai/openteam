import type { ComposeProject } from "./docker";

/** Older images print usage and exit 2 when called without arguments. Probe without
 * credentials before offering features added after those images were released.
 */
export const supportsCredentialImport = (
  project: ComposeProject,
  computerRunning: boolean
): boolean => {
  const command = computerRunning ? ["exec", "--no-TTY"] : ["run", "--rm", "--no-deps", "--no-TTY"];
  const result = project.run([...command, "computer", "openteam-pi-auth"], { timeoutMs: 10_000 });
  return /(?:^|\n)\s*openteam-pi-auth\s+import(?:\s|$)/.test(`${result.stdout}\n${result.stderr}`);
};
