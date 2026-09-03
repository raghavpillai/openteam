import { BotAvatar } from "./bot-avatar";
import { MousePointer2 } from "lucide-react";

/** A bot's live Linux screen, as the desktop app shows it, with you in control. */
export function ScreenViewer() {
  return (
    <div
      role="img"
      aria-label="A bot's live Linux screen with a sign-in form open in Chrome and the viewer in control"
      className="overflow-hidden rounded-[14px] bg-surface shadow-window"
    >
      <div className="flex h-11 items-center gap-2.5 border-b border-line bg-raised px-3.5">
        <BotAvatar shape="circle" color="#ff7a1a" size={22} />
        <span className="text-[13px] font-medium text-ink">Research&apos;s screen</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-live-soft px-2 py-0.5 text-[10.5px] font-medium text-[#0b7a4b]">
          <span className="live-pulse inline-block h-[5px] w-[5px] rounded-full bg-live" /> Live
        </span>
        <span className="ml-auto inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-[11.5px] font-medium text-paper">
          Hand back
        </span>
      </div>

      <div className="relative aspect-square overflow-hidden bg-[#2b2f36] sm:aspect-[16/10]">
        {/* desktop panel */}
        <div className="flex h-7 items-center gap-3 bg-[#1b1e24] px-3 text-[10.5px] text-white/70">
          <span className="font-medium text-white/90">Chrome</span>
          <span>Terminal</span>
          <span>Files</span>
          <span className="ml-auto font-mono text-white/50">9:42</span>
        </div>

        {/* Chrome window */}
        <div className="absolute top-[13%] left-[4%] h-[80%] w-[92%] overflow-hidden rounded-md bg-white shadow-[0_18px_40px_rgba(0,0,0,.4)] sm:left-[5%] sm:w-[72%]">
          <div className="flex h-8 items-center gap-2 border-b border-line bg-raised px-2.5">
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="ml-1 flex h-5 flex-1 items-center rounded-md bg-surface px-2 font-mono text-[9.5px] text-ink-3 ring-1 ring-line">
              northwind.example/account/renewals
            </span>
          </div>
          <div className="flex h-full flex-col items-center px-6 pt-6 sm:pt-8">
            <div className="w-[78%] max-w-[260px] rounded-lg border border-line bg-surface p-3 shadow-card sm:w-[62%] sm:p-4">
              <div className="text-[13px] font-medium text-ink">Sign in to Northwind</div>
              <div className="mt-3 h-8 rounded-md border border-line bg-raised px-2.5 text-[10.5px] leading-8 text-ink-2">
                you@company.com
              </div>
              <div className="mt-2 flex h-8 items-center rounded-md border border-ink bg-surface px-2.5 font-mono text-[11px] tracking-[0.2em] text-ink">
                ••••••••<span className="blink font-sans tracking-normal">▍</span>
              </div>
              <div className="mt-3 h-8 rounded-md bg-ink text-center text-[11px] font-medium leading-8 text-paper">
                Sign in
              </div>
            </div>
            <MousePointer2
              size={18}
              className="absolute top-[63%] left-[52%] text-ink drop-shadow-[0_2px_3px_rgba(0,0,0,.35)]"
              fill="#ffffff"
            />
          </div>
        </div>

        {/* terminal peeking behind */}
        <div className="absolute top-[30%] right-[4%] hidden h-[56%] w-[30%] overflow-hidden rounded-md bg-[#0f1115] shadow-[0_18px_40px_rgba(0,0,0,.45)] sm:block">
          <div className="h-6 bg-[#1b1e24]" />
          <div className="space-y-2 p-3 font-mono text-[9px] leading-none text-[#9ad7b4]">
            <div>$ ls quotes/</div>
            <div className="text-white/60">acme-quote.pdf</div>
            <div className="text-white/60">globex-quote.pdf</div>
            <div className="text-white/60">northwind-quote.pdf</div>
            <div>
              $ <span className="blink">▍</span>
            </div>
          </div>
        </div>

        {/* control pill */}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[#141414]/85 px-3 py-1.5 text-[10px] whitespace-nowrap text-white/90 backdrop-blur sm:text-[11px]">
          <span className="inline-block h-[6px] w-[6px] rounded-full bg-attention" />
          You have control · the bot is paused
        </div>
      </div>
    </div>
  );
}
