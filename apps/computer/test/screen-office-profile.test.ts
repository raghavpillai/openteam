import { expect, test } from "bun:test";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test.skipIf(process.getuid?.() !== 0 || process.platform !== "linux")("legacy office ownership migrates to runner without following nested symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-ownership-"));
  try {
    const browser = join(root, "browser");
    const office = `${browser}-office`;
    await mkdir(join(office, "user"), {recursive: true});
    await chmod(office, 0o700);
    await writeFile(join(office, "user", "settings"), "preserved");
    for (const path of [office, join(office, "user"), join(office, "user", "settings")]) await chown(path, 1000, 1000);
    const privateFile = join(root, "private");
    await writeFile(privateFile, "private fixture", {mode: 0o600});
    await symlink(privateFile, join(office, "redirected"));
    await prepareOfficeProfile(browser);
    for (const path of [office, join(office, "user"), join(office, "user", "settings")]) expect((await lstat(path)).uid).toBe(1001);
    expect((await lstat(privateFile)).uid).toBe(0);
    expect((await lstat(privateFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(office, "user", "settings"), "utf8")).toBe("preserved");
  } finally { await rm(root, {recursive: true, force: true}); }
});
