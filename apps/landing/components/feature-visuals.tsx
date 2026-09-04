import { Check, FileText, Folder, Plug, Sparkles } from "lucide-react";
import { MiniScreen } from "./app-window";
import { BotAvatar } from "./bot-avatar";

/* Small product renders for the feature grid. Same palette and type as the app. */

const frame = "rounded-[12px] border border-line bg-surface shadow-card";

export function ComputerVisual() {
  return (
    <div role="img" aria-label="A bot's Linux screen with a browser and a terminal open" className={`${frame} p-2`}>
      <MiniScreen />
      <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="live-pulse inline-block h-[5px] w-[5px] rounded-full bg-live" />
          Research&apos;s screen
        </span>
        <span className="font-mono">1280×800</span>
      </div>
    </div>
  );
}

export function MemoryVisual() {
  const label = "Notes a bot kept across three days";
  const rows = [
    ["Mon", "Learned the three vendors and where their quotes live."],
    ["Tue", "Kept the Northwind sign-in for next time."],
    ["Today", "Picked up the comparison where it left off."],
  ];
  return (
    <div role="img" aria-label={label} className={`${frame} divide-y divide-line`}>
      {rows.map(([day, text], i) => (
        <div key={day} className="flex items-start gap-3 px-3.5 py-2.5">
          <span
            className={`mt-0.5 w-10 shrink-0 font-mono text-[10.5px] ${i === 2 ? "text-ink" : "text-ink-3"}`}
          >
            {day}
          </span>
          <span className={`text-[12px] leading-[1.45] ${i === 2 ? "text-ink" : "text-ink-2"}`}>
            {text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ScheduleVisual() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div role="img" aria-label="A routine that runs every Monday at 9:00" className={`${frame} p-3.5`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12.5px] font-medium text-ink">Weekly quote check</div>
          <div className="mt-0.5 text-[11.5px] text-ink-2">Mondays at 9:00</div>
        </div>
        <span className="inline-flex h-5 items-center rounded-full bg-live-soft px-2 text-[10.5px] font-medium text-[#0b7a4b]">
          Active
        </span>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1">
        {days.map((d, i) => (
          <div
            key={i}
            className={`flex h-7 flex-col items-center justify-center rounded-md text-[10px] ${
              i === 0 ? "bg-ink text-paper" : "bg-raised text-ink-3"
            }`}
          >
            {d}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-3">
        <Check size={11} className="shrink-0 text-[#0b7a4b]" /> Last run completed
      </div>
    </div>
  );
}

export function TeamVisual() {
  const lines = [
    ["circle", "#ff7a1a", "Research", "Comparison is in /workspace/quotes."],
    ["drop", "#925df2", "Ops", "Rollback plan is ready. Waiting on Build."],
    ["cloud", "#27baae", "Build", "Tests pass. PR is up."],
  ] as const;
  return (
    <div role="img" aria-label="Three bots reporting into a group called Launch review" className={`${frame} p-3.5`}>
      <div className="flex items-center gap-2 border-b border-line pb-2.5">
        <div className="flex -space-x-1.5">
          <BotAvatar shape="circle" color="#ff7a1a" size={18} />
          <BotAvatar shape="drop" color="#925df2" size={18} />
          <BotAvatar shape="cloud" color="#27baae" size={18} />
        </div>
        <span className="text-[12px] font-medium text-ink">Launch review</span>
        <span className="ml-auto text-[10.5px] text-ink-3">3 bots</span>
      </div>
      <ul className="mt-2.5 space-y-2">
        {lines.map(([shape, color, name, text]) => (
          <li key={name} className="flex items-start gap-2">
            <BotAvatar shape={shape} color={color} size={16} className="mt-0.5" />
            <span className="text-[11.5px] leading-[1.4] text-ink-2">
              <span className="font-medium text-ink">{name}</span> {text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FilesVisual() {
  const rows: [number, string, string, boolean][] = [
    [0, "workspace", "", false],
    [1, "quotes", "", false],
    [2, "acme-quote.pdf", "Tue", false],
    [2, "northwind-quote.pdf", "Tue", false],
    [2, "recommendation.md", "now", true],
    [1, "reports", "", false],
  ];
  return (
    <div role="img" aria-label="The shared workspace folder with a newly written recommendation file" className={`${frame} p-2`}>
      <ul className="space-y-0.5 font-mono text-[11.5px]">
        {rows.map(([depth, name, when, fresh]) => (
          <li
            key={name}
            className={`flex items-center gap-2 rounded-md px-2 py-1 ${fresh ? "bg-live-soft/70 text-ink" : "text-ink-2"}`}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            {when === "" ? (
              <Folder size={12} className="text-ink-3" />
            ) : (
              <FileText size={12} className={fresh ? "text-[#0b7a4b]" : "text-ink-3"} />
            )}
            <span className="truncate">{when === "" ? `${name}/` : name}</span>
            {when ? <span className="ml-auto shrink-0 text-[10px] text-ink-3">{when}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ToolsVisual() {
  const plugins = ["GitHub", "Linear", "Postgres"];
  const skills = ["weekly-brief", "vendor-check"];
  return (
    <div role="img" aria-label="Connected plugins and saved skills" className={`${frame} p-3.5`}>
      <div className="microlabel">Plugins</div>
      <ul className="mt-2 space-y-1.5">
        {plugins.map((p) => (
          <li key={p} className="flex items-center gap-2 text-[12px] text-ink">
            <Plug size={12} className="text-ink-3" />
            {p}
            <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-[#0b7a4b]">
              <span className="inline-block h-[5px] w-[5px] rounded-full bg-live" /> Connected
            </span>
          </li>
        ))}
      </ul>
      <div className="microlabel mt-3.5">Skills</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {skills.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-1 font-mono text-[11px] text-ink-2"
          >
            <Sparkles size={11} className="text-ink-3" />
            {s}/SKILL.md
          </span>
        ))}
      </div>
    </div>
  );
}
