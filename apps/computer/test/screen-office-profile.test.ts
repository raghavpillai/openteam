import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOfficeProfile } from "../src/screen/office-profile";

test("office preparation preserves settings and rejects redirected profile roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-profile-"));
  try {
    const browser = join(root, "browser");
    await prepareOfficeProfile(browser);
    const preferences = `${browser}-office/user/registrymodifications.xcu`;
    expect(await readFile(preferences, "utf8")).toContain('/org.openoffice.Office.UI.Infobar/Enabled');
    expect(await readFile(preferences, "utf8")).toContain('<value>false</value>');
    await writeFile(preferences, "existing user preferences");
    await writeFile(`${browser}-office/settings`, "preserved");
    await prepareOfficeProfile(browser);
    expect(await readFile(preferences, "utf8")).toBe("existing user preferences");
    expect(await readFile(`${browser}-office/settings`, "utf8")).toBe("preserved");
    const privateDirectory = join(root, "private");
    await mkdir(privateDirectory, {mode: 0o700});
    await writeFile(join(privateDirectory, "secret"), "private fixture");
    await symlink(privateDirectory, join(root, "redirected-office"));
    await expect(prepareOfficeProfile(join(root, "redirected"))).rejects.toThrow("Refusing redirected");
    expect((await lstat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(privateDirectory, "secret"), "utf8")).toBe("private fixture");
  } finally { await rm(root, {recursive: true, force: true}); }
});
