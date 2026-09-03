import { BotAvatar } from "./bot-avatar";
import { Check, Mic, Monitor, Plus, Search } from "./icons";

/**
 * A rendered view of the desktop app: sidebar, one bot's chat, and the
 * inspector with the bot's live screen. Built with the app's own layout and
 * palette so it reads as the product, not an illustration.
 */

function StatusDot({
  tone,
  pulse = false,
  size = 6,
}: {
  tone: "live" | "attention" | "idle";
  pulse?: boolean;
  size?: number;
}) {
  const color =
    tone === "live" ? "bg-live" : tone === "attention" ? "bg-attention" : "bg-ink-3/50";
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${color} ${pulse ? "live-pulse" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

function SidebarRow({
  shape,
  color,
  name,
  status,
  tone,
  preview,
  time,
  active = false,
}: {
  shape: "circle" | "drop" | "cloud" | "square" | "hexagon" | "blob";
  color: string;
  name: string;
  status?: string;
  tone: "live" | "attention" | "idle";
  preview: string;
  time: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-2 py-2 ${active ? "bg-sunken" : ""}`}
    >
      <BotAvatar shape={shape} color={color} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium text-ink">{name}</span>
          <span className="shrink-0 font-mono text-[10px] text-ink-3">{time}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-2">
          {status ? (
            <>
              <StatusDot tone={tone} pulse={tone === "live"} size={5} />
              <span
                className={`whitespace-nowrap ${
                  tone === "live"
                    ? "text-[#0b7a4b]"
                    : tone === "attention"
                      ? "text-attention"
                      : "text-ink-3"
                }`}
              >
                {status}
              </span>
              <span className="text-ink-3">·</span>
            </>
          ) : null}
          <span className="truncate">{preview}</span>
        </div>
      </div>
    </div>
  );
}

function MiniScreen() {
  return (
    <div className="relative aspect-[16/10] overflow-hidden rounded-md border border-line bg-[#2b2f36]">
      {/* desktop panel */}
      <div className="flex h-[9%] items-center gap-1 bg-[#1b1e24] px-1.5">
        <span className="h-1 w-1 rounded-full bg-white/50" />
        <span className="h-1 w-6 rounded-sm bg-white/25" />
        <span className="ml-auto h-1 w-3 rounded-sm bg-white/25" />
      </div>
      {/* browser window */}
      <div className="absolute top-[16%] left-[6%] h-[70%] w-[66%] overflow-hidden rounded-[3px] bg-white shadow-[0_4px_12px_rgba(0,0,0,.35)]">
        <div className="flex h-[16%] items-center gap-1 border-b border-[#e6e6e4] bg-[#f4f4f3] px-1">
          <span className="h-[3px] w-[3px] rounded-full bg-[#d3d3d0]" />
          <span className="h-[3px] w-[3px] rounded-full bg-[#d3d3d0]" />
          <span className="ml-1 h-[45%] flex-1 rounded-[2px] bg-white ring-1 ring-[#e6e6e4]" />
        </div>
        <div className="space-y-[5%] p-[7%]">
          <div className="h-[6px] w-[45%] rounded-sm bg-[#141414]/80" />
          <div className="h-[3px] w-[90%] rounded-sm bg-[#141414]/15" />
          <div className="h-[3px] w-[70%] rounded-sm bg-[#141414]/15" />
          <div className="mt-[8%] grid grid-cols-3 gap-[4%]">
            <div className="h-[14px] rounded-[2px] bg-bot-orange/25" />
            <div className="h-[14px] rounded-[2px] bg-[#141414]/8" />
            <div className="h-[14px] rounded-[2px] bg-[#141414]/8" />
          </div>
        </div>
      </div>
      {/* terminal window */}
      <div className="absolute top-[40%] right-[5%] h-[50%] w-[42%] overflow-hidden rounded-[3px] bg-[#0f1115] shadow-[0_4px_12px_rgba(0,0,0,.4)]">
        <div className="h-[16%] bg-[#1b1e24]" />
        <div className="space-y-[6%] p-[8%] font-mono text-[4px] leading-none text-[#9ad7b4]">
          <div className="h-[3px] w-[70%] rounded-sm bg-[#9ad7b4]/70" />
          <div className="h-[3px] w-[40%] rounded-sm bg-white/30" />
          <div className="h-[3px] w-[55%] rounded-sm bg-white/30" />
          <div className="h-[3px] w-[20%] rounded-sm bg-[#9ad7b4]/70" />
        </div>
      </div>
    </div>
  );
}

export function AppWindow() {
  return (
    <div
      className="w-full overflow-hidden rounded-[14px] bg-surface text-left shadow-window"
      aria-label="The OpenBot desktop app showing a bot at work"
      role="img"
    >
      {/* title bar */}
      <div className="flex h-10 items-center border-b border-line bg-raised px-3.5">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 text-center text-[12px] font-medium text-ink-2">OpenBot</div>
        <div className="w-[38px]" />
      </div>

      <div className="grid h-[640px] grid-cols-1 sm:h-[600px] sm:grid-cols-[236px_minmax(0,1fr)] lg:grid-cols-[236px_minmax(0,1fr)_268px]">
        {/* sidebar */}
        <aside className="hidden flex-col border-r border-line bg-raised sm:flex">
          <div className="p-2.5">
            <div className="flex h-8 items-center gap-2 rounded-lg bg-sunken/70 px-2.5 text-[12px] text-ink-3">
              <Search size={13} />
              Search
              <kbd className="ml-auto rounded-[4px] border border-line-strong bg-surface px-1 font-mono text-[10px] text-ink-3">
                ⌘K
              </kbd>
            </div>
          </div>
          <div className="px-2.5">
            <div className="microlabel px-2 pb-1.5">Bots</div>
            <SidebarRow
              shape="circle"
              color="#ff7a1a"
              name="Research"
              status="Working"
              tone="live"
              preview="Writing recommendation.md"
              time="now"
              active
            />
            <SidebarRow
              shape="drop"
              color="#925df2"
              name="Ops"
              status="Needs you"
              tone="attention"
              preview="Approve the DNS change?"
              time="9:41"
            />
            <SidebarRow
              shape="cloud"
              color="#27baae"
              name="Build"
              tone="idle"
              preview="Tests pass. PR is up."
              time="8:15"
            />
            <div className="microlabel px-2 pt-4 pb-1.5">Groups</div>
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <div className="flex -space-x-2">
                <BotAvatar shape="circle" color="#ff7a1a" size={22} />
                <BotAvatar shape="drop" color="#925df2" size={22} />
                <BotAvatar shape="cloud" color="#27baae" size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12.5px] font-medium text-ink">Launch review</span>
                  <span className="font-mono text-[10px] text-ink-3">Mon</span>
                </div>
                <div className="truncate text-[11.5px] text-ink-2">Ops: Rollback plan is ready.</div>
              </div>
            </div>
          </div>
          <div className="mt-auto space-y-0.5 border-t border-line p-2.5 text-[12px] text-ink-2">
            <div className="rounded-md px-2 py-1.5">Plugins</div>
            <div className="rounded-md px-2 py-1.5">Settings</div>
          </div>
        </aside>

        {/* chat */}
        <section className="flex min-w-0 flex-col bg-surface">
          <header className="flex h-12 items-center gap-2.5 border-b border-line px-4">
            <BotAvatar shape="circle" color="#ff7a1a" size={24} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-4 text-ink">Research</div>
              <div className="flex items-center gap-1.5 text-[11px] leading-4 text-[#0b7a4b]">
                <StatusDot tone="live" pulse size={5} /> Working
              </div>
            </div>
            <button
              type="button"
              tabIndex={-1}
              className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-[11.5px] font-medium whitespace-nowrap text-ink-2"
            >
              <Monitor size={13} /> Open screen
            </button>
          </header>

          <div className="flex flex-1 flex-col gap-3.5 overflow-hidden px-4 pt-4 pb-2 text-[12.5px] leading-[1.45]">
            <div className="ml-auto max-w-[78%] rounded-[14px] rounded-br-[4px] bg-ink px-3.5 py-2.5 text-paper">
              Compare the three vendor quotes in /workspace/quotes and write a recommendation.
              Include support costs.
            </div>

            <div className="flex items-start gap-2.5">
              <BotAvatar shape="circle" color="#ff7a1a" size={22} className="mt-0.5" />
              <div className="min-w-0 max-w-[85%] space-y-2.5">
                <div className="rounded-[12px] border border-line bg-raised">
                  <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11.5px]">
                    <StatusDot tone="live" pulse size={6} />
                    <span className="font-medium text-ink">Working</span>
                    <span className="text-ink-3">3 of 4 steps</span>
                    <span className="ml-auto font-mono text-[10.5px] text-ink-3">4 min</span>
                  </div>
                  <ul className="space-y-1.5 px-3 py-2.5 text-[12px] text-ink-2">
                    <li className="flex items-start gap-2">
                      <Check size={12} className="mt-[3px] shrink-0 text-[#0b7a4b]" />
                      <span>
                        Read 3 PDFs in{" "}
                        <span className="font-mono text-[11px] text-ink">/workspace/quotes</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Check size={12} className="mt-[3px] shrink-0 text-[#0b7a4b]" />
                      <span>Opened each vendor&apos;s pricing page in Chrome</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Check size={12} className="mt-[3px] shrink-0 text-[#0b7a4b]" />
                      <span>Checked support tiers and renewal terms</span>
                    </li>
                    <li className="flex items-start gap-2 text-ink">
                      <span className="mt-[3px] inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ink" />
                      <span>
                        Writing <span className="font-mono text-[11px]">recommendation.md</span>
                        <span className="blink">▍</span>
                      </span>
                    </li>
                  </ul>
                </div>
                <p className="text-ink">
                  Acme is cheapest over three years once support is included. Northwind looks
                  cheaper up front but charges extra for priority support. I&apos;m saving the
                  comparison to{" "}
                  <span className="font-mono text-[11.5px]">/workspace/quotes/recommendation.md</span>
                  .
                </p>
                <div className="rounded-[12px] border border-attention/30 bg-attention-soft/60 p-3">
                  <div className="flex items-center gap-2 text-[11.5px] font-medium text-attention">
                    <StatusDot tone="attention" size={6} /> Needs you
                  </div>
                  <p className="mt-1 text-ink">
                    Northwind&apos;s renewal terms are behind a login. Can you sign in on my screen?
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <span className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-[11.5px] font-medium text-paper">
                      Open screen
                    </span>
                    <span className="inline-flex h-7 items-center rounded-md border border-line-strong bg-surface px-2.5 text-[11.5px] font-medium text-ink-2">
                      Skip it
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="px-3 pb-3">
            <div className="flex h-10 items-center gap-2 rounded-[12px] border border-line-strong bg-surface px-2 pl-2.5 text-[12.5px] text-ink-3 shadow-card">
              <Plus size={14} />
              <span className="flex-1">Message Research</span>
              <Mic size={14} />
            </div>
          </div>
        </section>

        {/* inspector */}
        <aside className="hidden flex-col gap-4 border-l border-line bg-raised p-3.5 lg:flex">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="microlabel">Screen</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-live-soft px-2 py-0.5 text-[10.5px] font-medium text-[#0b7a4b]">
                <StatusDot tone="live" pulse size={5} /> Live
              </span>
            </div>
            <MiniScreen />
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <span className="inline-flex h-7 items-center justify-center rounded-md border border-line-strong bg-surface text-[11.5px] font-medium text-ink">
                Open screen
              </span>
              <span className="inline-flex h-7 items-center justify-center rounded-md border border-line-strong bg-surface text-[11.5px] font-medium text-ink">
                Take control
              </span>
            </div>
          </div>

          <div>
            <div className="microlabel mb-2">Routines</div>
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <div className="text-[12px] font-medium text-ink">Weekly quote check</div>
              <div className="mt-0.5 text-[11.5px] text-ink-2">Mondays at 9:00</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <Check size={11} className="text-[#0b7a4b]" /> Last run completed
              </div>
            </div>
          </div>

          <div>
            <div className="microlabel mb-2">Files</div>
            <ul className="space-y-1 text-[11.5px]">
              {[
                ["recommendation.md", "now"],
                ["acme-quote.pdf", "Tue"],
                ["northwind-quote.pdf", "Tue"],
                ["globex-quote.pdf", "Tue"],
              ].map(([name, when]) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-ink-2">{name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{when}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
