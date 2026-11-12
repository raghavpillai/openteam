const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
app.setPath("userData", process.env.ASSET_SHARING_PROFILE);
app.whenReady().then(async () => {
  const baseline = process.env.ASSET_SHARING_BASELINE === "1";
  const reports = [];
  const ux = {};
  const win = new BrowserWindow({
    show: false,
    width: 600,
    height: 400,
    webPreferences: { backgroundThrottling: false },
  });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const read = () => evaluate("window.assetResourceProbe?.()");
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  const waitFor = async (condition) => {
    for (let i = 0; i < 300; i++) {
      const probe = await read();
      if (probe && condition(probe)) return probe;
      await pause();
    }
    throw Error("Timed out: " + JSON.stringify(await read()));
  };
  const check = (condition, message) => {
    if (!condition) throw Error(message);
    reports.push(message);
  };
  const render = (sources, keys) =>
    evaluate(`window.renderAssetResources(${JSON.stringify(sources)}, ${JSON.stringify(keys)})`);
  const ready = (count) =>
    waitFor(
      (probe) =>
        probe.images.length === count && probe.images.every((image) => image.width === 1024)
    );
  const hash = (url) =>
    evaluate(
      `fetch(${JSON.stringify(url)}).then(r => r.arrayBuffer()).then(b => crypto.subtle.digest('SHA-256', b)).then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join(''))`
    );
  const readable = (url) => evaluate(`fetch(${JSON.stringify(url)}).then(r => r.ok, () => false)`);
  const pixels = () =>
    evaluate(
      `(() => { const c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');return [...document.images].map(i=>{x.clearRect(0,0,1,1);x.drawImage(i,0,0,1,1);return [...x.getImageData(0,0,1,1).data]});})()`
    );
  const download = (url, name) =>
    new Promise((resolve, reject) => {
      const session = win.webContents.session;
      const destination = path.join(path.dirname(process.env.ASSET_SHARING_RESULT), name);
      const timeout = setTimeout(() => finish(Error("Download did not complete")), 8000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        session.removeListener("will-download", onDownload);
        error ? reject(error) : resolve(value);
      };
      const onDownload = (_event, item, contents) => {
        if (contents !== win.webContents || item.getURL() !== url) return;
        const suggested = item.getFilename();
        item.setSavePath(destination);
        item.once("done", (_event, state) => {
          if (state !== "completed") {
            finish(Error("Download " + state));
            return;
          }
          finish(null, {
            suggested,
            name: path.basename(destination),
            hash: crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex"),
          });
        });
      };
      session.on("will-download", onDownload);
      win.webContents.downloadURL(url);
    });
  try {
    await win.loadURL(process.env.ASSET_SHARING_URL);
    await waitFor(() => true);
    const id = "a".repeat(64);
    const first = `/api/assets/${id}?name=first.svg`;
    const second = `/api/v0/assets/${id}?name=renamed.svg&download=1`;
    await render([first, second]);
    let probe = await ready(2);
    const shared = probe.images[0].source;
    const initial = probe;
    check(
      probe.requests === (baseline ? 2 : 1),
      "isolated alias request count matches the selected implementation"
    );
    check(
      probe.blobCount === (baseline ? 2 : 1),
      "isolated alias blob count matches the selected implementation"
    );
    check(
      (probe.images[0].source === probe.images[1].source) === !baseline,
      "alias URL ownership matches the selected implementation"
    );
    check(
      (await hash(shared)) === process.env.ASSET_SHARING_HASH,
      "both aliases retain byte-exact original content"
    );
    check(
      (await hash(probe.images[1].source)) === process.env.ASSET_SHARING_HASH,
      "download-name aliases preserve original bytes and MIME"
    );
    check(
      (await evaluate(
        `fetch(${JSON.stringify(shared)}).then(r => r.headers.get('content-type'))`
      )) === "image/svg+xml",
      "shared blobs preserve the original response MIME type"
    );
    check(
      probe.images.every((image) => image.height === 768),
      "both images decode at full original resolution"
    );
    const initialPixels = await evaluate(
      `(() => { const c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');return [...document.images].map(i=>{x.drawImage(i,0,0,1,1);return [...x.getImageData(0,0,1,1).data]});})()`
    );
    check(
      JSON.stringify(initialPixels[0]) === JSON.stringify(initialPixels[1]) &&
        initialPixels[0][3] === 255,
      "shared image pixels match the independently decoded alias"
    );
    await render([second]);
    probe = await ready(1);
    check(
      await readable(probe.images[0].source),
      "removing one alias leaves the other displayed image readable"
    );
    check(
      (await hash(shared)) === process.env.ASSET_SHARING_HASH,
      "a captured save source remains readable during an ordinary alias transition"
    );
    await render([]);
    await render([first, second]);
    probe = await ready(2);
    check(
      probe.requests === initial.requests,
      "quick remount reuses warm resources without another application fetch"
    );
    const before = probe.images.map((image) => image.source);
    await evaluate("window.invalidateAssetCredentials()");
    probe = await waitFor(
      (probe) =>
        probe.images.length === 2 &&
        probe.images.every((image) => image.width === 1024 && !before.includes(image.source))
    );
    check(
      probe.requests === initial.requests * 2,
      "credential generation creates fresh resources for both aliases"
    );
    check(
      !(await readable(before[0])),
      "credential invalidation releases the prior alias URL after DOM replacement"
    );
    const requestCount = probe.requests;
    await render([`${first}&preview=640`, `${first}&preview=1280`]);
    probe = await ready(2);
    check(
      probe.requests === requestCount + 2 && probe.images[0].source !== probe.images[1].source,
      "different rendition parameters keep distinct resources"
    );

    const httpDownload = await download(
      new URL(second, process.env.ASSET_SHARING_URL).href,
      "original-renamed.svg"
    );
    check(
      httpDownload.suggested === "renamed.svg" &&
        httpDownload.hash === process.env.ASSET_SHARING_HASH,
      "real Electron HTTP download preserves the original URL filename and bytes"
    );
    const blobDownload = await download(probe.images[0].source, "user-selected résumé.svg");
    check(
      blobDownload.name === "user-selected résumé.svg" &&
        blobDownload.hash === process.env.ASSET_SHARING_HASH,
      "real Electron blob Save path preserves the user-selected filename and original bytes"
    );

    await render([`${first}&case=transition`]);
    await ready(1);
    await evaluate("window.holdAssetRequests(true)");
    ux.aliasTransitionFrames = await evaluate(
      `window.transitionAssetFrames(${JSON.stringify([`${second}&case=transition`])})`
    );
    const missingTransitionFrames = ux.aliasTransitionFrames.filter((frame) =>
      frame.some((image) => !image.source || image.width !== 1024)
    ).length;
    check(
      baseline ? missingTransitionFrames > 0 : missingTransitionFrames === 0,
      "an alias-only change reuses warm image pixels without a blank animation frame in the candidate"
    );
    await evaluate("window.holdAssetRequests(false); window.releaseAssetRequests()");
    await ready(1);

    await render([
      "/api/v0/bots/fixture/avatar?revision=1",
      "/api/v0/bots/fixture/avatar?revision=2",
    ]);
    probe = await ready(2);
    const mutablePixels = await pixels();
    check(
      probe.images[0].source !== probe.images[1].source &&
        JSON.stringify(mutablePixels[0]) !== JSON.stringify(mutablePixels[1]),
      "mutable resource revisions remain isolated and display their own pixels"
    );

    await evaluate("window.holdAssetRequests(true)");
    const pendingStart = (await read()).requests;
    await render(
      [`${first}&case=pending`, `${second}&case=pending`],
      ["pending-first", "pending-second"]
    );
    probe = await waitFor((probe) => probe.requests >= pendingStart + (baseline ? 2 : 1));
    await render([`${second}&case=pending`], ["pending-second"]);
    await evaluate("window.holdAssetRequests(false); window.releaseAssetRequests()");
    probe = await ready(1);
    check(
      (await hash(probe.images[0].source)) === process.env.ASSET_SHARING_HASH,
      "removing the first pending alias does not cancel the remaining consumer's load"
    );
    check(
      probe.requests === pendingStart + (baseline ? 2 : 1),
      "the surviving pending consumer finishes without a replacement request"
    );

    await evaluate("window.holdAssetRequests(true)");
    const abandonedStart = (await read()).requests;
    await render([`${first}&case=abandoned`, `${second}&case=abandoned`]);
    probe = await waitFor((probe) => probe.requests >= abandonedStart + (baseline ? 2 : 1));
    const createdBeforeAbandon = probe.created;
    await render([]);
    probe = await waitFor((probe) =>
      probe.requestDetails.filter((r) => r.url.includes("case=abandoned")).every((r) => r.aborted)
    );
    await evaluate("window.holdAssetRequests(false); window.releaseAssetRequests()");
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      (await read()).created === createdBeforeAbandon,
      "releasing all pending aliases aborts the load without allocating a late blob"
    );
    await render([`${second}&case=abandoned`]);
    probe = await ready(1);
    check(
      (await hash(probe.images[0].source)) === process.env.ASSET_SHARING_HASH,
      "an abandoned alias can be retried without stale cancellation evicting its replacement"
    );

    await evaluate("window.failAssetRequests(1)");
    const failureStart = (await read()).resourceFailures.length;
    await render([`${first}&case=retry`]);
    await waitFor((probe) => probe.resourceFailures.length === failureStart + 1);
    await render([]);
    await render([`${second}&case=retry`]);
    probe = await ready(1);
    check(
      (await hash(probe.images[0].source)) === process.env.ASSET_SHARING_HASH,
      "a failed alias request is retriable through another alias with original content intact"
    );

    await evaluate("window.holdAssetRequests(true)");
    const raceStart = (await read()).requests;
    await render([`${first}&case=credential-race`, `${second}&case=credential-race`]);
    probe = await waitFor((probe) => probe.requests >= raceStart + (baseline ? 2 : 1));
    const oldGeneration = probe.generation;
    await evaluate("window.invalidateAssetCredentials()");
    probe = await waitFor((probe) =>
      probe.requestDetails.some(
        (r) => r.url.includes("case=credential-race") && r.generation !== oldGeneration
      )
    );
    check(
      probe.requestDetails
        .filter((r) => r.url.includes("case=credential-race") && r.generation === oldGeneration)
        .every((r) => r.aborted),
      "credential invalidation aborts every old-generation pending alias"
    );
    const createdAtRace = probe.created;
    await evaluate("window.holdAssetRequests(false); window.releaseAssetRequests()");
    probe = await ready(2);
    check(
      probe.created === createdAtRace + (baseline ? 2 : 1) &&
        (await hash(probe.images[0].source)) === process.env.ASSET_SHARING_HASH,
      "only fresh-generation aliases publish blobs after a slow credential race"
    );
    check(probe.errors.length === 0, "resource interactions finish without renderer errors");
    await evaluate("window.unmountAssetResources()");
    fs.writeFileSync(
      process.env.ASSET_SHARING_RESULT,
      JSON.stringify({ baseline, initial, reports, ux }, null, 2)
    );
  } catch (error) {
    fs.writeFileSync(
      process.env.ASSET_SHARING_RESULT,
      JSON.stringify({ baseline, reports, ux, error: String(error) }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
