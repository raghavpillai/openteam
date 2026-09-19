import { mkdir } from "node:fs/promises";
import { join } from "node:path";

if (process.platform === "darwin") {
  const root = join(import.meta.dirname, "..");
  const output = join(root, "dist-electron", "openteam-op-launcher");
  await mkdir(join(root, "dist-electron"), { recursive: true });
  for (const args of [
    ["/usr/bin/clang", "-Os", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-arch", "arm64", "-arch", "x86_64", join(root, "native", "openteam-op-launcher.c"), "-framework", "Security", "-framework", "CoreFoundation", "-o", output],
    ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "dev.openteam.op-launcher", output],
  ]) {
    const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("Could not build the private 1Password launcher");
  }
}
