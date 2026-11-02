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
const html = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ws: wss:; base-uri 'none'">
<style>
html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#screen{display:flex;align-items:center;justify-content:center;touch-action:none}
canvas{outline:none;max-width:100%;max-height:100%}
</style>
</head>
<body>
<div id="screen" aria-label="OpenTeam computer screen"></div>
<script type="module">${source}</script>
</body>
</html>`;

const output = resolve(root, "mobile/androidApp/app/src/main/assets/openteam-vnc/index.html");
await Bun.write(output, html);
console.log(`Generated ${output} (${Buffer.byteLength(html)} bytes).`);
