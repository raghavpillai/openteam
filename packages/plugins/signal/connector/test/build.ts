import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { discoverPackages } from "../../../scripts/generate";
import { exportPackage } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";

const source = new URL("../../", import.meta.url).pathname;
const temporary = mkdtempSync(join(source, "../.signal-build-"));
try {
  cpSync(source, join(temporary, "signal"), {
    recursive: true,
    filter: (path) => !path.includes("/connector/test") && !path.endsWith("tsconfig.json"),
  });
  const definition = (await discoverPackages(temporary))[0]!;
  const files = exportPackage(definition);
  const bytes = exportPackageArchive(definition);
  const roundtrip = importPackageArchive(bytes);
  if (
    roundtrip.definition.key !== "signal" ||
    !roundtrip.definition.files?.["connector/server.mjs"] ||
    roundtrip.definition.binaryFiles?.["assets/icon.png"] !== definition.binaryFiles?.["assets/icon.png"]
  )
    throw new Error("Exported package failed verification");
  const output = resolve(process.argv[2] ?? "output/signal-validation/signal.zip");
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, bytes);
  console.log(
    JSON.stringify({
      output,
      bytes: bytes.length,
      files: Object.keys(files).length + Object.keys(definition.binaryFiles ?? {}).length,
      validated: true,
    })
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
