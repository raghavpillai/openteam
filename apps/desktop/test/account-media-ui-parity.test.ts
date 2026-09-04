import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Bot account and media UI parity guards", () => {
  test("keeps the applicable account actions in Bot's menu order", async () => {
    const source = await read("../src/renderer/components/openteam/sidebar.tsx");
    const menuStart = source.indexOf("<DropdownMenuContent");
    const menuEnd = source.indexOf("</DropdownMenuContent>", menuStart);
    const menu = source.slice(menuStart, menuEnd);
    const labels = [
      "Get OpenTeam for iOS",
      "Settings",
      "About",
      "Help Center",
      "Send Feedback",
      "Log out",
    ];
    const offsets = labels.map((label) => menu.indexOf(label));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(menu).not.toContain("Weekly usage");
    expect(source).toContain("New update available");
    expect(source).toContain("openteam?.updates.openDownload()");
  });

  test("keeps source-verified Bot dialog and file-viewer geometry", async () => {
    const [settings, plugins, attachment, sidebar] = await Promise.all([
      read("../src/renderer/components/openteam/settings/panel.tsx"),
      read("../src/renderer/components/openteam/plugin-settings.tsx"),
      read("../src/renderer/components/openteam/file-attachment.tsx"),
      read("../src/renderer/components/openteam/sidebar.tsx"),
    ]);

    expect(settings).toContain("h-[min(700px,calc(100vh-96px))]");
    expect(settings).toContain("w-[min(1000px,calc(100vw-40px))]");
    expect(settings).toContain("grid-cols-[198px_minmax(0,1fr)]");
    expect(settings).toContain("max-sm:grid-cols-1");
    expect(settings).toContain("max-sm:grid-rows-[auto_minmax(0,1fr)]");
    expect(settings).toContain("max-sm:flex");
    expect(settings).toContain('surface="transparent"');
    expect(settings).toContain("dark:bg-[#070707]");
    expect(settings).toContain("dark:bg-[#111111]");
    expect(settings).toContain('aria-label="Close"');
    expect(plugins).toContain("h-[min(700px,calc(100vh-96px))]");
    expect(plugins).toContain("w-[min(1000px,calc(100vw-40px))]");
    expect(plugins).toContain('surface={page === "detail" ? "transparent" : "modal"}');
    expect(plugins).toContain('size === "md" && "size-10 text-[14px]"');
    expect(plugins).toContain("h-[26px] rounded-[6px] border-[0.5px] px-2 text-[13px]");
    expect(plugins).toContain("View Source");
    expect(plugins).toContain("navigator.share");
    expect(attachment).toContain("h-[calc(100vh-80px)]");
    expect(attachment).toContain("w-[min(1100px,calc(100vw-80px))]");
    expect(attachment).toContain("grid-rows-[40px_minmax(0,1fr)]");
    expect(attachment).toContain("min-w-[min(220px,100%)]");
    expect(attachment).toContain("max-w-[min(340px,100%)]");
    expect(sidebar).toContain("What happened? What did you expect?");
    expect(sidebar).toContain("Include current conversation ID");
    expect(sidebar).toContain("I would like a response to my feedback");
  });

  test("keeps document previews, download-all, and media navigation wired", async () => {
    const [attachment, docxParser, tableParser, chat, image, response] = await Promise.all([
      read("../src/renderer/components/openteam/file-attachment.tsx"),
      read("../src/renderer/components/openteam/document-preview/docx-parser.ts"),
      read("../src/renderer/components/openteam/document-preview/spreadsheet-parser.ts"),
      read("../src/renderer/components/openteam/chat-pane.tsx"),
      read("../src/renderer/components/openteam/image-attachment.tsx"),
      read("../src/renderer/components/ai-elements/message-response/config.tsx"),
    ]);

    expect(attachment).toContain('import("pdfjs-dist")');
    expect(attachment).toContain("parseDocumentPreview(kind, buffer, controller.signal)");
    expect(docxParser).toContain('import("mammoth")');
    expect(tableParser).toContain('import("xlsx")');
    expect(attachment).toContain("<audio className");
    expect(attachment).toContain("<video className");
    expect(chat).toContain("Download all");
    expect(chat).toContain("downloadAttachments(attachments)");
    expect(image).toContain('aria-label="Previous media"');
    expect(image).toContain('aria-label="Next media"');
    expect(image).toContain('event.key === "ArrowLeft"');
    expect(image).toContain('event.key === "ArrowRight"');
    expect(response).toContain("download: true");
    expect(response).toContain("fullscreen: true");
    expect(response).toContain("panZoom: true");
  });

  test("keeps native media menus, bulk download, and update IPC behind Electron boundaries", async () => {
    const [main, preload, image] = await Promise.all([
      read("../src/main/index.ts"),
      read("../src/preload/index.ts"),
      read("../src/renderer/components/openteam/image-attachment.tsx"),
    ]);
    expect(main).toContain('webContents.on("context-menu"');
    expect(main).toContain('params.mediaType !== "image"');
    expect(preload).not.toContain("openteam:image-context-menu");
    expect(image).not.toContain("showImageContextMenu");
    expect(image.match(/onContextMenu=\{\(event\) => event\.stopPropagation\(\)\}/g)).toHaveLength(
      3
    );
    expect(main).toContain('ipcMain.handle("openteam:files:download-all"');
    expect(main).toContain('ipcMain.handle("openteam:updates:check"');
    expect(main).toContain('ipcMain.handle("openteam:updates:open-download"');
    expect(main).toContain('ipcMain.handle("openteam:updates:update-server"');
    expect(preload).toContain('ipcRenderer.invoke("openteam:files:download-all"');
    expect(preload).toContain('ipcRenderer.invoke("openteam:updates:check"');
    expect(preload).toContain('ipcRenderer.invoke("openteam:updates:update-server"');
  });
});
