import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grok account and media UI parity guards", () => {
  test("keeps the source-verified account actions in Grok's menu order", async () => {
    const source = await read("../src/renderer/components/openbot/sidebar.tsx");
    const menuStart = source.indexOf("<DropdownMenuContent");
    const menuEnd = source.indexOf("</DropdownMenuContent>", menuStart);
    const menu = source.slice(menuStart, menuEnd);
    const labels = [
      "Weekly usage",
      "Get OpenBot for iOS",
      "Settings",
      "About",
      "Help Center",
      "Send Feedback",
      "Log out",
    ];
    const offsets = labels.map((label) => menu.indexOf(label));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(source).toContain("New update available");
    expect(source).toContain("openbot?.updates.openDownload()");
    expect(source).toContain("openbot:deep-link");
  });

  test("keeps source-verified Grok dialog and file-viewer geometry", async () => {
    const [settings, plugins, attachment, sidebar] = await Promise.all([
      read("../src/renderer/components/openbot/settings-panel.tsx"),
      read("../src/renderer/components/openbot/plugin-settings.tsx"),
      read("../src/renderer/components/openbot/file-attachment.tsx"),
      read("../src/renderer/components/openbot/sidebar.tsx"),
    ]);

    expect(settings).toContain("h-[min(700px,calc(100vh-96px))]");
    expect(settings).toContain("w-[min(1000px,calc(100vw-40px))]");
    expect(settings).toContain("grid-cols-[198px_minmax(0,1fr)]");
    expect(settings).toContain('surface="transparent"');
    expect(settings).toContain("dark:bg-[#070707]");
    expect(settings).toContain("dark:bg-[#111111]");
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
    const [attachment, chat, image, response] = await Promise.all([
      read("../src/renderer/components/openbot/file-attachment.tsx"),
      read("../src/renderer/components/openbot/chat-pane.tsx"),
      read("../src/renderer/components/openbot/image-attachment.tsx"),
      read("../src/renderer/components/ai-elements/message-response-config.tsx"),
    ]);

    expect(attachment).toContain('import("pdfjs-dist")');
    expect(attachment).toContain('import("mammoth")');
    expect(attachment).toContain('import("xlsx")');
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

  test("keeps native bulk download and update IPC behind validated preload APIs", async () => {
    const [main, preload] = await Promise.all([
      read("../src/main/index.ts"),
      read("../src/preload/index.ts"),
    ]);
    expect(main).toContain('ipcMain.handle("openbot:files:download-all"');
    expect(main).toContain('ipcMain.handle("openbot:updates:check"');
    expect(main).toContain('ipcMain.handle("openbot:updates:open-download"');
    expect(preload).toContain('ipcRenderer.invoke("openbot:files:download-all"');
    expect(preload).toContain('ipcRenderer.invoke("openbot:updates:check"');
  });
});
