/** Render real desktop/RN components against controlled promise outcomes. No real permissions. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "../../computer/node_modules/playwright-core";
import { createServer, build } from "vite";
const repo = resolve(import.meta.dir, "../../..");
const output = resolve(
  repo,
  process.env.PERMISSION_QA_OUTPUT ?? "findings/permission-ui-parity-2026-09-16"
);
await mkdir(output, { recursive: true });
const buildDir = await mkdtemp(join(tmpdir(), "openteam-permission-ui-"));
const mobileRoot = join(repo, "apps/mobile");
const results: string[] = [];
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  await build({
    configFile: false,
    root: mobileRoot,
    logLevel: "warn",
    resolve: {
      extensions: [".web.tsx", ".web.ts", ".web.js", ".mjs", ".js", ".ts", ".tsx", ".jsx", ".json"],
      alias: { "react-native": join(mobileRoot, "node_modules/react-native-web/dist/index.js"), "react-native-svg": join(mobileRoot, "node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js") },
      dedupe: ["react", "react-dom"],
    },
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
    plugins: [
      {
        name: "isolated-native-services",
        enforce: "pre",
        resolveId(id) {
          if (["expo-symbols", "expo-router"].includes(id)) return `\0fixture:${id}`;
        },
        load(id) {
          if (id === "\0fixture:expo-symbols") return "export const SymbolView = () => null;";
          if (id === "\0fixture:expo-router")
            return "export const router = {push: (value) => {window.fixtureNavigation = value;}};";
          if (/\/state\/openteam-context\.tsx$/.test(id))
            return "export const useOpenTeam = () => window.mobileFixtureApi;";
          if (/\/src\/theme\.ts$/.test(id))
            return 'import {mobileLightTheme} from "@openteam/design-tokens/mobile-theme"; export const useTheme = () => mobileLightTheme;';
          if (/\/src\/haptics\.ts$/.test(id))
            return "export const notificationAsync = async()=>{}, impactAsync=async()=>{}, selectionAsync=async()=>{}, NotificationFeedbackType={}, ImpactFeedbackStyle={};";
          if (/\/components\/bot-mark\.tsx$/.test(id)) return "export const BotMark = () => null;";
        },
      },
    ],
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      lib: {
        entry: join(mobileRoot, "test/browser/permission-cards.tsx"),
        formats: ["es"],
        fileName: () => "fixture.js",
      },
      minify: false,
    },
  });
  vite = await createServer({
    root: join(repo, "apps/desktop"),
    cacheDir: join(buildDir, "desktop-cache"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/fixture.js"
        ? new Response(Bun.file(join(buildDir, "fixture.js")))
        : new Response(
            '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
            { headers: { "content-type": "text/html" } }
          );
    },
  });
  for (const mobile of [false, true]) {
    const label = mobile ? "mobile" : "desktop";
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 980, height: 950 },
    });
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(label, error.message);
    });
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
    );
    await page.goto(
      mobile
        ? server.url.origin
        : `${vite.resolvedUrls!.local[0]}test/browser/permission-cards.html`
    );
    await page.waitForFunction(() => (window as any).permissionQA?.ready === true);
    const configure = (config: any) =>
      page.evaluate((value) => Object.assign((window as any).permissionQA, value), config);
    const render = (value: any) =>
      page.evaluate(async (value) => {
        (window as any).permissionQA.render(value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, value);
    const update = (value: any) =>
      page.evaluate(async (value) => {
        (window as any).permissionQA.update(value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, value);
    const calls = () => page.evaluate(() => (window as any).permissionQA.calls);
    const pass = (name: string) => {
      results.push(`${label}: ${name}`);
      console.log(`PASS ${label}: ${name}`);
    };
    const msg = (metadata: any) => ({
      message: {
        id: "message",
        content: "",
        sender: "agent",
        senderBotId: "fixture-bot",
        metadata,
      },
    });
    const widget = {
      type: "widget",
      widget: {
        prompt: "Choose a route",
        options: [
          { label: "Alpha", value: "alpha" },
          { label: "Beta", value: "beta" },
        ],
        allowCustom: true,
      },
    };
    const approval = {
      id: "approval",
      status: "pending",
      details: {
        type: "localTool",
        action: "runCommand",
        effect: "Run a command on this computer?",
        machineLabel: "Fixture Mac",
        arguments: { command: "echo permission-fixture" },
        supportsAlwaysAllow: true,
        supportsNever: true,
      },
    };
    await render({ approval });
    await page.getByRole("button", { name: "Always allow", exact: true }).waitFor();
    await page.screenshot({ path: join(output, `${label}-permission.png`) });
    await configure({ hold: true, fail: true });
    await page
      .getByRole("button", { name: mobile ? "Allow once" : "Allow once", exact: true })
      .evaluate((button: HTMLElement) => {
        button.click();
        button.click();
      });
    assert((await calls()).length === 1, "Duplicate approval request");
    assert(
      await page.getByRole("button", { name: "Always allow", exact: true }).isDisabled(),
      "Permission buttons enabled in flight"
    );
    await page.evaluate(() => (window as any).permissionQA.release());
    await page.getByRole("alert").waitFor();
    await configure({ hold: false, fail: false });
    await page.getByRole("button", { name: "Always allow", exact: true }).click();
    assert((await calls())[1][1] === "always_allow", "Always/once choices collapsed");
    pass("permission double-click, disabled choices, failure/retry and distinct standing grant");
    await render({
      approval: {
        ...approval,
        details: { ...approval.details, supportsAlwaysAllow: false, supportsNever: false },
      },
    });
    await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
    assert(
      (await page.getByRole("button", { name: "Always allow", exact: true }).count()) === 0,
      "Unsupported grant shown"
    );
    pass("unsupported persistent grants hidden");
    for (const status of ["accepted", "declined", "cancelled", "expired"]) {
      await render({
        approval: {
          ...approval,
          status,
          details: {
            ...approval.details,
            resolution:
              status === "accepted" ? "accept" : status === "declined" ? "never" : undefined,
          },
        },
      });
      await (mobile
        ? page.getByLabel("Permission result", { exact: true })
        : page.locator("[data-local-tool-permission-result]")
      ).waitFor();
      assert((await page.getByRole("button").count()) === 0, `Settled ${status} actionable`);
      pass(`permission ${status} receipt`);
    }
    {
      const native = {
        ...approval,
        details: {
          type: "nativeCapability",
          supportsAlwaysAllow: true,
          presentation: {
            kind: "cookie-import",
            items: [
              { origin: ".alpha.test", profileId: "Default", profileDisplayName: "Personal" },
              { origin: ".beta.test", profileId: "Default", profileDisplayName: "Personal" },
            ],
          },
        },
      };
      await render({ approval: native });
      await page.getByRole("button", { name: "Show the sites", exact: true }).click();
      assert(
        await page.getByRole("checkbox", { name: ".beta.test in Personal" }).isChecked(),
        "Site checkbox must initially announce its selected state"
      );
      await page.getByRole("checkbox", { name: ".beta.test in Personal" }).uncheck();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      assert(
        !(await page.getByRole("checkbox", { name: ".beta.test in Personal" }).isChecked()),
        "Deselection was not retained after render"
      );
      await configure({ hold: true, fail: true });
      await page.getByRole("button", { name: "Always allow", exact: true }).click();
      assert(
        JSON.stringify((await calls())[0][2]) ===
          JSON.stringify([JSON.stringify(["Default", ".alpha.test"])]),
        `Cookie approval widened the selected scope: ${JSON.stringify(await calls())}`
      );
      assert(
        await page.getByRole("checkbox", { name: ".alpha.test in Personal" }).isDisabled(),
        "Cookie scope editable during submission"
      );
      await page.evaluate(() => (window as any).permissionQA.release());
      await page.getByRole("alert").waitFor();
      assert(
        !(await page.getByRole("checkbox", { name: ".beta.test in Personal" }).isChecked()),
        "Failed request lost selection"
      );
      pass("Chrome approval forwards only selected sites and retains scope on failure");
      await page
        .getByRole("button", { name: "Deselect all in Personal" })
        .count()
        .then(async (count) => {
          if (!count) await page.getByRole("button", { name: "Select all in Personal" }).click();
        });
      await page.getByRole("button", { name: "Deselect all in Personal" }).click();
      assert(
        await page.getByRole("button", { name: "Allow once", exact: true }).isDisabled(),
        "Empty cookie selection may be approved"
      );
      pass("Chrome group selection and empty-scope guard");
      await render({
        approval: {
          ...approval,
          details: {
            type: "nativeCapability",
            presentation: {
              kind: "saved-login",
              title: "Example login",
              category: "LOGIN",
              site: "https://example.test",
              purpose: "Sign in to continue",
            },
          },
        },
      });
      await page.getByRole("button", { name: "Allow Once", exact: true }).waitFor();
      assert(
        (await page.locator("input").count()) === 0,
        "Saved login approval exposes private fields"
      );
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      assert((await calls())[0][1] === "decline", "Saved login denial changed");
      pass("saved-login metadata card and denial");
      const credential = {
        ...approval,
        details: {
          type: "nativeCapability",
          presentation: {
            kind: "saved-login",
            title: "Example login",
            category: "LOGIN",
            site: "https://example.test",
            purpose: "Sign in to continue",
          },
        },
      };
      await render({ approval: credential });
      await configure({ hold: true, fail: true });
      await page.getByRole("button", { name: "Allow Once", exact: true }).click();
      await update({
        ...credential,
        status: "accepted",
        details: { ...credential.details, actionState: "running" },
      });
      await page.getByText("Filling 1Password login for example.test", { exact: true }).waitFor();
      assert(
        (await page.getByRole("button").count()) === 0,
        "Running saved-login action still offers decisions"
      );
      await page.evaluate(() => (window as any).permissionQA.release());
      await update({
        ...credential,
        status: "accepted",
        details: { ...credential.details, actionState: "completed" },
      });
      await page.getByText("Allowed once", { exact: true }).waitFor();
      assert(
        (await page
          .getByText("Filling 1Password login for example.test", { exact: true })
          .count()) === 0,
        "Completed login still filling"
      );
      pass("durable saved-login progress and completion survive a delayed HTTP failure");
      for (const state of ["running", "failed"] as const) {
        await render({
          approval: {
            ...credential,
            status: "accepted",
            details: { ...credential.details, actionState: state },
          },
        });
        await page
          .getByText(state === "running" ? "Filling 1Password login for example.test" : "Failed", {
            exact: true,
          })
          .waitFor();
        assert(
          (await page.getByRole("button").count()) === 0,
          "Reloaded native action allows duplicate execution"
        );
        assert(
          (await page.locator("input").count()) === 0,
          "Native lifecycle exposed private input"
        );
      }
      pass("saved-login reload restores running and failed states without private values");
      await render({
        approval: {
          ...native,
          status: "accepted",
          details: { ...native.details, actionState: "running" },
        },
      });
      await page.getByText("Importing logins", { exact: true }).waitFor();
      assert(
        (await page.getByRole("button", { name: "Allow once", exact: true }).count()) === 0,
        "Running cookie import can be repeated"
      );
      await update({
        ...native,
        status: "accepted",
        details: { ...native.details, actionState: "failed" },
      });
      await page.getByText("Failed", { exact: true }).waitFor();
      assert(
        (await page.getByText("Allowed once", { exact: true }).count()) === 0,
        "Failed cookie import reports success"
      );
      pass("Chrome import distinguishes execution, success and failure");
    }
    await render(msg(widget));
    await page.getByLabel("Custom answer").fill("Keep this answer");
    await render(msg(widget));
    assert(
      (await page.getByLabel("Custom answer").inputValue()) === "Keep this answer",
      "Question draft lost on navigation/remount"
    );
    pass("question draft survives remount");
    await page.screenshot({ path: join(output, `${label}-widget.png`) });
    await configure({ fail: true, hold: true });
    await page
      .getByRole("button", { name: "Submit", exact: true })
      .evaluate((button: HTMLElement) => {
        button.click();
        button.click();
      });
    assert((await calls()).length === 1, "Duplicate widget submit");
    await page.evaluate(() => (window as any).permissionQA.release());
    await page.getByRole("alert").waitFor();
    assert(
      (await page.getByLabel("Custom answer").inputValue()) === "Keep this answer",
      "Widget failure lost draft"
    );
    await configure({ fail: false, hold: false });
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await page.getByLabel("Your answer", { exact: true }).waitFor();
    pass("widget failure keeps draft, retry succeeds, no duplicate submit");
    await render(msg(widget));
    await page.getByRole("button", { name: /Alpha/ }).waitFor();
    await configure({
      result: { accepted: false, message: { metadata: { ...widget, respondedValue: "beta" } } },
    });
    await page.getByRole("button", { name: /Alpha/ }).click();
    await page.getByLabel("Your answer", { exact: true }).filter({ hasText: "Beta" }).waitFor();
    assert(
      (await page.getByLabel("Your answer", { exact: true }).innerText()).includes("Beta"),
      "Ignored authoritative duplicate answer"
    );
    pass("duplicate answer uses server winner");
    await render(msg(widget));
    await page.getByRole("button", { name: /Alpha/ }).waitFor();
    await configure({ hold: true, fail: true });
    await page.getByRole("button", { name: /Alpha/ }).click();
    await update({ ...widget, respondedValue: "beta" });
    await page.getByLabel("Your answer", { exact: true }).waitFor();
    await page.evaluate(() => (window as any).permissionQA.release());
    assert(
      (await page.getByLabel("Your answer", { exact: true }).innerText()).includes("Beta"),
      "Delayed failure undid newer answer"
    );
    pass("authoritative update survives delayed failure");
    const multi = { ...widget, widget: { ...widget.widget, multiSelect: true } };
    await render(msg(multi));
    await page.getByRole("button", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: /Beta/ }).click();
    await page.getByLabel("Custom answer").fill("Gamma");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await page.getByLabel("Your answer", { exact: true }).waitFor();
    assert((await calls())[0][2] === "alpha\nbeta\nGamma", "Multi-select answer changed");
    pass("multi-select and custom answer encoding");
    await render(msg(widget));
    await page.getByRole("button", { name: "Dismiss question" }).waitFor();
    await configure({
      result: { accepted: true, message: { metadata: { ...widget, widgetDismissed: true } } },
    });
    await page.getByRole("button", { name: "Dismiss question" }).click();
    await page.getByText("Dismissed", { exact: true }).waitFor();
    pass("dismissed widget cannot be answered");
    const secret = {
      type: "secret-request",
      secretRequest: {
        name: "FIXTURE_API_KEY",
        label: "Fixture API key",
        description: "Synthetic value only",
      },
    };
    await render(msg(secret));
    await page
      .getByLabel("Fixture API key", { exact: true })
      .filter({ visible: true })
      .last()
      .waitFor();
    const secretInput = page.locator('input[type="password"]');
    await secretInput.fill("fixture-secret-value");
    await configure({ fail: true });
    await page.getByRole("button", { name: "Save securely", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert((await secretInput.inputValue()) === "", "Secret retained after submission");
    assert(
      !(await page.locator("body").innerText()).includes("fixture-secret"),
      "Error echoed secret"
    );
    pass("private value cleared and errors cannot echo it");
    const optionsForm = {type:"user-form",cardState:"pending",form:{title:"Choose settings",domain:"example.test",instruction:"Complete the options below.",fields:[{id:"notes",label:"Notes",type:"textarea"},{id:"region",label:"Region",type:"select",required:true,options:[{label:"North",value:"north"},{label:"South",value:"south"}]},{id:"remember",label:"Remember this choice",type:"checkbox"},{id:"code",label:"Verification code",type:"otp",required:true,target:{kind:"selector",value:"#code"}}]}};
    await render(msg(optionsForm));
    await page.getByLabel("Notes",{exact:true}).fill("Synthetic note");
    if(mobile) {
      await page.getByRole("combobox",{name:"Region"}).click();
      await page.getByRole("radio",{name:"South",exact:true}).click();
      await page.getByRole("combobox",{name:"Region"}).filter({hasText:"South"}).waitFor();
      assert(await page.getByRole("radio").count() === 0,"Selected menu stayed open");
    } else await page.getByRole("combobox",{name:"Region"}).selectOption("south");
    await page.getByRole("checkbox",{name:"Remember this choice"}).check();
    assert(await page.getByRole("button",{name:"Continue",exact:true}).isDisabled(),"Empty verification code accepted");
    await page.getByLabel("Verification code",{exact:true}).fill("123456");
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    assert(JSON.stringify((await calls())[0][2]) === JSON.stringify({notes:"Synthetic note",region:"south",remember:true,code:"123456"}),"Form controls lost their selected values");
    pass("select menu, checkbox, multiline text and required OTP submit their values");
    const form = {
      type: "user-form",
      cardState: "pending",
      form: {
        title: "Fixture private form",
        instruction: "Use synthetic details",
        domain: "example.test",
        fields: [
          {
            id: "password",
            label: "Password",
            type: "password",
            required: true,
            target: { kind: "selector", value: "#password" },
          },
        ],
      },
    };
    if (mobile) {
      await render(msg(form));
      await page.locator('input[type="password"]').fill("fixture-secret-value");
      await configure({ result: { accepted: false } });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("alert").waitFor();
      assert(
        (await page.locator('input[type="password"]').inputValue()) === "fixture-secret-value",
        "Disconnected form lost retry input"
      );
      pass("disconnected form context reports failure");
    }
    await render(msg(form));
    await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
    assert(
      await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(),
      "Required field not enforced"
    );
    await page.locator('input[type="password"]').fill("fixture-secret-value");
    await configure({
      result: {
        accepted: true,
        message: {
          metadata: {
            ...form,
            cardState: "submitted",
            formReceipt: {
              fields: [{ id: "password", status: "held" }],
              submitAttempted: false,
              submitSucceeded: false,
            },
          },
        },
      },
    });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText("Not filled", { exact: true }).waitFor();
    assert((await page.locator("input").count()) === 0, "Settled form retains fields");
    pass("required private form, partial fill receipt and removal of input");
    await page.screenshot({ path: join(output, `${label}-form-recovery.png`) });
    {
      await render(msg(form));
      await configure({
        result: { accepted: true, message: { metadata: { ...form, cardState: "escalated" } } },
      });
      await page.getByRole("button", { name: "Open the screen", exact: true }).click();
      await page.getByText("On screen", { exact: true }).waitFor();
      assert(
        (await calls())[0][0] === "form-dismiss" && (await calls())[0][2] === "escalated",
        "Screen handoff submitted form values"
      );
      assert((await page.locator("input").count()) === 0, "Screen handoff kept private fields");
      if (mobile)
        assert(
          await page.evaluate(
            () => (window as any).fixtureNavigation?.params?.botId === "fixture-bot"
          ),
          "Mobile form did not open the bot screen"
        );
      pass("private form opens the screen with a value-free escalation");
    }
    if (!mobile) {
      await render(msg(widget));
      await page.getByRole("button", { name: /Alpha/ }).waitFor();
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("b");
      await page.getByLabel("Your answer", { exact: true }).waitFor();
      assert((await calls())[0][2] === "beta", "Keyboard selection mismatch");
      pass("widget letter shortcut");
      await render(
        msg({ type: "computer-handoff", computerHandoff: { reason: "Inspect a synthetic page" } })
      );
      await page.getByRole("button", { name: "Take over", exact: true }).waitFor();
      await configure({
        result: { accepted: false, message: { metadata: { computerHandoffState: "completed" } } },
      });
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await page.getByText("completed", { exact: true }).waitFor();
      assert(
        (await page.getByRole("button", { name: "Return to computer" }).count()) === 0,
        "Terminal handoff reopened"
      );
      pass("terminal handoff cannot reopen computer");
    } else {
      await render({ ...msg(widget), readOnly: true });
      await page.getByRole("button", { name: /Alpha/ }).waitFor();
      assert(
        await page.getByRole("button", { name: /Alpha/ }).isDisabled(),
        "Read-only widget actionable"
      );
      pass("read-only widget disabled");
    }
    assert(errors.length === 0, errors.join("\n"));
    pass("no uncaught renderer errors");
    await page.close();
  }
  await writeFile(
    join(output, "rendered-results.json"),
    JSON.stringify({ passed: results.length, scenarios: results }, null, 2)
  );
  console.log(JSON.stringify({ passed: results.length, scenarios: results }, null, 2));
} catch (error) {
  for (const [index, page] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`) });
    await writeFile(join(output, `failure-${index}.txt`), await page.locator("body").innerText());
  }
  throw error;
} finally {
  await browser.close();
  await vite?.close();
  server?.stop(true);
  await rm(buildDir, { recursive: true, force: true });
}
