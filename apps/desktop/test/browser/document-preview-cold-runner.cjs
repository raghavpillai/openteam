const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.DOCUMENT_PREVIEW_COLD_DIR, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1456,
    height: 924,
    webPreferences: { backgroundThrottling: false },
  });
  let navigations = 0;
  const reports = [];
  window.webContents.on("did-navigate", () => navigations++);
  const run = (fn, argument) =>
    window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (fn) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await run(fn)) return;
      await pause(50);
    }
    throw Error(
      "Preview did not render without a navigation; first-use dependency optimization may have reloaded the app."
    );
  };
  try {
    await window.loadURL(process.env.DOCUMENT_PREVIEW_COLD_URL);
    await wait(() => document.querySelector("[data-file-attachment-card]"));
    const docx = "Preview sample.docx";
    const csv = "bank-transactions-reconciled-v2-2026-11-10.csv";
    const names =
      process.env.DOCUMENT_PREVIEW_COLD_ORDER === "docx-first"
        ? [docx, csv, docx]
        : [csv, docx, csv];
    for (const name of names) {
      const before = navigations;
      await run((name) => {
        const button = [...document.querySelectorAll("button")].find(
          (element) => element.getAttribute("aria-label") === "Open " + name
        );
        if (!button) throw Error("Missing attachment: " + name);
        button.click();
      }, name);
      if (name === docx) {
        await wait(() =>
          document
            .querySelector('[role="dialog"] .openteam-document-preview')
            ?.textContent.includes("A neutral document")
        );
      } else {
        await wait(() =>
          document
            .querySelector('[role="dialog"] .openteam-table-preview')
            ?.textContent.includes("January")
        );
      }
      // Catch delayed optimizer reloads as well as immediate preview loss.
      await pause(250);
      if (navigations !== before) throw Error("Opening " + name + " reloaded the app");
      const stageOpen = await run(() => Boolean(document.querySelector("[data-attachment-stage]")));
      if (!stageOpen) throw Error("Opening " + name + " lost the preview stage");
      reports.push({ name, parsed: true, additionalNavigations: navigations - before });
      await run(() => document.querySelector('button[aria-label="Close preview"]').click());
      await wait(() => !document.querySelector("[data-attachment-stage]"));
    }
    fs.writeFileSync(
      path.join(process.env.DOCUMENT_PREVIEW_COLD_DIR, "results.json"),
      JSON.stringify({ reports })
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(process.env.DOCUMENT_PREVIEW_COLD_DIR, "results.json"),
      JSON.stringify({ error: String(error), reports, navigations })
    );
  } finally {
    app.quit();
  }
});
