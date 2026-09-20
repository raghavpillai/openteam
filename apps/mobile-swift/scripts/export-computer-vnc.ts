import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';

// Share the desktop's exact pinned noVNC release and its license notices.
const root = resolve(import.meta.dir, '../../..');
const require = createRequire(resolve(root, 'apps/desktop/package.json'));
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'computer-vnc.js')],
  target: 'browser', format: 'esm', minify: true,
  plugins: [{name: 'shared-novnc', setup(build) {
    build.onResolve({filter: /^@novnc\//}, ({path}) => ({path: resolve(dirname(require.resolve('@novnc/novnc')), '..', path.replace('@novnc/novnc/', ''))}));
  }}] });
if (!result.success) throw new Error(String(result.logs));
const source = (await result.outputs[0]!.text()).replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ws: wss:; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:black}#screen,#still{position:absolute;inset:0;width:100%;height:100%}#still{object-fit:contain;pointer-events:none}canvas{outline:none}</style></head><body><div id="screen"></div><img id="still" hidden alt=""><script type="module">${source}</script></body></html>`;
const output = resolve(root, 'apps/mobile-swift/Sources/App/Resources');
await writeFile(resolve(output, 'ComputerVNC.html'), html);
const notices = resolve(root, 'apps/desktop/public/third-party/novnc');
await writeFile(resolve(output, 'ComputerVNC-LICENSES.txt'), (await Promise.all((await readdir(notices)).sort().map(async name => `${name}\n${await readFile(resolve(notices,name),'utf8')}`))).join('\n\n'));
console.log(`Generated bundled VNC viewer (${Buffer.byteLength(html)} bytes).`);
