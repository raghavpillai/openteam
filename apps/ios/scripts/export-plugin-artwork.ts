import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Use the package-owned provider artwork in native catalog rows and shortcut tiles.
// Provenance lives beside each packages/plugins/<key>/assets/icon.png source.
const root = resolve(import.meta.dir, '../../..');
const check = process.argv.includes('--check');
let count = 0;
for (const key of readdirSync(resolve(root, 'packages/plugins')).sort()) {
  let bytes: Buffer;
  try { bytes = readFileSync(resolve(root, `packages/plugins/${key}/assets/icon.png`)); }
  catch { continue; }
  const target = resolve(root, `apps/ios/Resources/Assets.xcassets/Plugin-${key}.imageset`);
  const contents = Buffer.from(JSON.stringify({
    images: [{ filename: 'icon.png', idiom: 'universal' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n');
  if (check) {
    for (const [name, expected] of [['icon.png', bytes], ['Contents.json', contents]] as const) {
      if (!readFileSync(resolve(target, name)).equals(expected)) {
        throw new Error(`Stale native plugin artwork: ${key}/${name}`);
      }
    }
  } else {
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, 'icon.png'), bytes);
    writeFileSync(resolve(target, 'Contents.json'), contents);
  }
  count++;
}
console.log(`Verified ${count} package-owned native plugin icons.`);
