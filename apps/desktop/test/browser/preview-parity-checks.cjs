const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { chromium } = createRequire(path.resolve(__dirname, "../../../computer/package.json"))(
  "playwright-core"
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = [
  "Transactions.csv",
  "Budget.xlsx",
  "Project-review.pdf",
  "Project-review.docx",
  "Readme.md",
  "Notes.txt",
  "Example.py",
  "Settings.json",
  "Dashboard.html",
  "Landscape.png",
  "Landscape.jpg",
  "Motion.gif",
  "Diagram.svg",
  "Video.mp4",
  "Audio.mp3",
  "Audio.wav",
  "Archive.zip",
];
const mime = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
  py: "text/x-python",
  json: "application/json",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
};

async function recording(page, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", (event) => {
    cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    const file = path.join(directory, `${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(event.data, "base64"));
    frames.push({ file, time: event.metadata.timestamp });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    maxWidth: 1456,
    maxHeight: 924,
    everyNthFrame: 1,
  });
  return async (output) => {
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
    if (frames.length < 2) throw Error("Recording did not receive app frames");
    const list =
      frames
        .map(
          (frame, index) =>
            `file '${frame.file}'\nduration ${Math.max(1 / 120, (frames[index + 1]?.time ?? frame.time + 0.15) - frame.time)}`
        )
        .join("\n") + `\nfile '${frames.at(-1).file}'\n`;
    const manifest = path.join(directory, "frames.txt");
    fs.writeFileSync(manifest, list);
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        manifest,
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-r",
        "60",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { encoding: "utf8" }
    );
    if (result.status) throw Error(result.stderr || "MP4 encoding failed");
    fs.rmSync(directory, { recursive: true, force: true });
  };
}

module.exports = async function checks({ port, url, out, fixtureDirectory, record = false }) {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const p = b.contexts()[0].pages()[0];
  p.setDefaultTimeout(12000);
  const errors = [],
    results = [],
    clips = [];
  let current = "setup";
  p.on("pageerror", (error) => errors.push(error.message));
  const assert = (value, message) => {
    if (!value) throw Error(`${current}: ${message}`);
  };
  try {
    if (fixtureDirectory) {
      const fixtures = Object.fromEntries(
        samples.map((name) => [
          name,
          {
            data: fs.readFileSync(path.join(fixtureDirectory, name)).toString("base64"),
            mimeType: mime[name.split(".").at(-1)],
          },
        ])
      );
      await p.addInitScript((fixtures) => {
        window.previewAuditFixtures = fixtures;
      }, fixtures);
    }
    await p.setViewportSize({ width: 1456, height: 924 });
    for (const theme of ["dark", "light"]) {
      await p.goto(`${url}?theme=${theme}&preview-set&bot=Preview%20Studio`);
      await p.locator("[contenteditable]").waitFor();
      const details = p.getByRole("button", { name: "Close details", exact: true });
      if (!(await details.isVisible()))
        await p
          .getByRole("button", { name: "View conversation details", exact: true })
          .first()
          .click();
      await p.getByRole("tab", { name: "Library", exact: true }).click();
      for (const name of samples) {
        current = `${theme}: ${name}`;
        const slug = `${theme}-${name.replaceAll(".", "-")}`;
        const file = p.getByRole("button", { name, exact: true });
        await file.scrollIntoViewIfNeeded();
        const stop =
          record && theme === "dark" ? await recording(p, path.join(out, "frames-" + slug)) : null;
        if (stop) await pause(250);
        await file.click();
        const stage = p.locator("[data-attachment-stage]");
        await stage.waitFor();
        await p.waitForFunction(
          () =>
            Math.abs(
              document.querySelector("[data-attachment-stage]")?.getBoundingClientRect().y - 32
            ) < 0.1
        );
        if (name.endsWith(".csv") || name.endsWith(".xlsx")) {
          await p.getByRole("grid").waitFor();
          const grid = p.getByRole("grid");
          await grid.locator('[data-row="1"][data-col="0"]').click();
          await p.keyboard.press("ArrowRight");
          await p.keyboard.press("Shift+ArrowRight");
          assert(
            (await grid.locator('[aria-selected="true"]').count()) === 2,
            "Shift selection spans two cells"
          );
          const copy = await grid.evaluate((element) => {
            const clipboard = new DataTransfer();
            element.dispatchEvent(
              new ClipboardEvent("copy", { bubbles: true, clipboardData: clipboard })
            );
            return clipboard.getData("text/plain");
          });
          assert(copy.includes("\t"), "copy returns a tab-separated range");
          await p.getByRole("button", { name: "Expand cell value", exact: true }).click();
          assert(
            (await p.getByRole("button", { name: "Collapse cell value", exact: true }).count()) ===
              1,
            "cell value expands"
          );
          if (name.endsWith(".xlsx")) {
            await p.getByRole("tab", { name: "Transactions", exact: true }).click();
            assert(
              (await grid.innerText()).includes("Corner Coffee"),
              "all workbook tabs are usable"
            );
          }
          await grid.focus();
        } else if (name.endsWith(".pdf")) {
          await p.locator('[aria-label="3 page PDF preview"] canvas').first().waitFor();
          const canvas = p.locator('[aria-label="3 page PDF preview"] canvas').first();
          const before = await canvas.evaluate((e) => e.width);
          await p.getByRole("button", { name: "Zoom in", exact: true }).click();
          await p.waitForFunction(
            (width) =>
              document.querySelector('[aria-label="3 page PDF preview"] canvas')?.width > width,
            before
          );
          await p.getByRole("button", { name: "Zoom out", exact: true }).click();
        } else if (name.endsWith(".docx")) {
          await stage
            .getByText(fixtureDirectory ? "Milestones" : "A neutral document for visual checks.", {
              exact: true,
            })
            .waitFor();
        } else if (name.endsWith(".md")) {
          await stage.getByRole("heading", { name: "Project review", exact: true }).waitFor();
        } else if (name.endsWith(".json")) {
          await p.getByRole("button", { name: "Expand keyboard", exact: true }).click();
          assert((await stage.innerText()).includes('"close"'), "JSON branches expand");
          await p.getByRole("button", { name: "Collapse settings", exact: true }).click();
        } else if (name.endsWith(".html")) {
          const frame = p.frameLocator('iframe[title="HTML file preview"]');
          await frame.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
          await p.getByRole("tab", { name: "Source", exact: true }).click();
          await p.locator(".preview-code-line").first().waitFor();
          await p.getByRole("tab", { name: "Preview", exact: true }).click();
          await frame.locator("body").click();
        } else if (/\.(png|jpg|gif|svg)$/.test(name)) {
          await p.locator(".media-stage-cell img").waitFor();
        } else if (name.endsWith(".mp4")) {
          await p.waitForFunction(
            () => document.querySelector("[data-attachment-stage] video")?.readyState >= 2
          );
          await p.getByRole("button", { name: "Play video", exact: true }).click();
          await pause(250);
          assert(
            (await p.getByRole("button", { name: "Pause video", exact: true }).count()) === 1,
            "video plays"
          );
          await p.locator("[data-attachment-stage] video").focus();
        } else if (/\.(mp3|wav)$/.test(name)) {
          await p.waitForFunction(
            () => document.querySelector("[data-attachment-stage] audio")?.readyState >= 2
          );
          await p.getByRole("button", { name: `Play ${name}`, exact: true }).click();
          await pause(100);
          await p.getByRole("button", { name: "Playback speed 1x", exact: true }).click();
          assert(
            (await p.getByRole("button", { name: "Playback speed 1.25x", exact: true }).count()) ===
              1,
            "audio speed changes"
          );
          await p.getByRole("button", { name: "Mute", exact: true }).click();
          await p.getByRole("slider", { name: `Seek in ${name}`, exact: true }).focus();
        } else if (name.endsWith(".zip")) {
          await stage.getByText("Preview not available", { exact: true }).waitFor();
        } else {
          await p.locator(".preview-code-line").first().waitFor();
          assert(
            (await p.locator(".preview-line-number").count()) > 1,
            "text and code have line numbers"
          );
        }
        await pause(stop ? 1600 : 70);
        await p.screenshot({ path: path.join(out, slug + ".png") });
        await p.keyboard.press("Escape");
        await stage.waitFor({ state: "hidden" });
        assert(await details.isVisible(), "Escape restores the right panel");
        await p.waitForFunction(
          (element) => document.activeElement === element,
          await file.elementHandle()
        );
        if (stop) {
          await pause(250);
          const clip = path.join(out, slug + ".mp4");
          await stop(clip);
          clips.push(clip);
        }
        results.push({ theme, file: name, escapeClosed: true });
        console.log("PASS", current);
      }
      current = `${theme}: image gallery`;
      await details.click();
      const image = p.locator("[data-image-tile] button").first();
      await image.scrollIntoViewIfNeeded();
      const stopGallery =
        record && theme === "dark" ? await recording(p, path.join(out, "frames-gallery")) : null;
      if (stopGallery) await pause(250);
      await image.click();
      await p.locator("[data-media-filmstrip] button").last().waitFor();
      assert(
        (await p.locator("[data-media-filmstrip] button").count()) === 4,
        "all gallery items remain available"
      );
      await p.getByRole("button", { name: "Close media preview", exact: true }).focus();
      for (let index = 0; index < 3; index++) {
        await p.keyboard.press("ArrowRight");
        if (stopGallery) await pause(450);
      }
      assert(
        (await p
          .getByRole("button", { name: "View media 4 of 4", exact: true })
          .getAttribute("aria-current")) === "true",
        "gallery arrow navigation works"
      );
      await p.screenshot({ path: path.join(out, theme + "-Gallery.png") });
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
      if (stopGallery) {
        await pause(250);
        const clip = path.join(out, "dark-Gallery.mp4");
        await stopGallery(clip);
        clips.push(clip);
      }
      results.push({ theme, file: "Image gallery", escapeClosed: true });
      console.log("PASS", current);
    }
    assert(!errors.length, errors.join("\n"));
    for (const theme of ["light", "dark"]) {
      current = `${theme}: hover composer`;
      await p.goto(
        `${url}?theme=${theme}&files&bot=Finance%20Guy&botColor=%238b5cf6&botIcon=goggles`
      );
      const editor = p.getByRole("textbox", { name: "Message", exact: true });
      await editor.waitFor();
      await editor.fill("Draft written before opening the preview");
      const editorNode = await editor.elementHandle();
      const file = p.getByRole("button", {
        name: "Open bank-transactions-reconciled-v2-2026-11-10.csv",
        exact: true,
      });
      await file.click();
      await p.getByRole("grid").waitFor();
      const bubble = p.getByRole("button", { name: "Message Finance Guy", exact: true });
      const composer = p.locator("[data-preview-composer]");
      assert((await bubble.getAttribute("aria-expanded")) === "false", "composer starts minimized");
      assert(
        (await bubble.locator('[data-avatar-shape="goggles"]').count()) === 1,
        "bubble uses this bot's chosen icon"
      );
      assert(
        (await bubble
          .locator('[data-avatar-shape="goggles"]')
          .evaluate((e) => getComputedStyle(e).color)) === "rgb(139, 92, 246)",
        "bubble uses this bot's color"
      );
      await p.screenshot({ path: path.join(out, `composer-collapsed-${theme}.png`) });
      await bubble.hover();
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      assert(
        (await editor.innerText()) === "Draft written before opening the preview",
        "hovering preserves the existing draft"
      );
      assert(
        await editorNode.evaluate((e) => e.isConnected),
        "preview keeps the existing editor mounted"
      );
      await editor.fill("Draft edited from the preview");
      await p.mouse.move(20, 100);
      assert(
        (await bubble.getAttribute("aria-expanded")) === "true",
        "composer stays open while the editor has focus"
      );
      await p.screenshot({ path: path.join(out, `composer-expanded-${theme}.png`) });
      await p.getByRole("grid").focus();
      await p.waitForFunction(
        () => !document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      await bubble.focus();
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      assert(
        (await composer.locator("[inert]").count()) === 0,
        "keyboard focus expands the editor"
      );
      await p.keyboard.press("Enter");
      await p.waitForFunction((element) => document.activeElement === element, editorNode);
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
      assert(
        (await editor.innerText()) === "Draft edited from the preview",
        "Escape returns the edited draft to chat"
      );
      assert(
        await editorNode.evaluate((e) => e.isConnected),
        "closing does not remount the editor"
      );
      assert((await p.locator("[data-composer-dock]").count()) === 1, "there is only one composer");
      results.push({ theme, file: "Hover composer", escapeClosed: true });
      console.log("PASS", current);
    }
    current = "preview send";
    {
      await p.goto(`${url}?theme=dark&files&bot=Finance%20Guy&botColor=%231084fe&botIcon=goggles`);
      const consoleErrors = [];
      const onConsole = (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      };
      p.on("console", onConsole);
      const editor = p.getByRole("textbox", { name: "Message", exact: true });
      await editor.waitFor();
      await p
        .getByRole("button", {
          name: "Open bank-transactions-reconciled-v2-2026-11-10.csv",
          exact: true,
        })
        .click();
      await p.getByRole("grid").waitFor();
      const composer = p.locator("[data-preview-composer]");
      const bubble = p.getByRole("button", { name: "Message Finance Guy", exact: true });
      const composerState = () =>
        composer.evaluate((root) => ({
          expanded: root.hasAttribute("data-expanded"),
          flights: root.querySelectorAll(".attachment-composer-sent").length,
          blobs: root.querySelectorAll(".attachment-composer-goo-sent").length,
          text: root.querySelector("[contenteditable]")?.textContent ?? "",
        }));
      await p.evaluate(() => {
        window.previewSends = [];
        document.addEventListener(
          "openteam:prompt-sent",
          (event) => window.previewSends.push(event.detail.content),
          true
        );
      });
      current = "preview send: open composer";
      await bubble.hover();
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      await composer.locator("[contenteditable]").click();
      current = "preview send: one at a time";
      const expandedNow = () => composer.evaluate((root) => root.hasAttribute("data-expanded"));
      await p.keyboard.type("first ✨", { delay: 0 });
      await p.keyboard.press("Enter");
      // While the message is in the air nothing reopens the composer or sends again.
      await p.keyboard.type("ignored", { delay: 0 });
      await p.keyboard.press("Enter");
      const pillBox = await bubble.boundingBox();
      const pillCenter = [pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2];
      await p.mouse.move(pillCenter[0] + 4, pillCenter[1]);
      await p.mouse.move(pillCenter[0] - 4, pillCenter[1]);
      await bubble.click({ force: true });
      let state = await composerState();
      assert(!state.expanded && state.flights === 1, "composer stays folded while sending");
      assert(
        JSON.stringify(await p.evaluate(() => window.previewSends)) ===
          JSON.stringify(["first ✨"]),
        "only one message is sent at a time"
      );
      current = "preview send: landed";
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-delivered")
      );
      await p.waitForFunction(
        () => !document.querySelector(".attachment-composer-sent, .attachment-composer-goo-sent")
      );
      state = await composerState();
      assert(!state.expanded && state.blobs === 0 && state.text === "", "flight cleans up");
      current = "preview send: reopen";
      await p.mouse.move(pillCenter[0] + 6, pillCenter[1]);
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      await composer.locator("[contenteditable]").click();
      await p.keyboard.type("second", { delay: 0 });
      await p.keyboard.press("Enter");
      assert(
        JSON.stringify(await p.evaluate(() => window.previewSends)) ===
          JSON.stringify(["first ✨", "second"]),
        "hovering after Sent reopens for the next message"
      );
      assert(!(await expandedNow()), "the next send folds back again");
      await p.waitForFunction(
        () => !document.querySelector(".attachment-composer-sent, .attachment-composer-goo-sent")
      );
      await p.mouse.move(pillCenter[0] - 6, pillCenter[1]);
      await p.waitForFunction(() =>
        document.querySelector("[data-preview-composer]")?.hasAttribute("data-expanded")
      );
      current = "preview send: failure";
      await composer.locator("[contenteditable]").click();
      await p.keyboard.type("restored draft", { delay: 0 });
      await composer.evaluate((root) => {
        const surface = root.querySelector("[data-prompt-surface]");
        surface.dispatchEvent(
          new CustomEvent("openteam:prompt-sent", { bubbles: true, detail: {} })
        );
        surface.dispatchEvent(new CustomEvent("openteam:prompt-send-failed", { bubbles: true }));
      });
      state = await composerState();
      assert(
        state.expanded && state.flights === 0 && !(await composer.getAttribute("data-delivered")),
        "a failed send reopens the composer without a Sent confirmation"
      );
      await p.keyboard.press("Meta+A");
      await p.keyboard.type("closing mid flight", { delay: 0 });
      await p.keyboard.press("Enter");
      await p.keyboard.press("Escape");
      await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
      assert(
        (await p.locator(".attachment-composer-goo-sent").count()) === 0,
        "closing mid-flight leaves nothing behind"
      );
      p.off("console", onConsole);
      assert(!consoleErrors.length, consoleErrors.join("\n"));
      current = "preview send";
      results.push({ theme: "dark", file: "Preview send", sends: 3 });
      console.log("PASS", current);
    }
    current = "custom bot photo";
    await p.goto(`${url}?theme=light&files&bot=Photo%20Bot&botPhoto`);
    await p.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await p
      .getByRole("button", { name: "View conversation details", exact: true })
      .first()
      .locator("img")
      .waitFor();
    const avatar = await p
      .getByRole("button", { name: "View conversation details", exact: true })
      .first()
      .locator("img")
      .getAttribute("src");
    await p
      .getByRole("button", {
        name: "Open bank-transactions-reconciled-v2-2026-11-10.csv",
        exact: true,
      })
      .click();
    const photo = p.getByRole("button", { name: "Message Photo Bot", exact: true }).locator("img");
    await photo.waitFor();
    assert((await photo.getAttribute("src")) === avatar, "bubble shows the bot's uploaded photo");
    await p.keyboard.press("Escape");
    await p.locator("[data-attachment-stage]").waitFor({ state: "hidden" });
    results.push({ theme: "light", file: "Custom bot photo", escapeClosed: true });
    console.log("PASS", current);
    assert(!errors.length, errors.join("\n"));
    if (clips.length) {
      const list = path.join(out, "clips.txt");
      fs.writeFileSync(list, clips.map((file) => `file '${file}'`).join("\n"));
      const combined = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          path.join(out, "all-previews.mp4"),
        ],
        { encoding: "utf8" }
      );
      if (combined.status) throw Error(combined.stderr);
    }
    fs.writeFileSync(
      path.join(out, "preview-parity-results.json"),
      JSON.stringify({ results, errors }, null, 2)
    );
    return { checks: results.length, errors };
  } catch (error) {
    await p.screenshot({ path: path.join(out, "failure.png") });
    console.error("Failure in", current);
    throw error;
  } finally {
    await b.close();
  }
};
module.exports.recording = recording;
if (require.main === module)
  module
    .exports({
      port: Number(process.argv[2]),
      url: process.argv[3],
      out: process.argv[4],
      fixtureDirectory: process.env.OPENTEAM_PREVIEW_FIXTURE_DIR,
      record: process.env.OPENTEAM_PREVIEW_RECORD === "1",
    })
    .then(console.log)
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
