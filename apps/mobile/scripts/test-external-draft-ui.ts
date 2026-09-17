/** Real React Native Web component; only the app context and provider are synthetic. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";

const output = resolve("findings/connection-parity-2026-09-16");
await mkdir(output, { recursive: true });
const buildDir = await mkdtemp(join(tmpdir(), "openteam-mobile-draft-ui-"));
const mobileRoot = resolve(import.meta.dir, "..");
const { build } = await import("../../desktop/node_modules/vite/dist/node/index.js");
await build({
  configFile: false,
  root: mobileRoot,
  logLevel: "warn",
  resolve: {
    alias: { "react-native": join(mobileRoot, "node_modules/react-native-web/dist/index.js") },
    dedupe: ["react", "react-dom"],
  },
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
  plugins: [
    {
      name: "isolated-mobile-ui",
      enforce: "pre",
      load(id) {
        if (/\/state\/openteam-context\.tsx$/.test(id))
          return "export const useOpenTeam = () => window.mobileFixtureApi;";
        if (/\/src\/theme\.ts$/.test(id))
          return 'import {mobileLightTheme} from "@openteam/design-tokens/mobile-theme"; export const useTheme = () => mobileLightTheme;';
      },
    },
  ],
  build: {
    outDir: buildDir,
    emptyOutDir: true,
    lib: {
      entry: join(mobileRoot, "test/browser/external-draft.tsx"),
      formats: ["es"],
      fileName: () => "external-draft.js",
    },
    minify: false,
  },
});
let mode = "ok",
  state = "pending",
  sends = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/")
      return new Response(
        '<html><div id="root"></div><script type="module" src="/external-draft.js"></script></html>',
        { headers: { "content-type": "text/html" } }
      );
    if (url.pathname === "/external-draft.js")
      return new Response(Bun.file(join(buildDir, "external-draft.js")));
    const { action } = (await request.json()) as { action: string };
    if (action === "send") {
      sends++;
      if (mode !== "reject") state = "sent";
    }
    if (mode === "disconnected" || (mode === "reject" && action === "send"))
      return Response.json(
        { error: { message: "Provider unreachable; draft retained" } },
        { status: 503 }
      );
    return Response.json({
      message: {
        id: "draft",
        metadata: { cardState: state, draft: { verification: { identity: "a@example.test" } } },
      },
    });
  },
});
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(7000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) =>
  new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
);
const reset = async (next: string) => {
  mode = next;
  state = "pending";
  sends = 0;
  await page.goto(`${server.url.origin}/?server=${encodeURIComponent(server.url.origin)}`);
  await page.getByLabel("Message body").waitFor();
};
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
try {
  await reset("reject");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Provider unreachable" }).waitFor();
  assert(
    (await page.getByLabel("Message body").inputValue()) === "Keep my mobile draft",
    "Rejected send erased the mobile draft"
  );
  mode = "ok";
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Message sent", { exact: true }).waitFor();
  assert(sends === 2, "Mobile retried the external send automatically");
  await reset("disconnected");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  assert(
    (await page.getByRole("button", { name: "Send", exact: true }).count()) === 0,
    "Unconfirmed mobile send could be sent again"
  );
  mode = "ok";
  await page.getByRole("button", { name: "Check delivery", exact: true }).click();
  await page.getByText("Message sent", { exact: true }).waitFor();
  assert(
    (await page.getByRole("alert").count()) === 0,
    "Confirmed mobile delivery still showed an error"
  );
  assert(sends === 1, "Checking delivery resent the mobile message");
  await reset("disconnected");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  await page.evaluate(() => (window as any).mobileFixtureUpdate("sent"));
  await page.getByText("Message sent", { exact: true }).waitFor();
  await reset("ok");
  await page.evaluate(() => {
    (window as any).mobileDisconnected = true;
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  assert(sends === 0, "Disconnected context reached the provider");
  assert(errors.length === 0, errors.join("\n"));
  await page.screenshot({ path: join(output, "mobile-disconnected.png") });
  console.log(
    "PASS: mobile draft failure/retry, uncertain send, recovery, authoritative push, disconnected app context, no duplicate send."
  );
} catch (error) {
  console.error(errors.join("\n"));
  await page.screenshot({ path: join(output, "mobile-failure.png") });
  throw error;
} finally {
  await browser.close();
  server.stop(true);
  await rm(buildDir, { recursive: true, force: true });
}
