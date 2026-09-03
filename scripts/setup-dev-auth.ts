import { spawnSync } from "node:child_process";
import {
  collectConfirmedPassword,
  createTerminalPrompter,
  validateOwnerUsername,
} from "../apps/cli/src/setup";

const prompter = createTerminalPrompter();
try {
  const answer = (await prompter.question("OpenTeam username [openteam]: ")).trim() || "openteam";
  const username = validateOwnerUsername(answer);
  const password = await collectConfirmedPassword(prompter);
  const result = spawnSync(
    "docker",
    ["compose", "exec", "--no-TTY", "server", "bun", "main.js", "owner-credentials"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ operation: "setup", username, password }),
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (result.status !== 0) throw new Error("Could not configure the development owner account");
  console.log(`Development sign-in is ready for ${username}.`);
} finally {
  prompter.close();
}
