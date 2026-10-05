import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageImageGallery,
  type DisplayImage,
} from "../../src/renderer/components/openteam/image-attachment";
import "../../src/renderer/styles.css";

const root = createRoot(document.getElementById("root")!);
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const pending = new Map<string, () => void>();
const reports: string[] = [];
let imageErrors = 0;
document.addEventListener(
  "error",
  (event) => {
    if (event.target instanceof HTMLImageElement) imageErrors++;
  },
  true
);

// Hold authenticated image downloads until after measuring the loading frame.
window.fetch = (input, init) =>
  new Promise((resolve, reject) => {
    const url = String(input);
    const release = () =>
      resolve(
        new Response(
          url.includes("broken")
            ? "invalid image"
            : '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="teal"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      );
    pending.set(url, release);
    init?.signal?.addEventListener(
      "abort",
      () => {
        if (pending.get(url) === release) pending.delete(url);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await pause();
  }
  throw new Error("Timed out waiting for image state");
};
const sample = () => {
  const frames = [
    ...document.querySelectorAll<HTMLButtonElement>("button[aria-label^='Open ']"),
  ].map((button) => {
    const bounds = button.parentElement!.getBoundingClientRect();
    return [bounds.x, bounds.y, bounds.width, bounds.height];
  });
  const text = document.querySelector("[data-following-message]")!.getBoundingClientRect();
  return [...frames.flat(), text.x, text.y, text.width, text.height];
};
const equalGeometry = (before: number[], after: number[], name: string) => {
  check(
    before.length === after.length && before.every((value, i) => Math.abs(value - after[i]!) < 0.1),
    `${name}: layout moved: ${JSON.stringify({ before, after })}`
  );
};
const render = (images: DisplayImage[], narrow: boolean, visit: number) =>
  root.render(
    <StrictMode>
      <div key={visit} style={{ width: narrow ? 180 : 600 }}>
        <div className="flex max-w-full flex-col items-end gap-1.5">
          <MessageImageGallery images={images} />
          <p data-following-message>Message below the attachment</p>
        </div>
      </div>
    </StrictMode>
  );

async function run() {
  const cases = [
    { name: "portrait", width: 400, height: 800, expected: [150, 300] },
    { name: "landscape", width: 1600, height: 900, expected: [320, 180] },
    { name: "small", width: 80, height: 60, expected: [80, 60] },
    { name: "legacy", expected: [320, 180] },
    { name: "invalid", width: 0, height: Infinity, expected: [320, 180] },
    { name: "broken", width: 400, height: 800, expected: [150, 300] },
  ];
  for (const narrow of [false, true]) {
    for (const scenario of cases) {
      const images: DisplayImage[] = [
        {
          url: `/api/v0/assets/${scenario.name}/content`,
          alt: scenario.name,
          width: scenario.width,
          height: scenario.height,
        },
      ];
      let initial: number[] | undefined;
      for (let visit = 0; visit < 2; visit++) {
        root.render(null);
        await pause();
        pending.clear();
        render(images, narrow, visit);
        await waitFor(() => pending.size === 1);
        check(!document.querySelector("img:not([src])"), "Loading must not show a broken image");
        const before = sample();
        if (!narrow) {
          check(
            Math.abs(before[2]! - scenario.expected[0]!) < 0.1 &&
              Math.abs(before[3]! - scenario.expected[1]!) < 0.1,
            `${scenario.name}: incorrect reserved dimensions ${before}`
          );
        } else {
          check(before[2]! <= 180, `${scenario.name}: exceeds narrow container`);
        }
        if (initial) equalGeometry(initial, before, `${scenario.name}: revisit`);
        initial = before;
        const errorsBefore = imageErrors;
        for (const release of pending.values()) release();
        await waitFor(() =>
          scenario.name === "broken"
            ? imageErrors > errorsBefore
            : document.querySelectorAll("img").length === 1 &&
              [...document.querySelectorAll("img")].every((img) => img.naturalWidth > 0)
        );
        await pause();
        equalGeometry(before, sample(), `${scenario.name}: image loaded`);
      }
      reports.push(
        `${scenario.name}, ${narrow ? "narrow" : "desktop"}: stable on load and revisit`
      );
    }
  }

  root.render(null);
  await pause();
  pending.clear();
  render(
    [1, 2].map((id) => ({ url: `/api/v0/assets/grid-${id}/content` })),
    false,
    0
  );
  await waitFor(() => pending.size === 2);
  const beforeGrid = sample();
  for (const release of pending.values()) release();
  await waitFor(() => document.querySelectorAll("img").length === 2 &&
    [...document.querySelectorAll("img")].every((img) => img.naturalWidth > 0));
  await pause();
  equalGeometry(beforeGrid, sample(), "gallery");
  reports.push("gallery: stable on load");
}

run()
  .then(() => console.log("IMAGE_LAYOUT_RESULT " + JSON.stringify({ reports })))
  .catch((error) =>
    console.log(
      "IMAGE_LAYOUT_RESULT " +
        JSON.stringify({
          reports,
          error: String(error),
          stack: error.stack,
        })
    )
  );
