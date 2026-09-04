import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const readDesktopFile = (path: string) => Bun.file(resolve(desktopRoot, path)).text();
const readWorkspaceFile = (path: string) => Bun.file(resolve(workspaceRoot, path)).text();

describe("desktop loading and packaging boundaries", () => {
  test("paints a system-aware boot shell before React mounts", async () => {
    const [html, bootTheme] = await Promise.all([
      readDesktopFile("index.html"),
      readDesktopFile("src/renderer/boot-theme.ts"),
    ]);

    expect(html).toContain('id="openteam-boot-shell"');
    expect(html).toContain("#root:not(:empty) + #openteam-boot-shell");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(bootTheme).toContain('localStorage.getItem("openteam:theme")');
    expect(bootTheme).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });

  test("allows user-selected HTTP servers without allowing remote scripts", async () => {
    const html = await readDesktopFile("index.html");

    expect(html).toContain("connect-src 'self' http: https:");
    expect(html).toContain("img-src 'self' data: blob: openteam-staged: http: https:");
    expect(html).toContain("frame-src http: https:");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toContain("script-src 'self' http:");
  });

  test("keeps the full emoji corpus behind the panel boundary", async () => {
    const pickerSource = await readDesktopFile("src/renderer/components/openteam/emoji/picker.tsx");
    const panelSource = await readDesktopFile("src/renderer/components/openteam/emoji/data.ts");

    expect(pickerSource).not.toContain("emojibase-data");
    expect(pickerSource).toContain('import("./panel")');
    expect(panelSource).toContain("emojibase-data/en/compact.json");
  });

  test("keeps rich capabilities in independent dynamic modules", async () => {
    const richSource = await readDesktopFile(
      "src/renderer/components/ai-elements/message-response/rich.tsx"
    );
    const pluginSource = await readDesktopFile(
      "src/renderer/components/ai-elements/message-response/plugins.ts"
    );

    expect(richSource).not.toMatch(/from "@streamdown\/(?:cjk|code|math|mermaid)"/);
    for (const capability of ["cjk", "code", "math", "mermaid"]) {
      expect(pluginSource).toContain(`import("./${capability}")`);
    }

    const codeSource = await readDesktopFile(
      "src/renderer/components/ai-elements/message-response/code.ts"
    );
    expect(codeSource).not.toContain("@streamdown/code");
    expect(codeSource).not.toMatch(/from ["']shiki["']/);
    expect(codeSource).toContain('from "shiki/core"');
    expect(codeSource).toContain('from "shiki/engine/javascript"');
    expect(codeSource).toContain('from "@shikijs/themes/github-dark"');
    expect(codeSource).not.toContain('from "shiki/themes"');
  });

  test("imports avatar runtime helpers without initializing the contracts schema barrel", async () => {
    const pickerSource = await readDesktopFile(
      "src/renderer/components/openteam/avatar-picker.tsx"
    );
    const iconsSource = await readDesktopFile(
      "src/renderer/components/openteam/avatar-picker-icons.tsx"
    );

    expect(pickerSource).toContain('from "@openteam/contracts/bot-avatar"');
    expect(iconsSource).toContain('from "@openteam/contracts/bot-avatar"');
    expect(pickerSource).not.toContain('from "@openteam/contracts"');
  });

  test("keeps the routine editor behind its own inspector interaction boundary", async () => {
    const [inspectorSource, editorSource, summarySource] = await Promise.all([
      readDesktopFile("src/renderer/components/openteam/inspector.tsx"),
      readDesktopFile("src/renderer/components/openteam/routine-panel.tsx"),
      readDesktopFile("src/renderer/components/openteam/routine-summary.tsx"),
    ]);

    expect(inspectorSource).toContain('import("./routine-summary")');
    expect(inspectorSource).toContain('import("./routine-panel")');
    expect(editorSource).not.toContain("routine-event-fields");
    expect(editorSource).toContain('from "../ui/select"');
    expect(summarySource).not.toContain("routine-panel");
    expect(summarySource).not.toContain("RoutineEditor");
  });

  test("keeps KaTeX styles off the shell and runtime modules out of ASAR inputs", async () => {
    const [styles, mainSource] = await Promise.all([
      readDesktopFile("src/renderer/styles.css"),
      readDesktopFile("src/main/index.ts"),
    ]);
    const packageJson = JSON.parse(await readDesktopFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(styles).not.toContain("katex/dist/katex.min.css");
    expect(styles).not.toContain('@import "tw-animate-css"');
    for (const utility of [
      "animate-in",
      "animate-out",
      "fade-in",
      "fade-in-0",
      "fade-out-0",
      "zoom-in-50",
      "zoom-in-95",
      "zoom-out-95",
      "slide-in-from-bottom-1",
      "slide-in-from-bottom-2",
      "slide-in-from-left-2",
      "slide-in-from-right-2",
      "slide-in-from-top-2",
    ]) {
      expect(styles).toContain(`@utility ${utility}`);
    }
    for (const property of [
      "--tw-enter-opacity",
      "--tw-enter-scale",
      "--tw-enter-translate-x",
      "--tw-enter-translate-y",
      "--tw-exit-opacity",
      "--tw-exit-scale",
      "--tw-exit-translate-x",
      "--tw-exit-translate-y",
    ]) {
      expect(styles).toContain(`@property ${property}`);
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
    expect(packageJson.devDependencies?.["electron-updater"]).toBeDefined();
    expect(packageJson.devDependencies?.["tw-animate-css"]).toBeUndefined();
    expect(packageJson.devDependencies?.react).toBeDefined();
    expect(packageJson.scripts?.predev).toBe("bun run build:electron");
    expect(packageJson.scripts?.["build:electron"]).toContain("build:utility");
    expect(packageJson.scripts?.["build:main"]).toContain("--splitting");
    expect(mainSource).toContain('import("electron-updater")');
    expect(mainSource).not.toMatch(/import\s+\w+\s+from\s+["']electron-updater["']/);
    expect(mainSource).toContain("additionalArguments:");
    expect(mainSource).toContain("--openteam-app-version=");
    expect(await readDesktopFile("src/preload/index.ts")).not.toContain("sendSync");
    expect(packageJson.scripts?.dev).not.toContain("clean");
  });

  test("keeps document readers lazy, bounded, and out of packaged runtime dependencies", async () => {
    const [
      attachmentSource,
      workerClientSource,
      workerSource,
      progressiveSource,
      docxSource,
      tableSource,
      packageSource,
      viteSource,
    ] = await Promise.all([
      readDesktopFile("src/renderer/components/openteam/file-attachment.tsx"),
      readDesktopFile("src/renderer/components/openteam/document-preview/worker-client.ts"),
      readDesktopFile("src/renderer/components/openteam/document-preview/preview.worker.ts"),
      readDesktopFile("src/renderer/components/openteam/document-preview/progressive-dom.ts"),
      readDesktopFile("src/renderer/components/openteam/document-preview/docx-parser.ts"),
      readDesktopFile("src/renderer/components/openteam/document-preview/spreadsheet-parser.ts"),
      readDesktopFile("package.json"),
      readDesktopFile("vite.config.ts"),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
    for (const dependency of ["mammoth", "pdfjs-dist", "xlsx"]) {
      expect(packageJson.devDependencies?.[dependency]).toBeDefined();
    }
    expect(attachmentSource).toContain('import("pdfjs-dist")');
    expect(attachmentSource).toContain('import("pdfjs-dist/build/pdf.worker.min.mjs?url")');
    expect(attachmentSource).not.toContain('import("mammoth")');
    expect(attachmentSource).not.toContain('import("xlsx")');
    expect(attachmentSource).toContain("parseDocumentPreview(kind, buffer, controller.signal)");
    expect(workerClientSource).toContain('new Worker(new URL("./preview.worker.ts"');
    expect(workerClientSource).toContain("worker.terminate()");
    expect(workerClientSource).toContain("worker.postMessage({ buffer, kind }, [buffer])");
    expect(attachmentSource).toContain("sanitizePreviewDocument(html)");
    expect(attachmentSource).toContain("<ProgressiveHtmlPreview source={state.value} />");
    expect(progressiveSource).toContain("sourceNode.cloneNode(false)");
    expect(progressiveSource).toContain("maxNodesPerFrame = 320");
    expect(progressiveSource).toContain("frameBudgetMs = 4");
    expect(progressiveSource).toContain("target.replaceChildren()");
    expect(progressiveSource).toContain("script,style,iframe,object,embed,form,input,button");
    expect(progressiveSource).toContain('name.startsWith("on")');
    expect(progressiveSource).toContain("data:image\\/");
    expect(viteSource).toContain('worker: { format: "es" }');
    expect(workerSource).toContain('import("./docx-parser")');
    expect(workerSource).toContain('import("./spreadsheet-parser")');
    expect(docxSource).toContain('import("mammoth")');
    expect(docxSource).not.toContain("xlsx");
    expect(tableSource).toContain('import("xlsx")');
    expect(tableSource).not.toContain("mammoth");
    expect(attachmentSource).not.toContain('import pdfWorkerUrl from "pdfjs-dist');
    expect(attachmentSource).toContain("readBoundedResponse(");
    expect(attachmentSource).toContain("maxItems: 6");
    expect(tableSource).toContain("sourceRange.s.r + 199");
    expect(tableSource).toContain("sourceRange.s.c + 29");
  });

  test("keeps raw AssetRef transport alongside bounded renderer data endpoints", async () => {
    const [adapterSource, source, pluginScaleSource] = await Promise.all([
      readDesktopFile("src/renderer/client/openteam-api.ts"),
      readWorkspaceFile("packages/client-core/src/client.ts"),
      readDesktopFile("src/renderer/lib/plugin-settings-scale.ts"),
    ]);

    expect(adapterSource).toContain("...openTeamClient");
    expect(source).toContain('transport.request<AssetRef>("/api/v0/assets"');
    expect(source).toContain(
      '"content-type": mimeType || input.type || "application/octet-stream"'
    );
    expect(source).toContain("body: input");
    expect(source).toContain("attachments: readonly AssetRef[]");
    expect(source).toContain("attachments: [...attachments]");
    expect(source).toContain('!("bytesBase64" in input)');
    expect(source).toContain('transport.request<ClientBootstrapView>("/api/v0/client-bootstrap")');
    expect(source).toContain("channelHistory:");
    expect(source).toContain("messageContext:");
    expect(source).toContain("authenticatePlugin:");
    expect(source).toContain("configurePluginConnection:");
    expect(source).toContain("pluginConnectionStatuses:");
    expect(source).toContain("pluginBotAccess:");
    expect(source).toContain('from "@openteam/contracts/plugin-settings"');
    expect(pluginScaleSource).toContain('from "@openteam/contracts/plugin-settings"');
  });

  test("loads plugin policy controls only after entering plugin details", async () => {
    const [settingsSource, detailSource] = await Promise.all([
      readDesktopFile("src/renderer/components/openteam/plugin-settings.tsx"),
      readDesktopFile("src/renderer/components/openteam/plugin-settings-detail.tsx"),
    ]);

    expect(settingsSource).toContain('import("./plugin-settings-detail")');
    expect(settingsSource).not.toContain('from "../ui/select"');
    expect(settingsSource).toContain("onOpenChange={setBotAccessExpanded}");
    expect(settingsSource).toContain("setBotAccessOffset(botAccess.offset +");
    expect(settingsSource).not.toContain("loadMoreBotAccess");
    expect(detailSource).toContain('from "../ui/select"');
    expect(detailSource).toContain("PluginPolicySelect");
  });

  test("keeps About and each Settings section in independently audited lazy modules", async () => {
    const [app, shell, general, about, measure, budgets] = await Promise.all([
      readDesktopFile("src/renderer/App.tsx"),
      readDesktopFile("src/renderer/components/openteam/settings/panel.tsx"),
      readDesktopFile("src/renderer/components/openteam/settings/general.tsx"),
      readDesktopFile("src/renderer/components/openteam/settings/about.tsx"),
      Bun.file(resolve(desktopRoot, "../../scripts/performance/measure-desktop-build.ts")).text(),
      Bun.file(resolve(desktopRoot, "../../scripts/performance/check-desktop-budgets.ts")).text(),
    ]);

    expect(app).toContain('import("./components/openteam/settings/about")');
    expect(app).toContain('import("./components/openteam/settings/panel")');
    expect(app).toContain('import("./components/openteam/settings/general")');
    expect(app).toContain('import("./components/openteam/settings/general-bot")');
    expect(shell).toContain('import("./general")');
    expect(shell).toContain('import("./computer")');
    expect(shell).toContain('import("./server")');
    expect(shell).toContain('import("./updates")');
    expect(shell).toContain("attempts < 120");
    expect(shell).not.toContain("Copyright © 2026 OpenTeam contributors");
    expect(general).toContain('import("./general-bot")');
    expect(about).toContain("Copyright © 2026 OpenTeam contributors");

    for (const boundary of [
      "settingsInitial",
      "settingsShell",
      "settingsAbout",
      "settingsGeneral",
      "settingsGeneralBot",
      "settingsComputer",
      "settingsServer",
      "settingsUpdates",
    ]) {
      expect(measure).toContain(`${boundary}:`);
      expect(budgets).toContain(`${boundary}:`);
    }
  });

  test("warms the lazy search surface only after the app is ready or the control has intent", async () => {
    const [app, sidebar] = await Promise.all([
      readDesktopFile("src/renderer/App.tsx"),
      readDesktopFile("src/renderer/components/openteam/sidebar.tsx"),
    ]);

    expect(app).toContain(
      'const loadSearchDialog = () => import("./components/openteam/search-dialog")'
    );
    expect(app).toContain("requestIdleCallback(preloadSearchDialog");
    expect(app).toContain("if (!appReady) return");
    expect(app).toContain("onPreloadSearch={preloadSearchDialog}");
    expect(sidebar).toContain("onPointerEnter={onPreloadSearch}");
    expect(sidebar).toContain("onFocus={onPreloadSearch}");
  });

  test("keeps the shell deep-link event out of the Streamdown configuration closure", async () => {
    const [app, deepLinks, responseConfig] = await Promise.all([
      readDesktopFile("src/renderer/App.tsx"),
      readDesktopFile("src/renderer/lib/app-deep-links.ts"),
      readDesktopFile("src/renderer/components/ai-elements/message-response/config.tsx"),
    ]);

    expect(app).toContain("OPENTEAM_DEEP_LINK_EVENT,");
    expect(app).not.toContain('from "./components/ai-elements/message-response/config"');
    expect(deepLinks).toContain('OPENTEAM_DEEP_LINK_EVENT = "openteam:deep-link"');
    expect(responseConfig).toContain(
      'export { OPENTEAM_DEEP_LINK_EVENT } from "../../../lib/app-deep-links"'
    );
  });
});
