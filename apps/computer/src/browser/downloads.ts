import { mkdir, stat } from "node:fs/promises";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import type { Protocol } from "playwright-core/types/protocol";

export interface BrowserDownload {
  filename: string;
  state: "inProgress" | "completed" | "canceled";
  directory: string;
  path?: string;
}

/** Chrome owns naming/collision handling; reports are limited to leased tabs. */
export class BrowserDownloads {
  private readonly records = new Map<
    string,
    {
      owner: Promise<Page | undefined>;
      result: BrowserDownload;
      done: Promise<void>;
      finish: () => void;
    }
  >();

  private constructor(
    private readonly cdp: CDPSession,
    private readonly context: BrowserContext,
    private readonly pages: () => Page[],
    private readonly directory: string
  ) {}

  static async create(
    browser: Browser,
    context: BrowserContext,
    pages: () => Page[],
    directory: string
  ) {
    await mkdir(directory, { recursive: true });
    const cdp = await browser.newBrowserCDPSession();
    const downloads = new BrowserDownloads(cdp, context, pages, directory);
    cdp.on("Browser.downloadWillBegin", (event) => downloads.started(event));
    cdp.on("Browser.downloadProgress", (event) => downloads.progress(event));
    // CDP attachment otherwise defaults to temporary, GUID-named artifacts.
    // This trusted setup is not exposed through the agent's browser_cdp tool.
    // Restore Chrome's normal profile settings, including safe filename
    // uniquification. CDP's "allow" mode overwrites duplicate filenames.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
    browser.on("disconnected", () => downloads.records.clear());
    return downloads;
  }

  private async owner(frameId: string): Promise<Page | undefined> {
    const contains = (tree: Protocol.Page.FrameTree): boolean =>
      tree.frame.id === frameId || Boolean(tree.childFrames?.some(contains));
    const matches = await Promise.all(
      this.pages().map(async (page) => {
        let cdp: CDPSession | undefined;
        try {
          cdp = await this.context.newCDPSession(page);
          return contains((await cdp.send("Page.getFrameTree")).frameTree) ? page : undefined;
        } catch {
          return undefined;
        } finally {
          await cdp?.detach().catch(() => {});
        }
      })
    );
    return matches.find(Boolean);
  }

  private started(event: Protocol.Browser.downloadWillBeginPayload) {
    let finish!: () => void;
    const owner = this.owner(event.frameId);
    this.records.set(event.guid, {
      owner,
      result: { filename: event.suggestedFilename, state: "inProgress", directory: this.directory },
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish,
    });
    void owner.then((page) => {
      if (!page) this.records.delete(event.guid);
    });
    // Retain a bounded recent history, including paths needed by follow-up tools.
    if (this.records.size > 100) {
      for (const [guid, record] of this.records) {
        if (record.result.state !== "inProgress") this.records.delete(guid);
        if (this.records.size <= 100) break;
      }
    }
  }

  private progress(event: Protocol.Browser.downloadProgressPayload) {
    const record = this.records.get(event.guid);
    if (!record) return;
    record.result.state = event.state;
    if (event.state !== "inProgress") {
      // Chrome may omit the path on some platforms. Never invent one from the
      // suggested name: Chrome may have changed it to avoid overwriting a file.
      if (event.state === "completed" && event.filePath) record.result.path = event.filePath;
      record.finish();
    }
  }

  async forPage(page: Page): Promise<BrowserDownload[]> {
    const records = (
      await Promise.all(
        [...this.records.values()].map(async (record) =>
          (await record.owner) === page ? record : undefined
        )
      )
    ).filter((record) => record !== undefined);
    if (records.some((record) => record.result.state === "inProgress")) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(records.map((record) => record.done)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 750);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return Promise.all(
      records.slice(-10).map(async ({ result }) => {
        const download = { ...result };
        if (
          download.path &&
          !(await stat(download.path).then(
            (file) => file.isFile(),
            () => false
          ))
        )
          delete download.path;
        return download;
      })
    );
  }
}
