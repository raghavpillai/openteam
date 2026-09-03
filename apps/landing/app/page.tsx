import { AppWindow } from "@/components/app-window";
import { BotAvatar } from "@/components/bot-avatar";
import { Wordmark } from "@/components/brand";
import {
  ArrowRight,
  ArrowUpRight,
  Brain,
  Clock,
  Folder,
  Github,
  Monitor,
  Phone,
  Puzzle,
  Users,
} from "@/components/icons";
import { InstallCommand } from "@/components/install-command";
import { ScreenViewer } from "@/components/screen-viewer";

const GITHUB = "https://github.com/raghavpillai/openbot";
const INSTALL_GUIDE = `${GITHUB}#install-the-released-server-stack`;

const exampleJobs = [
  {
    shape: "drop",
    color: "#925df2",
    bot: "Ops",
    text: "Every weekday at 8, check our status page and the three vendor dashboards. Message me only if something changed.",
    uses: ["Schedule", "Browser"],
  },
  {
    shape: "circle",
    color: "#ff7a1a",
    bot: "Research",
    text: "Read the PDFs in /workspace/quotes and write a one-page recommendation with the numbers side by side.",
    uses: ["Files"],
  },
  {
    shape: "cloud",
    color: "#27baae",
    bot: "Build",
    text: "Clone the repo, run the test suite, and tell me which tests fail and why.",
    uses: ["Terminal"],
  },
  {
    shape: "square",
    color: "#4b8efb",
    bot: "Finance",
    text: "Sign in to the analytics dashboard, export last month's numbers, and drop the spreadsheet in /workspace/reports.",
    uses: ["Browser", "Needs you to sign in"],
  },
  {
    shape: "hexagon",
    color: "#ef479b",
    bot: "Support",
    text: "Watch this GitHub issue. Every evening, summarize new comments in the Launch review group.",
    uses: ["Schedule", "Group"],
  },
  {
    shape: "blob",
    color: "#10b972",
    bot: "Lead",
    text: "Split this research across three helpers, then combine what they find into one document.",
    uses: ["Helpers", "Files"],
  },
] as const;

const features = [
  {
    icon: Monitor,
    title: "It has its own computer.",
    body: "A real Linux desktop with Chrome, a terminal, and a file manager. A bot opens websites, signs in, downloads files, and runs scripts the way a person would.",
  },
  {
    icon: Brain,
    title: "It remembers.",
    body: "A bot keeps its conversation, notes, and browser logins across days and restarts. Tomorrow starts where today ended. You never repeat yourself.",
  },
  {
    icon: Clock,
    title: "It works on a schedule.",
    body: "Give a bot a routine: a Monday brief, a nightly check, a weekly cleanup. It runs on time with everything it already knows and leaves a history of every run.",
  },
  {
    icon: Users,
    title: "It works with other bots.",
    body: "Put bots in a group to solve something together. Or let one bot spin up helpers for parallel work and gather the results.",
  },
  {
    icon: Folder,
    title: "It shares files with you.",
    body: "Every bot reads and writes the same /workspace folder. A file one bot makes is there for the others, and for you, right away.",
  },
  {
    icon: Puzzle,
    title: "It can use your tools.",
    body: "Connect tools through MCP plugins. Save repeatable instructions as skills. Memory and skills are plain files you can open and edit.",
  },
];

const providers = [
  "ChatGPT Plus or Pro",
  "Claude Pro or Max",
  "OpenAI API key",
  "Anthropic API key",
  "Any OpenAI-compatible endpoint",
  "Any Anthropic-compatible endpoint",
  "Any Google-compatible endpoint",
];

const faqs = [
  {
    q: "What do I need to run it?",
    a: "A machine that stays on, with Docker installed, plus Bun or Node 20. A small VPS, a home server, or a spare Mac all work. The installer checks the host, pulls the images, starts everything, and waits until it's healthy.",
  },
  {
    q: "Does anything run on my laptop or phone?",
    a: "No. The desktop and iPhone apps are thin clients. Bots, schedules, screens, and files all live on the server. Close the apps whenever you like.",
  },
  {
    q: "Which models can I use?",
    a: "Your ChatGPT Plus or Pro account, your Claude Pro or Max account, an OpenAI or Anthropic API key, or any endpoint that speaks the OpenAI, Anthropic, or Google API. Switch models from Settings without restarting.",
  },
  {
    q: "Where do my model credentials live?",
    a: "On the server, in a private volume. The bots' shells can't read them, and the apps never receive them.",
  },
  {
    q: "What happens if the server restarts?",
    a: "Each bot reopens the same conversation, memory, browser logins, and files. Work that was cut off is marked as interrupted, not lost.",
  },
  {
    q: "Can I stop a bot from doing something?",
    a: "Yes. Watch its screen at any time, stop a run with one click, and take control of the mouse and keyboard yourself. Bots ask before sensitive actions, and you approve once or deny.",
  },
  {
    q: "Is it ready for real work?",
    a: "OpenBot is a v0. It's for people comfortable with Docker and a terminal. One script backs up everything, and the CLI updates the stack with a rollback if anything fails.",
  },
  {
    q: "What does it cost?",
    a: "OpenBot is open source and free to run. You pay only for the model you connect and the machine you run it on.",
  },
];

function SectionHeading({
  label,
  title,
  body,
  align = "center",
}: {
  label: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  align?: "center" | "left";
}) {
  const centered = align === "center";
  return (
    <div className={`${centered ? "mx-auto text-center" : ""} max-w-[640px]`}>
      <div className="microlabel">{label}</div>
      <h2 className="display mt-3 text-[40px] leading-[1.05] text-ink sm:text-[48px]">{title}</h2>
      {body ? (
        <p className="mt-4 text-[17px] leading-[1.55] text-ink-2 text-pretty">{body}</p>
      ) : null}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-line bg-surface px-2 text-[11.5px] font-medium text-ink-2">
      {children}
    </span>
  );
}

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line/80 bg-paper/85 backdrop-blur-md">
        <div className="container-page flex h-16 items-center gap-6">
          <a href="#top" aria-label="OpenBot home" className="shrink-0">
            <Wordmark size={22} />
          </a>
          <nav aria-label="Main" className="hidden items-center gap-6 text-[14px] text-ink-2 md:flex">
            <a className="hover:text-ink" href="#how-it-works">
              How it works
            </a>
            <a className="hover:text-ink" href="#features">
              Features
            </a>
            <a className="hover:text-ink" href="#self-hosted">
              Self-hosted
            </a>
            <a className="hover:text-ink" href="#faq">
              FAQ
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href={GITHUB}
              className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13.5px] font-medium text-ink-2 hover:bg-raised hover:text-ink"
            >
              <Github size={16} />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <a
              href="#install"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13.5px] font-medium text-paper hover:bg-[#2a2a2a]"
            >
              Install
              <ArrowRight size={14} />
            </a>
          </div>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section id="top" className="relative overflow-hidden">
          <div className="dot-grid absolute inset-0 -z-10" aria-hidden="true" />
          <div className="container-page pt-20 pb-10 text-center sm:pt-24">
            <p className="inline-flex flex-wrap items-center justify-center gap-x-2 text-[13px] font-medium text-ink-2">
              <span>Open source</span>
              <span className="text-line-strong" aria-hidden="true">
                ·
              </span>
              <span>Self-hosted</span>
              <span className="text-line-strong" aria-hidden="true">
                ·
              </span>
              <span>Bring your own model</span>
            </p>
            <h1 className="display mx-auto mt-5 max-w-[24ch] text-[46px] leading-[1.04] text-ink sm:text-[64px] lg:text-[76px]">
              Give your AI agents a computer, a&nbsp;memory, and a&nbsp;schedule.
            </h1>
            <p className="mx-auto mt-6 max-w-[640px] text-[18px] leading-[1.55] text-ink-2 text-balance sm:text-[19px]">
              OpenBot runs on a server you control. Each bot gets a real Linux desktop, remembers
              every conversation, and can work on a schedule. Message it from your desktop or
              iPhone. Close the app. Come back to the result.
            </p>

            <div id="install" className="mt-9 scroll-mt-24">
              <p className="text-[13.5px] text-ink-3">One command. Runs anywhere Docker runs.</p>
              <div className="mt-3 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <InstallCommand />
                <a
                  href={INSTALL_GUIDE}
                  className="inline-flex h-13 items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-4 text-[14.5px] font-medium text-ink shadow-card hover:bg-raised"
                >
                  Read the install guide
                  <ArrowUpRight size={15} className="text-ink-3" />
                </a>
              </div>
            </div>
          </div>

          <div className="container-page pb-6">
            <div className="mx-auto max-w-[1120px]">
              <AppWindow />
            </div>
            <p className="mt-5 text-center text-[12.5px] text-ink-3">
              The desktop app. Three bots, one owner, and Research asking for a sign-in it can&apos;t
              do on its own.
            </p>
          </div>
        </section>

        {/* Example jobs */}
        <section className="hairline-y py-24" aria-labelledby="jobs-title">
          <div className="container-page">
            <SectionHeading
              label="What a bot can do"
              title={<span id="jobs-title">Jobs you can hand off today.</span>}
              body="A bot is a coworker with a computer. It browses, runs commands, reads and writes files, and comes back with an answer. These are the kinds of messages people send."
            />
            <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {exampleJobs.map((job) => (
                <li
                  key={job.bot}
                  className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
                >
                  <div className="flex items-center gap-2.5">
                    <BotAvatar shape={job.shape} color={job.color} size={26} />
                    <span className="text-[13px] font-medium text-ink">To {job.bot}</span>
                  </div>
                  <p className="text-[15.5px] leading-[1.5] text-ink text-pretty">
                    &ldquo;{job.text}&rdquo;
                  </p>
                  <div className="mt-auto flex flex-wrap gap-1.5">
                    {job.uses.map((u) => (
                      <Chip key={u}>{u}</Chip>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="hairline-y scroll-mt-16 py-24">
          <div className="container-page">
            <SectionHeading
              label="How it works"
              title="Up and running in three steps."
              body="No account with us. No hosted service in the middle. The whole thing runs on your machine and talks only to the model you choose."
            />
            <ol className="mt-14 grid gap-4 lg:grid-cols-3">
              {[
                {
                  n: "1",
                  title: "Install on a machine you control",
                  body: "One command sets up the server, the worker, the database, and a shared Linux desktop with Docker. It runs on a VPS, a home server, or a spare Mac.",
                  code: "bunx --bun @openbot/cli install",
                },
                {
                  n: "2",
                  title: "Sign in with a model you already have",
                  body: "Use your ChatGPT or Claude subscription, an OpenAI or Anthropic API key, or your own endpoint. Credentials stay on the server.",
                  code: "openbot provider login",
                },
                {
                  n: "3",
                  title: "Create a bot and give it a job",
                  body: "Message it from the desktop or iPhone app. It browses, runs commands, and writes files. Close the app whenever. The work continues.",
                  code: "Message Research…",
                },
              ].map((step) => (
                <li
                  key={step.n}
                  className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-card"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink font-mono text-[13px] font-medium text-paper">
                    {step.n}
                  </span>
                  <h3 className="mt-5 text-[19px] leading-[1.25] font-medium text-ink text-balance">
                    {step.title}
                  </h3>
                  <p className="mt-2.5 text-[15px] leading-[1.55] text-ink-2 text-pretty">
                    {step.body}
                  </p>
                  <div className="mt-auto pt-6">
                    <code className="block truncate rounded-lg bg-raised px-3 py-2 font-mono text-[12.5px] text-ink-2">
                      <span className="text-ink-3">$ </span>
                      {step.code}
                    </code>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="hairline-y scroll-mt-16 py-24">
          <div className="container-page">
            <SectionHeading
              label="What every bot gets"
              title="More than a chat window."
              body="A chat window forgets, can't click, and stops when you close the tab. Each OpenBot bot has what a coworker has."
            />
            <ul className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <li key={f.title}>
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink shadow-card">
                    <f.icon size={17} />
                  </span>
                  <h3 className="display mt-4 text-[26px] leading-[1.15] text-ink">{f.title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.55] text-ink-2 text-pretty">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Screen and takeover */}
        <section className="hairline-y py-24">
          <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <SectionHeading
                align="left"
                label="You stay in charge"
                title="Watch the screen. Take over when it matters."
                body="Every bot has a live screen you can open from the desktop or your phone. When a sign-in, a payment, or a judgment call comes up, the bot asks. You approve once, deny, or take the mouse yourself. Then hand it back."
              />
              <ul className="mt-8 space-y-3 text-[15px] text-ink-2">
                {[
                  "See exactly what the bot is doing, as it does it.",
                  "Bots ask before sensitive actions. Nothing happens until you answer.",
                  "Take control, sign in, and hand back. The bot picks up where you left off.",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-3">
                    <span className="mt-[9px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
                    <span className="text-pretty">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
            <ScreenViewer />
          </div>
        </section>

        {/* Apps */}
        <section className="hairline-y py-24">
          <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <div className="order-2 flex justify-center gap-5 sm:gap-8 lg:order-1">
              {/* Plain <img>: these are two static PNGs; the image optimizer route is not part of this deployment. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/openbot-mobile-home.png"
                alt="The OpenBot iPhone app home screen listing three bots: Research is working, Ops is paused until Monday, and Build finished a task."
                width={1206}
                height={2622}
                loading="lazy"
                className="w-[44%] max-w-[250px] rounded-[28px] shadow-phone"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/openbot-mobile-chat.png"
                alt="The OpenBot iPhone app in a conversation with the Research bot, showing a request to approve opening an app."
                width={1206}
                height={2622}
                loading="lazy"
                className="w-[44%] max-w-[250px] translate-y-10 rounded-[28px] shadow-phone"
              />
            </div>
            <div className="order-1 lg:order-2">
              <SectionHeading
                align="left"
                label="Desktop and iPhone"
                title="Talk to your bots from your desktop or your phone."
                body="The desktop app is home base. The iPhone app shows every bot, its status, and its latest message so you can reply, approve a request, or open a screen from anywhere. Nothing runs on the phone, so a dead battery never stops a job."
              />
              <div className="mt-8 flex flex-wrap gap-2">
                <Chip>
                  <Monitor size={12} className="mr-1.5" /> Desktop app
                </Chip>
                <Chip>
                  <Phone size={12} className="mr-1.5" /> iPhone app
                </Chip>
                <Chip>Search across every bot</Chip>
                <Chip>Push notifications</Chip>
              </div>
            </div>
          </div>
        </section>

        {/* Models */}
        <section className="hairline-y py-24">
          <div className="container-page">
            <SectionHeading
              label="Bring your own model"
              title="Use the model you already pay for."
              body="Sign in once on the server. Every bot uses it. Change the model or the reasoning level from Settings and the next message uses it. No restart."
            />
            <ul className="mx-auto mt-10 flex max-w-[820px] flex-wrap justify-center gap-2">
              {providers.map((p) => (
                <li
                  key={p}
                  className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-[14px] font-medium text-ink shadow-card"
                >
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Self-hosted */}
        <section id="self-hosted" className="hairline-y scroll-mt-16 py-24">
          <div className="container-page">
            <SectionHeading
              label="Self-hosted"
              title="Runs on your server. Your data stays there."
              body="The only thing that leaves your machine is the request to the model provider you chose. Everything else is yours to read, back up, and delete."
            />

            <div className="mx-auto mt-14 max-w-[960px]">
              <div className="grid gap-3 md:grid-cols-[1fr_auto_1.5fr_auto_1fr] md:items-stretch">
                <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
                  <div className="microlabel">Your devices</div>
                  <ul className="mt-3 space-y-2 text-[14px] text-ink">
                    <li className="flex items-center gap-2">
                      <Monitor size={15} className="text-ink-3" /> Desktop app
                    </li>
                    <li className="flex items-center gap-2">
                      <Phone size={15} className="text-ink-3" /> iPhone app
                    </li>
                  </ul>
                  <p className="mt-4 text-[12.5px] leading-[1.45] text-ink-3">
                    Thin clients. They never hold model credentials.
                  </p>
                </div>

                <div className="hidden items-center md:flex" aria-hidden="true">
                  <ArrowRight size={18} className="text-ink-3" />
                </div>

                <div className="rounded-2xl border border-ink bg-surface p-5 shadow-card">
                  <div className="flex items-center justify-between">
                    <div className="microlabel text-ink">Your server</div>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-live-soft px-2 py-0.5 text-[10.5px] font-medium text-[#0b7a4b]">
                      <span className="live-pulse inline-block h-[5px] w-[5px] rounded-full bg-live" />{" "}
                      Always on
                    </span>
                  </div>
                  <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] text-ink">
                    <li>Server</li>
                    <li>Worker</li>
                    <li>Postgres</li>
                    <li>Linux desktop</li>
                  </ul>
                  <div className="mt-4 rounded-lg bg-raised px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink-2">
                    Bots, memory, browser logins, schedules, and{" "}
                    <span className="font-mono text-ink">/workspace</span> live here, in volumes you
                    can back up with one script.
                  </div>
                </div>

                <div className="hidden items-center md:flex" aria-hidden="true">
                  <ArrowRight size={18} className="text-ink-3" />
                </div>

                <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
                  <div className="microlabel">Your model</div>
                  <ul className="mt-3 space-y-2 text-[14px] text-ink">
                    <li>ChatGPT or Claude</li>
                    <li>An API key</li>
                    <li>Your own endpoint</li>
                  </ul>
                  <p className="mt-4 text-[12.5px] leading-[1.45] text-ink-3">
                    The only outside connection, and you choose it.
                  </p>
                </div>
              </div>
            </div>

            <ul className="mx-auto mt-12 grid max-w-[960px] gap-x-10 gap-y-6 sm:grid-cols-2">
              {[
                [
                  "Credentials stay on the server.",
                  "The bots' shells can't read them. The apps never receive them.",
                ],
                [
                  "One owner account, HTTPS by default.",
                  "Point a domain at the server and the installer sets up certificates. Or keep it on a private network.",
                ],
                [
                  "Back up everything with one script.",
                  "Chat history, memory, browser profiles, and files are restored together, and every bot picks up where it stopped.",
                ],
                [
                  "Update and repair from the CLI.",
                  "openbot update checks the release, backs up the database, and rolls back on its own if startup fails.",
                ],
              ].map(([title, body]) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-[7px] inline-block h-2 w-2 shrink-0 rounded-full bg-ink" />
                  <div>
                    <div className="text-[15.5px] font-medium text-ink">{title}</div>
                    <p className="mt-1 text-[14.5px] leading-[1.5] text-ink-2 text-pretty">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="hairline-y scroll-mt-16 py-24">
          <div className="container-page grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <SectionHeading
              align="left"
              label="Questions"
              title="Before you install."
              body="The practical details that matter before you give a bot real work."
            />
            <div className="divide-y divide-line border-y border-line">
              {faqs.map((f) => (
                <details key={f.q} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[17px] font-medium text-ink [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span
                      aria-hidden="true"
                      className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-ink-2"
                    >
                      <span className="absolute h-[1.5px] w-3 bg-current" />
                      <span className="absolute h-3 w-[1.5px] bg-current transition-transform group-open:rotate-90" />
                    </span>
                  </summary>
                  <p className="max-w-[62ch] pb-6 text-[15.5px] leading-[1.6] text-ink-2 text-pretty">
                    {f.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Closing */}
        <section className="hairline-y py-24">
          <div className="container-page text-center">
            <div className="mx-auto flex justify-center gap-1.5" aria-hidden="true">
              <BotAvatar shape="circle" color="#ff7a1a" size={36} />
              <BotAvatar shape="drop" color="#925df2" size={36} />
              <BotAvatar shape="cloud" color="#27baae" size={36} />
              <BotAvatar shape="square" color="#4b8efb" size={36} />
              <BotAvatar shape="hexagon" color="#ef479b" size={36} />
            </div>
            <h2 className="display mx-auto mt-6 max-w-[16ch] text-[44px] leading-[1.04] text-ink sm:text-[60px]">
              Give one bot a real job tonight.
            </h2>
            <p className="mx-auto mt-5 max-w-[520px] text-[17px] leading-[1.55] text-ink-2 text-pretty">
              Install takes a few minutes. The first result usually takes less.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <InstallCommand />
              <a
                href={GITHUB}
                className="inline-flex h-13 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[14.5px] font-medium text-ink shadow-card hover:bg-raised"
              >
                <Github size={16} />
                Star on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="hairline-y">
        <div className="container-page flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Wordmark size={18} />
            <p className="mt-2 text-[13px] text-ink-3">Open source, self-hosted AI agents.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-2">
            <a className="hover:text-ink" href={GITHUB}>
              GitHub
            </a>
            <a className="hover:text-ink" href={INSTALL_GUIDE}>
              Install guide
            </a>
            <a className="hover:text-ink" href={`${GITHUB}/issues`}>
              Issues
            </a>
            <a className="hover:text-ink" href={`${GITHUB}/releases`}>
              Releases
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
