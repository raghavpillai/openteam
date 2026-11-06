import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const require = createRequire(resolve(root, "apps/ios/package.json"));
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "computer-vnc.js")],
  target: "browser",
  format: "esm",
  minify: true,
  plugins: [{
    name: "shared-novnc",
    setup(build) {
      build.onResolve({ filter: /^@novnc\// }, ({ path }) => ({
        path: resolve(
          dirname(require.resolve("@novnc/novnc")),
          "..",
          path.replace("@novnc/novnc/", ""),
        ),
      }));
    },
  }],
});
if (!result.success) throw new Error(String(result.logs));

const source = (await result.outputs[0].text()).replace(/<\/script/gi, "<\\/script");
// #screen is position:fixed because Android WebView can resolve html/body
// height:100% to 0px inside a Compose AndroidView, which collapses the noVNC
// canvas to 0x0 (a black screen). A fixed box always spans the visible viewport.
const html = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ws: wss:; base-uri 'none'">
<style>
html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#screen{position:fixed;inset:0;touch-action:none}
canvas{outline:none}
</style>
</head>
<body>
<div id="screen" aria-label="OpenTeam computer screen"></div>
<script type="module">${source}</script>
</body>
</html>`;

const output = resolve(root, "apps/android/app/src/main/assets/openteam-vnc/index.html");
await Bun.write(output, html);
console.log(`Generated ${output} (${Buffer.byteLength(html)} bytes).`);
