import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MessageResponse } from "../../src/renderer/components/ai-elements/message";
import "../../src/renderer/styles.css";

// The runner serves `openteam-favicon:` like the main process: fast.example at
// once, slow-*.example after a delay, and nothing for none.example. Each theme
// uses its own slow host: Chromium keeps loaded icons across page loads.
const source = (theme: string) => [
  "Here's one: [Wikipedia's random article page](https://fast.example/wiki/Special:Random). It opens a different article every time you click it.",
  "",
  `A [slow site](https://slow-${theme}.example/page) keeps its skeleton until the icon arrives, and [a site without an icon](https://none.example/) gets a globe. Two links to [the same site](https://fast.example/other) share one icon.`,
  "",
  "**[Bold link text](https://fast.example/bold)** and a [message link](openteam://settings) are unaffected.",
].join("\n");

const root = createRoot(document.getElementById("root")!);
const states = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".link-favicon")).map((icon) => ({
    host: new URL(icon.closest("a")!.href).hostname,
    state: icon.dataset.state,
    width: icon.getBoundingClientRect().width,
    height: icon.getBoundingClientRect().height,
  }));
const textBox = () => {
  const paragraph = document.querySelector(".bot-markdown p")!.getBoundingClientRect();
  return { width: paragraph.width, height: paragraph.height };
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 5_000) => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) return false;
    await wait(25);
  }
  return true;
};

Object.assign(window, {
  async renderLinks(theme: "light" | "dark") {
    document.documentElement.dataset.theme = theme;
    document.body.style.background = theme === "dark" ? "#080808" : "#fbfbfb";
    document.body.style.margin = "0";
    flushSync(() => root.render(null));
    flushSync(() =>
      root.render(
        <div style={{ width: 560, padding: "64px 24px 24px", fontSize: 14, lineHeight: "22px" }}>
          <MessageResponse>{source(theme)}</MessageResponse>
        </div>
      )
    );
    await until(() => document.querySelectorAll(".link-favicon").length > 0);
    await until(() => states().some((icon) => icon.host === "fast.example" && icon.state === "loaded"));
    return { states: states(), text: textBox() };
  },
  async settle() {
    const settled = await until(() => states().every((icon) => icon.state !== "loading"));
    return { settled, states: states(), text: textBox() };
  },
});
