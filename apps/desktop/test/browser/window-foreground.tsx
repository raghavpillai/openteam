import { useEffect } from "react";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import { ROBOT_AVATAR_SHAPES } from "@openteam/contracts/robot-avatar";
import { createRoot } from "react-dom/client";
import { ChatPane } from "../../src/renderer/components/openteam/chat-pane";
import { BotAvatarGlyph } from "../../src/renderer/components/openteam/avatar-picker-icons";
import VoiceMemoLayer from "../../src/renderer/components/openteam/voice-memo/voice-memo-layer";
import { LoadingOrb, preloadLoadingOrb } from "../../src/renderer/components/ui/loading-orb";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip";
import { installWindowVisibility } from "../../src/renderer/lib/window-visibility";
import { api } from "../../src/renderer/client/openteam-api";
import "../../src/renderer/styles.css";

// Both arms use the same fixture and deterministic animation clock. These
// overrides are fixture-only; browser layout, CSS, canvas painters and components
// are the real baseline/candidate implementations.
const originalFrame = requestAnimationFrame.bind(window);
Object.defineProperty(performance, "now", { configurable: true, value: () => 1200 });
window.requestAnimationFrame = callback => originalFrame(() => callback(1200));
api.pluginComposer = async () => ({ items: [] }) as never;
window.fetch = async () => { throw Error("Foreground fixture has no server"); };
document.documentElement.style.colorScheme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.dataset.theme = document.documentElement.style.colorScheme;
document.documentElement.classList.toggle("dark", document.documentElement.dataset.theme === "dark");
const style = document.createElement("style");
style.textContent = "*{caret-color:transparent!important}body{margin:0} [data-foreground-fixture]{height:780px;overflow:hidden} [data-fixture-avatars]{display:flex;gap:20px;padding:24px} [data-fixture-chat]{height:650px;display:flex;flex-direction:column} [data-fixture-voice]{position:relative;width:440px;height:80px;margin:350px auto 0}";
document.head.append(style);
installWindowVisibility();
await preloadLoadingOrb();
const bot = { id: "fixture-bot", name: "Research", icon: "helmet", color: "orange", status: "active", onboardingStatus: "completed" } as any;
const channel = { id: "fixture-chat", kind: "bot_dm", name: "Research", members: [{ botId: bot.id, ordinal: 0 }], createdAt: "2026-11-05T10:00:00Z", unreadCount: 0 } as any;
const run = { id: "fixture-run", channelId: channel.id, botId: bot.id, status: "running", createdAt: channel.createdAt } as any;
const messages = Array.from({ length: 16 }, (_, index) => ({
  id: `fixture-message-${index}`, sequence: String(index + 1), channelId: channel.id,
  sender: index % 2 ? "agent" : "user", senderBotId: index % 2 ? bot.id : undefined,
  content: index % 2 ? "The **foreground layout** stays the same. Here is the next step with `inline code`." : `Check the desktop behavior, step ${index + 1}.`,
  metadata: {}, createdAt: channel.createdAt,
})) as any[];
const botById = new Map([[bot.id, bot]]);
const names = new Map([[bot.id, bot.name]]);
const items = new Map([[run.id, [{ id: "fixture-tool", runId: run.id, kind: "tool", status: "running", title: null, content: { tool: "WebSearch" }, createdAt: channel.createdAt, updatedAt: channel.createdAt }]]]) as any;
const root = createRoot(document.getElementById("root")!);
let scenario = "chat-idle";
let ready = "";
function Fixture() {
  useEffect(() => { ready = scenario; });
  return <TooltipProvider><main data-foreground-fixture={scenario}>
    <div data-fixture-avatars>
      {ROBOT_AVATAR_SHAPES.slice(0, 3).map((shape, index) => <BotAvatarGlyph key={index} shape={shape} mode={scenario === "chat-active" ? "thinking" : "idle"} width={48} height={48} />)}
      <LoadingOrb size={32} label="Foreground loading" />
    </div>
    {scenario.startsWith("chat") ? <div data-fixture-chat><ChatPane channel={channel} selectedBot={bot} botById={botById} agentNameById={names}
      capabilities={CLIENT_CAPABILITIES}
      messages={messages} runs={scenario === "chat-active" ? [run] : []} activeRun={scenario === "chat-active" ? run : undefined}
      subagents={[]} itemsByRun={items} runtime={{ server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready" } as any}
      mutate={async operation => operation()} focusMessage={null} /></div>
      : <div data-fixture-voice><VoiceMemoLayer mode={scenario === "voice-recording" ? "recording" : "processing"} stream={null}
        elapsedMs={3200} radius={24} anchor={{ right: 20, bottom: 20 }} onDiscard={() => {}} onSend={() => {}} onCancelProcessing={() => {}} /></div>}
  </main></TooltipProvider>;
}
const render = () => root.render(<Fixture />);
render();
Object.assign(window, {
  foregroundFixture: {
    ready: () => scenario.startsWith("chat") && !document.querySelector('[data-chat-layout-ready="true"]') ? "" : ready,
    render: (next: string) => { scenario = next; ready = ""; render(); },
    settle: async () => {
      await document.fonts.ready;
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations !== Infinity) { try { animation.finish(); } catch {} }
      }
      // A finished avatar bridge resumes its CSS loops in onfinish. Let those
      // callbacks run before pinning every infinite loop to the same pose.
      await new Promise(resolve => originalFrame(() => originalFrame(resolve)));
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations === Infinity) { animation.pause(); animation.currentTime = 1200; }
      }
    },
    draft: () => {
      const editor = document.querySelector<HTMLElement>('[role="textbox"]');
      if (!editor) throw Error("Composer missing");
      editor.focus();
      document.execCommand("insertText", false, "Unsent foreground draft");
    },
    state: () => ({
      text: document.querySelector('[role="textbox"]')?.textContent,
      editorFocused: document.activeElement?.getAttribute("role") === "textbox",
      selection: [document.getSelection()?.anchorOffset, document.getSelection()?.focusOffset],
      nodes: document.querySelectorAll("*").length,
      inactive: document.documentElement.hasAttribute("data-window-inactive"),
      canvases: [...document.querySelectorAll("canvas")].filter(canvas => {
        if (!canvas.getBoundingClientRect().width) return false;
        for (let element: Element | null = canvas; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        }
        return true;
      }).map(canvas => canvas.toDataURL()),
      rects: [...document.querySelectorAll('[role="textbox"], [data-fixture-avatars], [data-fixture-voice], [data-fixture-chat]')].map(element => {
        const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      }),
    }),
  },
});
