import { chmod } from "node:fs/promises";
import { sign } from "sigstore";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Pass at least one release artifact to sign");

for (const file of files) {
  const payload = Buffer.from(await Bun.file(file).arrayBuffer());
  const bundle = await sign(payload, { tlogUpload: true });
  const destination = `${file}.sigstore.json`;
  await Bun.write(destination, `${JSON.stringify(bundle)}\n`);
  await chmod(destination, 0o600);
  console.log(`Signed ${file} → ${destination}`);
}
