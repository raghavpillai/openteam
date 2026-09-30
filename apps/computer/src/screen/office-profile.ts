import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assignAgentOwnership } from "../agent-process";

/** Preserve existing office settings while migrating legacy desktop ownership. */
export async function prepareOfficeProfile(browserProfileDirectory: string): Promise<void> {
  const directory = `${browserProfileDirectory}-office`;
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Refusing redirected office profile directory");
  }
  if (created) {
    // Each bot has an isolated profile. Do not repeat the informational upgrade
    // banner on every new desktop, or overwrite preferences in existing ones.
    const user = join(directory, "user");
    await mkdir(user, { mode: 0o700 });
    await writeFile(join(user, "registrymodifications.xcu"),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
      '<item oor:path="/org.openoffice.Office.UI.Infobar/Enabled">' +
      '<prop oor:name="WhatsNew" oor:op="fuse"><value>false</value></prop>' +
      '</item></oor:items>\n', { flag: "wx", mode: 0o600 });
  }
  // Unlike chown(), this does not follow profile symlinks into private storage.
  await assignAgentOwnership([directory], true);
}
