import React from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import "../../src/renderer/styles.css";

const root = createRoot(document.getElementById("root")!);
const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
const setupLabel = "Set up transcription in Server settings to use voice notes";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function draw(theme: "light" | "dark", configured: boolean) {
  document.documentElement.dataset.theme = theme;
  root.render(
    <main style={{ width: 440, padding: 24 }}>
      <p style={{ marginBottom: 20 }}>
        {theme} — {configured ? "Voice ready" : "Transcription not configured"}
      </p>
      <PromptInput
        transcriptionConfigured={configured}
        onStage={async () => {
          throw Error("No attachments in this fixture");
        }}
        onSubmit={async () => {}}
      />
    </main>
  );
}
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const metrics = (node: HTMLElement) => {
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  return {
    width: box.width,
    height: box.height,
    radius: style.borderRadius,
    background: style.backgroundColor,
    color: style.color,
    shadow: style.boxShadow,
    opacity: style.opacity,
    iconWidth: node.querySelector("svg")!.getBoundingClientRect().width,
  };
};
if (new URLSearchParams(location.search).has("manual")) {
  draw(theme, !new URLSearchParams(location.search).has("disabled"));
} else {
  (async () => {
    const reports = [];
    for (const theme of ["light", "dark"] as const) {
      for (const configured of [false, true]) {
        draw(theme, configured);
        await wait();
        const mic = button(configured ? "Record voice note" : setupLabel);
        const empty = metrics(mic);
        const assert = (condition: boolean, message: string) => {
          if (!condition) throw Error(`${theme}/${configured}: ${message}`);
        };
        // Values from Grok Bot's secondary microphone control, not the Send action.
        assert(
          empty.width === 28 && empty.height === 28 && empty.iconWidth === 14,
          "Microphone geometry differs from reference"
        );
        assert(
          empty.background ===
            (theme === "dark" ? "rgba(119, 119, 119, 0.173)" : "rgba(119, 119, 119, 0.09)"),
          "Microphone has a primary or opaque background"
        );
        assert(
          empty.color ===
            (theme === "dark" ? "rgba(252, 252, 252, 0.56)" : "rgba(20, 20, 20, 0.61)"),
          `Microphone foreground differs from reference: ${empty.color}`
        );
        assert(
          empty.opacity === (configured ? "1" : "0.4") && mic.disabled === !configured,
          "Disabled appearance or setup guard changed"
        );
        const editor = document.querySelector<HTMLElement>(
          '[role="textbox"][aria-label="Message"]'
        )!;
        editor.focus();
        document.execCommand("insertText", false, "Draft");
        await wait();
        const draft = metrics(button(configured ? "Record voice note" : setupLabel));
        assert(
          ["background", "color", "shadow", "opacity", "iconWidth"].every(
            (key) => draft[key as keyof typeof draft] === empty[key as keyof typeof empty]
          ),
          "Typing changes microphone appearance"
        );
        assert(
          getComputedStyle(button("Send message")).backgroundColor ===
            (theme === "dark" ? "rgb(250, 250, 250)" : "rgb(7, 7, 7)"),
          "Send lost its primary theme color"
        );
        editor.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        await wait();
        assert(!button("Send message"), "Clearing a draft did not restore the microphone");
        reports.push({ theme, configured, empty, draft });
      }
    }
    Object.assign(window, { composerButtonResults: { reports } });
  })().catch((error) => Object.assign(window, { composerButtonResults: { error: error.message } }));
}
