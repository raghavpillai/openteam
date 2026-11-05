// Repeatable visual review: real composer, MediaStream and MediaRecorder; fixture audio/API.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/renderer/components/ai-elements/prompt-input";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const wait = async (predicate: () => unknown) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await pause(30);
  }
  throw Error("Voice motion fixture timed out");
};
const audioBytes = fetch("/test/browser/voice-motion.wav").then((r) => r.arrayBuffer());
Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
  configurable: true,
  value: async () => {
    const audio = new AudioContext();
    await audio.resume();
    const destination = audio.createMediaStreamDestination();
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = await audio.decodeAudioData((await audioBytes).slice(0));
    source.loop = true;
    source.connect(gain);
    gain.connect(destination);
    (window as any).setVoiceGain = (value: number) =>
      gain.gain.setTargetAtTime(value, audio.currentTime, 0.02);
    source.start();
    const track = destination.stream.getAudioTracks()[0]!;
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      source.stop();
      void audio.close();
    };
    return destination.stream;
  },
});
api.transcribeAudio = async (_audio, signal) => {
  await pause(5200);
  signal?.throwIfAborted();
  return {
    text: "Can you check the train times for tomorrow morning? I'd like to leave around nine.",
  };
};
function Demo() {
  const [sent, setSent] = useState<string[]>([]);
  const [step, setStep] = useState("Ready to record");
  Object.assign(window, { setVoiceStep: setStep, voiceSent: sent.length });
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        background: "#0a0a0a",
        color: "#eee",
        fontFamily: "system-ui",
      }}
    >
      <aside
        data-sidebar=""
        data-demo-sidebar
        style={{
          width: 220,
          flexShrink: 0,
          background: "#111",
          borderRight: "1px solid #292929",
          padding: "28px 20px",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 34 }}>OpenTeam</div>
        <div style={{ color: "#777", fontSize: 12, marginBottom: 12 }}>CHATS</div>
        <div style={{ background: "#242424", padding: "10px 12px", borderRadius: 9 }}>Research</div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header
          style={{
            padding: "24px 28px",
            borderBottom: "1px solid #222",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <strong>Research</strong>
          <span data-demo-step style={{ color: "#999", fontSize: 13 }}>
            {step}
          </span>
        </header>
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 18,
            padding: "28px",
          }}
        >
          <div
            style={{
              background: "#242424",
              borderRadius: 18,
              padding: "16px 20px",
              maxWidth: 590,
              fontSize: 16,
              lineHeight: 1.6,
            }}
          >
            Ready when you are. Send me a voice note and I’ll check the train times for tomorrow.
          </div>
          {sent.map((text, i) => (
            <div
              key={i}
              style={{
                alignSelf: "flex-end",
                background: "#292929",
                borderRadius: 18,
                padding: "16px 20px",
                maxWidth: 640,
                fontSize: 16,
              }}
            >
              {text}
            </div>
          ))}
        </main>
        <footer style={{ padding: "60px 16px 24px" }}>
          <PromptInput
            transcriptionConfigured
            placeholder="Ask Research"
            onStage={async () => {
              throw Error("Unexpected attachment");
            }}
            onSubmit={async (text) => setSent((s) => [...s, text])}
          />
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
Object.assign(window, {
  warmVoiceMotion: async () => {
    await wait(() => button("Record voice note"));
    button("Record voice note")!.click();
    await pause(900);
    button("Discard voice note")!.click();
    await pause(900);
  },
  runVoiceMotion: async () => {
    const step = (text: string) => (window as any).setVoiceStep(text);
    await pause(600);
    step("Recording · horizontal voice motion");
    button("Record voice note")!.click();
    await pause(5700);
    step("Delete · liquid return");
    button("Discard voice note")!.click();
    await pause(1500);
    step("Recording · send with Enter");
    button("Record voice note")!.click();
    await pause(4400);
    step("Enter · gather into transcription sweep");
    document
      .querySelector<HTMLElement>("[contenteditable]")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    await wait(() => button("Cancel voice note"));
    // A second Enter confirms send while transcription is pending.
    document
      .querySelector<HTMLElement>("[contenteditable]")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    await wait(() => (window as any).voiceSent === 1);
    await pause(1400);
    step("Sent · composer restored");
    await pause(800);
    return { sent: 1, discarded: 1, syntheticAudio: true, realComposer: true };
  },
  verifyVoiceMotion: async (theme: string, reduced: boolean) => {
    const assert = (value: unknown, message: string) => {
      if (!value) throw Error(message);
    };
    document.documentElement.dataset.theme = theme;
    button("Record voice note")!.click();
    await wait(() => document.querySelector('[data-voice-memo="recording"]:not([data-exiting])'));
    await pause(900);
    const glow = document.querySelector<HTMLCanvasElement>("[data-voice-glow]")!;
    const canvas = glow.getBoundingClientRect();
    const bar = document.querySelector(".vm-bar")!.getBoundingClientRect();
    const sidebar = document.querySelector("[data-demo-sidebar]")!.getBoundingClientRect();
    assert(canvas.left >= sidebar.right, "Glow overlaps the sidebar");
    assert(
      Math.abs(canvas.left + 12 - bar.left) < 0.5 && Math.abs(canvas.right - 12 - bar.right) < 0.5,
      "Glow exceeds the bounded cap gutter"
    );
    const pixels = glow.getContext("2d")!.getImageData(0, 0, glow.width, glow.height);
    for (let y = 0; y < pixels.height; y++) {
      assert(
        pixels.data[y * pixels.width * 4 + 3] < 8 &&
          pixels.data[(y * pixels.width + pixels.width - 1) * 4 + 3] < 8,
        "Glow has an abrupt bright edge"
      );
    }
    const ratio = glow.width / canvas.width;
    const paddingY = bar.top - canvas.top;
    const capAlpha = glow
      .getContext("2d")!
      .getImageData(Math.floor(9 * ratio), Math.floor((paddingY + 22) * ratio), 1, 1).data[3];
    assert(capAlpha > 12, `Left cap has no base glow: ${capAlpha}`);
    let voiceMotion: { quiet: number; voiced: number } | undefined;
    if (theme === "dark" && innerWidth === 1440 && !reduced) {
      const extent = () => {
        const image = glow.getContext("2d")!.getImageData(0, 0, glow.width, glow.height);
        let top = paddingY;
        for (let x = canvas.width * 0.35; x < canvas.width * 0.65; x += 12) {
          for (let y = 0; y < paddingY; y++) {
            if (
              image.data[(Math.floor(y * ratio) * image.width + Math.floor(x * ratio)) * 4 + 3] > 24
            ) {
              top = Math.min(top, y);
              break;
            }
          }
        }
        return paddingY - top;
      };
      (window as any).setVoiceGain(0);
      await pause(1200);
      const quiet = extent();
      (window as any).setVoiceGain(1);
      let voiced = quiet;
      for (let i = 0; i < 16; i++) {
        await pause(80);
        voiced = Math.max(voiced, extent());
      }
      assert(voiced >= quiet + 50, `Central crest is too small: ${quiet} → ${voiced}`);
      voiceMotion = { quiet, voiced };
    }
    const checkBottom = () => {
      const rect = glow.getBoundingClientRect();
      const barRect = document.querySelector(".vm-bar")!.getBoundingClientRect();
      const bottom = barRect.bottom - rect.top;
      const budget = Math.max(0, Math.min(24, innerHeight - barRect.bottom - 2));
      const data = glow.getContext("2d")!.getImageData(0, 0, glow.width, glow.height);
      let extent = 0;
      for (let y = Math.ceil(bottom * ratio); y < data.height; y++) {
        for (let x = 0; x < data.width; x++) {
          if (data.data[(y * data.width + x) * 4 + 3] > 0)
            extent = Math.max(extent, (y + 1) / ratio - bottom);
        }
      }
      assert(extent <= budget + 1, `Glow exceeds lower budget: ${extent} > ${budget}`);
      let edgeAlpha = 0;
      for (let x = 0; x < data.width; x++)
        edgeAlpha = Math.max(edgeAlpha, data.data[((data.height - 1) * data.width + x) * 4 + 3]);
      assert(edgeAlpha === 0, `Lower glow is chopped at the canvas edge: ${edgeAlpha}`);
      return { extent, budget };
    };
    const lowerGlow = checkBottom();
    let nearWindowEdge: ReturnType<typeof checkBottom> | undefined;
    if (theme === "dark" && innerWidth === 1440 && !reduced) {
      const layer = document.querySelector<HTMLElement>(".vm-root")!;
      layer.style.transform = `translateY(${Math.max(0, innerHeight - bar.bottom - 4)}px)`;
      dispatchEvent(new Event("resize"));
      await pause(100);
      nearWindowEdge = checkBottom();
      layer.style.transform = "";
      dispatchEvent(new Event("resize"));
      await pause(100);
    }
    const send = button("Send voice note")!;
    const hit = send.getBoundingClientRect();
    const surface = document.querySelector(".vm-bar");
    send.click();
    await wait(() => button("Cancel voice note"));
    await pause(550);
    assert(
      send === button("Cancel voice note") && surface === document.querySelector(".vm-bar"),
      "Transcription remounted controls"
    );
    assert(Math.abs(send.getBoundingClientRect().x - hit.x) < 0.5, "Send/cancel target moved");
    assert(
      Boolean(document.querySelector(".vm-chip-orb canvas")),
      "Transcription orb failed to render"
    );
    assert(
      matchMedia("(prefers-reduced-motion: reduce)").matches === reduced,
      "Unexpected motion preference"
    );
    if (reduced)
      assert(
        parseFloat(getComputedStyle(document.querySelector(".vm-goo-pill")!).animationDuration) <
          0.002,
        "Goo ignores reduced motion"
      );
    button("Cancel voice note")!.click();
    await pause(120);
    assert(Boolean(document.querySelector("[data-exiting]")), "Liquid return unmounted early");
    await pause(650);
    assert(!document.querySelector("[data-voice-memo]"), "Liquid return did not finish");
    return {
      theme,
      reduced,
      width: innerWidth,
      bounded: true,
      feathered: true,
      capAlpha,
      voiceMotion,
      lowerGlow,
      nearWindowEdge,
      stableHitTarget: true,
      orb: true,
      exit: true,
    };
  },
});
