import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { typeText } from "../src/screen/typing";
import { run } from "../src/screen/processes";
import { performComputerUseAction } from "../src/screen/actions";

if (process.platform !== "linux") throw new Error("Run in the disposable computer image");
const root = await mkdtemp(join(tmpdir(), "writer-typing-"));
const file = join(root, "typing.odt");
const fixture = `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('mimetype','application/vnd.oasis.opendocument.text')
 z.writestr('content.xml','''<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p/></office:text></office:body></office:document-content>''')
 z.writestr('META-INF/manifest.xml','''<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>''')
`;
await run("python3", ["-c", fixture, file]);
const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "inherit"] });
let writer: ReturnType<typeof spawn> | undefined;
try {
  const display = await new Promise<string>((resolve, reject) => {
    xvfb.once("error", reject);
    xvfb.stdout!.once("data", data => resolve(String(data).trim()));
  });
  const env = { ...process.env, DISPLAY: `:${display}`, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache") };
  writer = spawn("libreoffice", [`-env:UserInstallation=file://${root}/office`, "--norestore", "--nofirststartwizard", "--writer", file], { env, stdio: "ignore" });
  await run("xdotool", ["search", "--sync", "--onlyvisible", "--name", "typing.odt", "windowfocus"], { env, signal: AbortSignal.timeout(30_000) });
  await Bun.sleep(750);
  const clipboard = spawn("xclip", ["-selection", "clipboard", "-in", "-target", "UTF8_STRING", "-quiet"], { env, stdio: ["pipe", "ignore", "ignore"] });
  clipboard.stdin.end("previous synthetic clipboard");
  await Bun.sleep(100);
  await typeText("Native typing\nCafé 日本語 🙂\nFinal line", env);
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+s"], { env });
  await Bun.sleep(1500);
  const actual = (await run("python3", ["-c", "import sys,zipfile,xml.etree.ElementTree as E;r=E.fromstring(zipfile.ZipFile(sys.argv[1]).read('content.xml'));print('\\n'.join(''.join(p.itertext()) for p in r.iter('{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p')))", file], { env, captureStdout: true })).toString().trimEnd();
  console.log(JSON.stringify({ expected: "Native typing\nCafé 日本語 🙂\nFinal line", actual }));
  assert.equal(actual, "Native typing\nCafé 日本語 🙂\nFinal line");
  assert.equal((await run("xclip", ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"], { env, captureStdout: true })).toString(), "previous synthetic clipboard");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(typeText("Should not type 🙂", env, cancelled.signal));
  assert.equal((await run("xclip", ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"], { env, captureStdout: true })).toString(), "previous synthetic clipboard");
  await performComputerUseAction({ action: "key", key: "shift+f12" }, env);
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+s"], { env });
  await Bun.sleep(700);
  const lists = (await run("python3", ["-c", "import sys,zipfile,xml.etree.ElementTree as E;r=E.fromstring(zipfile.ZipFile(sys.argv[1]).read('content.xml'));print(len(list(r.iter('{urn:oasis:names:tc:opendocument:xmlns:text:1.0}list'))))", file], { env, captureStdout: true })).toString().trim();
  assert.equal(lists, "1");
  console.log("PASS native Writer persists supplementary Unicode and line breaks; restores text clipboard; canceled input does not type; lowercase shift+f12 creates a real bullet list");
} finally {
  writer?.kill(); xvfb.kill();
  await Bun.sleep(200);
  await rm(root, { recursive: true, force: true });
}
