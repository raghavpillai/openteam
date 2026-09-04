import { ArrowRight, ArrowUpRight, Monitor, Smartphone } from "lucide-react";
import { AppWindow } from "@/components/app-window";
import { BotAvatar } from "@/components/bot-avatar";
import { GithubMark, Wordmark } from "@/components/brand";
import {
  ComputerVisual,
  FilesVisual,
  MemoryVisual,
  ScheduleVisual,
  TeamVisual,
  ToolsVisual,
} from "@/components/feature-visuals";
import { InstallCommand } from "@/components/install-command";
import { Installer } from "@/components/installer";
import { Reveal } from "@/components/motion";
import { ScreenViewer } from "@/components/screen-viewer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { order } from "@/lib/motion";
import { cn } from "@/lib/utils";

const GITHUB = "https://github.com/raghavpillai/openteam";
const INSTALL_GUIDE = "/download";

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

const steps = [
  {
    n: "1",
    title: "Install on a machine you control",
    body: "One command sets up the server, the worker, the database, and a shared Linux desktop with Docker. It runs on a VPS, a home server, or a spare Mac.",
    code: "curl -fsSL openteam.so/install | sh",
  },
  {
    n: "2",
    title: "Sign in with a model you already have",
    body: "Use your ChatGPT or Claude subscription, an OpenAI or Anthropic API key, or your own endpoint. Credentials stay on the server.",
    code: "openteam provider login",
  },
  {
    n: "3",
    title: "Create a bot and give it a job",
    body: "Message it from the desktop or iPhone app. It browses, runs commands, and writes files. Close the app whenever. The work continues.",
    code: "Message Research…",
  },
];

const features = [
  {
    visual: ComputerVisual,
    title: "It has its own computer.",
    body: "A Linux desktop with Chrome, a terminal, and a home folder. Real ones. A bot uses them the way you do: opens sites, signs in, downloads files, runs scripts.",
  },
  {
    visual: MemoryVisual,
    title: "It remembers.",
    body: "Restart the server. The bot still remembers. Conversation, notes, and browser logins carry over, so tomorrow starts where today ended.",
  },
  {
    visual: ScheduleVisual,
    title: "It works on a schedule.",
    body: "Give it a routine. It runs every morning with everything it already knows, and keeps a history of every run.",
  },
  {
    visual: TeamVisual,
    title: "It works with other bots.",
    body: "Put bots in a group and give them one job. Or let one bot spin up helpers, hand out the work, and gather the results.",
  },
  {
    visual: FilesVisual,
    title: "It shares files with you.",
    body: "Every bot reads and writes the same /workspace folder. A file one bot makes is there for the others, and for you, right away.",
  },
  {
    visual: ToolsVisual,
    title: "It can use your tools.",
    body: "Connect tools through MCP plugins. Save repeatable instructions as skills. Memory and skills are plain files you can open and edit.",
  },
];

const worksWith = [
  "OpenAI",
  "Anthropic",
  "Google-compatible endpoints",
  "Docker",
  "Postgres",
  "MCP",
  "Chrome",
  "Linux",
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

const selfHostedFacts = [
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
    "openteam update checks the release, backs up the database, and rolls back on its own if startup fails.",
  ],
];

const faqs = [
  {
    q: "What do I need to run it?",
    a: "A machine that stays on with Docker installed. A small VPS, a home server, or a spare Mac all work. The installer detects the host, downloads a verified native CLI from GitHub, pulls the images, and waits until everything is healthy.",
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
    a: "OpenTeam is a v0. It's for people comfortable with Docker and a terminal. One script backs up everything, and the CLI updates the stack with a rollback if anything fails.",
  },
  {
    q: "What does it cost?",
    a: "OpenTeam is open source and free to run. You pay only for the model you connect and the machine you run it on.",
  },
];

/* Shared class recipes so the shadcn primitives keep the paper look everywhere. */
const chip = "h-6 border-line bg-surface px-2 text-[11.5px] text-ink-2";
const cardBase = "rounded-2xl shadow-card ring-0";
const bigCta = "h-13 gap-1.5 rounded-xl px-4 text-[14.5px] shadow-card";

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
  return (
    <Reveal
      stagger={70}
      className={cn("max-w-[640px]", align === "center" && "mx-auto text-center")}
    >
      <div className="microlabel" style={order(0)}>
        {label}
      </div>
      <h2
        className="display mt-3 text-[40px] leading-[1.05] text-ink sm:text-[48px]"
        style={order(1)}
      >
        {title}
      </h2>
      {body ? (
        <p className="mt-4 text-[17px] leading-[1.55] text-ink-2 text-pretty" style={order(2)}>
          {body}
        </p>
      ) : null}
    </Reveal>
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
          <a href="#top" aria-label="OpenTeam home" className="shrink-0">
            <Wordmark size={22} />
          </a>
          <nav
            aria-label="Main"
            className="hidden items-center gap-6 text-[14px] text-ink-2 md:flex"
          >
            <a className="py-2 hover:text-ink" href="#how-it-works">
              How it works
            </a>
            <a className="py-2 hover:text-ink" href="#features">
              Features
            </a>
            <a className="py-2 hover:text-ink" href="#self-hosted">
              Self-hosted
            </a>
            <a className="py-2 hover:text-ink" href="/download">
              Download
            </a>
            <a className="py-2 hover:text-ink" href="#faq">
              FAQ
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="lg"
              className="h-10 gap-2 px-3 text-[13.5px] text-ink-2 hover:text-ink"
              render={<a href={GITHUB} />}
              nativeButton={false}
            >
              <GithubMark />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
            <Button
              size="lg"
              className="h-10 px-3.5 text-[13.5px]"
              render={<a href="/download" />}
              nativeButton={false}
            >
              Install
              <ArrowRight />
            </Button>
          </div>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section id="top" className="relative overflow-hidden">
          <div className="dot-grid absolute inset-0 -z-10" aria-hidden="true" />
          <div className="container-page pt-20 pb-10 text-center sm:pt-24">
            <p
              className="rise inline-flex flex-wrap items-center justify-center gap-x-2 text-[13px] font-medium text-ink-2"
              style={{ "--d": "0ms" } as React.CSSProperties}
            >
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
            <h1
              className="rise display mx-auto mt-5 max-w-[24ch] text-[clamp(38px,11.5vw,46px)] leading-[1.04] text-ink sm:text-[64px] lg:text-[76px]"
              style={{ "--d": "90ms" } as React.CSSProperties}
            >
              Give your AI agents a computer, a&nbsp;memory, and a&nbsp;schedule.
            </h1>
            <p
              className="rise mx-auto mt-6 max-w-[640px] text-[18px] leading-[1.55] text-ink-2 text-balance sm:text-[19px]"
              style={{ "--d": "180ms" } as React.CSSProperties}
            >
              Open-source agents that browse, build, and remember, on a server you control. Every
              bot gets a Linux desktop, a memory that survives restarts, and a schedule. Close the
              app. Come back to the result.
            </p>

            <div
              id="install"
              className="rise mt-9 scroll-mt-24"
              style={{ "--d": "270ms" } as React.CSSProperties}
            >
              <p className="text-[13.5px] text-ink-3">One command. Runs anywhere Docker runs.</p>
              <div className="mt-3 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <InstallCommand />
                <Button
                  variant="outline"
                  size="lg"
                  className={cn(bigCta, "border-line-strong bg-surface")}
                  render={<a href={INSTALL_GUIDE} />}
                  nativeButton={false}
                >
                  Download options
                  <ArrowUpRight className="size-[15px] text-ink-3" />
                </Button>
              </div>
            </div>
          </div>

          <div className="container-page pb-6">
            <div
              className="rise relative isolate mx-auto max-w-[1120px]"
              style={{ "--d": "420ms" } as React.CSSProperties}
            >
              <div
                aria-hidden="true"
                className="hero-glow absolute inset-x-6 top-4 bottom-2 -z-10 rounded-[48px]"
              />
              <AppWindow />
            </div>
            <p
              className="rise mt-5 text-center text-[12.5px] text-ink-3"
              style={{ "--d": "900ms" } as React.CSSProperties}
            >
              The desktop app. Three bots, one owner, and Research asking for a sign-in it
              can&apos;t do on its own.
            </p>
            <ul
              aria-label="Works with"
              className="rise mx-auto mt-12 flex max-w-[900px] flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] font-medium text-ink-3"
              style={{ "--d": "1000ms" } as React.CSSProperties}
            >
              <li className="microlabel">Works with</li>
              {worksWith.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        </section>

        <Separator />

        {/* Example jobs */}
        <section className="py-24" aria-labelledby="jobs-title">
          <div className="container-page">
            <SectionHeading
              label="What a bot can do"
              title={<span id="jobs-title">Jobs you can hand off today.</span>}
              body="Tell a bot what to do, in plain words. It browses, runs commands, reads and writes files, and comes back with an answer. These are the kinds of messages people send."
            />
            <Reveal as="ul" stagger={70} className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {exampleJobs.map((job, i) => (
                <li key={job.bot} className="flex" style={order(i)}>
                  <Card className={cn(cardBase, "flex-1 [--card-spacing:--spacing(5)]")}>
                    <CardContent className="flex flex-1 flex-col gap-4">
                      <div className="flex items-center gap-2.5">
                        <BotAvatar
                          shape={job.shape}
                          color={job.color}
                          size={26}
                          blink
                          blinkDelay={i * 900}
                        />
                        <span className="text-[13px] font-medium text-ink">To {job.bot}</span>
                      </div>
                      <p className="text-[15.5px] leading-[1.5] text-ink text-pretty">
                        &ldquo;{job.text}&rdquo;
                      </p>
                      <div className="mt-auto flex flex-wrap gap-1.5">
                        {job.uses.map((u) => (
                          <Badge key={u} variant="outline" className={chip}>
                            {u}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-16 py-24">
          <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <SectionHeading
                align="left"
                label="How it works"
                title="One command. Bots in minutes."
                body="No hosted account. No usage caps. Just Docker on a machine you control, talking only to the model you choose."
              />
              <Reveal as="ol" stagger={90} delay={150} className="mt-10 space-y-7">
                {steps.map((step, i) => (
                  <li key={step.n} className="flex gap-4" style={order(i)}>
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink font-mono text-[13px] font-medium text-paper">
                      {step.n}
                    </span>
                    <div>
                      <h3 className="text-[19px] leading-[1.25] font-medium text-ink text-balance">
                        {step.title}
                      </h3>
                      <p className="mt-1.5 text-[15px] leading-[1.55] text-ink-2 text-pretty">
                        {step.body}
                      </p>
                    </div>
                  </li>
                ))}
              </Reveal>
            </div>
            <Reveal delay={150}>
              <Installer />
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* Features */}
        <section id="features" className="scroll-mt-16 py-24">
          <div className="container-page">
            <SectionHeading
              label="What every bot gets"
              title="More than a chat window."
              body="Chatbots forget, can't click, and stop when you close the tab. Every OpenTeam bot has what a coworker has."
            />
            <Reveal as="ul" stagger={70} className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-12">
              {features.map((f, i) => {
                const wide = i === 0;
                return (
                  <li
                    key={f.title}
                    className={cn("flex", wide ? "md:col-span-2 lg:col-span-7" : i === 1 ? "lg:col-span-5" : "lg:col-span-3")}
                    style={order(i)}
                  >
                    <Card className={cn(cardBase, "flex-1 [--card-spacing:--spacing(6)]")}>
                      <CardContent
                        className={cn(
                          "flex flex-1 flex-col",
                          wide && "sm:grid sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] sm:items-center sm:gap-8"
                        )}
                      >
                        <div>
                          <h3 className="display text-[26px] leading-[1.15] text-ink">{f.title}</h3>
                          <p className="mt-2 text-[15px] leading-[1.55] text-ink-2 text-pretty">
                            {f.body}
                          </p>
                        </div>
                        <div className={cn("mt-auto pt-6", wide && "sm:mt-0 sm:pt-0")}>
                          <f.visual />
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* Screen and takeover */}
        <section className="py-24">
          <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <SectionHeading
                align="left"
                label="You stay in charge"
                title="Watch the screen. Take over when it matters."
                body="Every bot has a live screen you can open from the desktop or your phone. When a sign-in, a payment, or a judgment call comes up, the bot asks. You approve once, deny, or take the mouse yourself. Then hand it back."
              />
              <Reveal
                as="ul"
                stagger={80}
                delay={200}
                className="mt-8 space-y-3 text-[15px] text-ink-2"
              >
                {[
                  "See every click, as it happens.",
                  "Risky actions wait for you. Nothing happens until you answer.",
                  "Take the keyboard whenever you want. Hand it back when you're done.",
                ].map((line, i) => (
                  <li key={line} className="flex items-start gap-3" style={order(i)}>
                    <span className="mt-[9px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
                    <span className="text-pretty">{line}</span>
                  </li>
                ))}
              </Reveal>
            </div>
            <Reveal delay={150}>
              <ScreenViewer />
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* Apps */}
        <section className="py-24">
          <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <Reveal stagger={120} className="order-2 flex justify-center gap-5 sm:gap-8 lg:order-1">
              <div
                className="drift w-[44%] max-w-[250px]"
                style={{ ...order(0), "--drift": "20px" } as React.CSSProperties}
              >
                {/* Plain <img>: these are two static PNGs; the image optimizer route is not part of this deployment. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/screenshots/openteam-mobile-home.png"
                  alt="The OpenTeam iPhone app home screen listing three bots: Research is working, Ops is paused until Monday, and Build finished a task."
                  width={1206}
                  height={2622}
                  loading="lazy"
                  className="w-full rounded-[28px] shadow-phone"
                />
              </div>
              <div
                className="drift w-[44%] max-w-[250px] translate-y-10"
                style={{ ...order(1), "--drift": "56px" } as React.CSSProperties}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/screenshots/openteam-mobile-chat.png"
                  alt="The OpenTeam iPhone app in a conversation with the Research bot, showing a request to approve opening an app."
                  width={1206}
                  height={2622}
                  loading="lazy"
                  className="w-full rounded-[28px] shadow-phone"
                />
              </div>
            </Reveal>
            <div className="order-1 lg:order-2">
              <SectionHeading
                align="left"
                label="Desktop and iPhone"
                title="On your desktop. On your iPhone. Same bots."
                body="The desktop app is home base. The iPhone app shows every bot, its status, and its latest message so you can reply, approve a request, or open a screen from anywhere. Nothing runs on the phone, so a dead battery never stops a job."
              />
              <Reveal stagger={50} delay={200} className="mt-8 flex flex-wrap gap-2">
                <Badge variant="outline" className={chip} style={order(0)}>
                  <Monitor data-icon="inline-start" />
                  Desktop app
                </Badge>
                <Badge variant="outline" className={chip} style={order(1)}>
                  <Smartphone data-icon="inline-start" />
                  iPhone app
                </Badge>
                <Badge variant="outline" className={chip} style={order(2)}>
                  Search across every bot
                </Badge>
                <Badge variant="outline" className={chip} style={order(3)}>
                  Push notifications
                </Badge>
              </Reveal>
            </div>
          </div>
        </section>

        <Separator />

        {/* Models */}
        <section className="py-24">
          <div className="container-page">
            <SectionHeading
              label="Bring your own model"
              title="Use the model you already pay for."
              body="Sign in with your ChatGPT or Claude subscription, an API key, or your own endpoint. Every bot uses it. Switch models from Settings. No restart."
            />
            <Reveal
              as="ul"
              stagger={50}
              className="mx-auto mt-10 flex max-w-[820px] flex-wrap justify-center gap-2"
            >
              {providers.map((p, i) => (
                <Badge
                  key={p}
                  variant="outline"
                  render={<li />}
                  style={order(i)}
                  className="h-10 border-line bg-surface px-4 text-[14px] text-ink shadow-card"
                >
                  {p}
                </Badge>
              ))}
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* Self-hosted */}
        <section id="self-hosted" className="scroll-mt-16 py-24">
          <div className="container-page">
            <SectionHeading
              label="Self-hosted"
              title="Your server. Your data. Your bots."
              body="Nothing leaves your machine except the request to the model you chose. Everything else is yours to read, back up, and delete."
            />

            <div className="mx-auto mt-14 max-w-[960px]">
              <Reveal
                stagger={110}
                className="grid gap-3 md:grid-cols-[1fr_auto_1.5fr_auto_1fr] md:items-stretch"
              >
                <Card className={cn(cardBase, "[--card-spacing:--spacing(5)]")} style={order(0)}>
                  <CardContent>
                    <div className="microlabel">Your devices</div>
                    <ul className="mt-3 space-y-2 text-[14px] text-ink">
                      <li className="flex items-center gap-2">
                        <Monitor className="size-[15px] text-ink-3" /> Desktop app
                      </li>
                      <li className="flex items-center gap-2">
                        <Smartphone className="size-[15px] text-ink-3" /> iPhone app
                      </li>
                    </ul>
                    <p className="mt-4 text-[12.5px] leading-[1.45] text-ink-3">
                      Thin clients. They never hold model credentials.
                    </p>
                  </CardContent>
                </Card>

                <div className="hidden items-center md:flex" aria-hidden="true" style={order(1)}>
                  <ArrowRight className="size-[18px] text-ink-3" />
                </div>

                <Card
                  className={cn(cardBase, "ring-1 ring-ink [--card-spacing:--spacing(5)]")}
                  style={order(2)}
                >
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div className="microlabel text-ink">Your server</div>
                      <Badge className="h-auto gap-1.5 bg-live-soft px-2 py-0.5 text-[11px] text-[#0b7a4b]">
                        <span className="live-pulse inline-block h-[5px] w-[5px] rounded-full bg-live" />
                        Always on
                      </Badge>
                    </div>
                    <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] text-ink">
                      <li>Server</li>
                      <li>Worker</li>
                      <li>Postgres</li>
                      <li>Linux desktop</li>
                    </ul>
                    <div className="mt-4 rounded-lg bg-raised px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink-2">
                      Bots, memory, browser logins, schedules, and{" "}
                      <span className="font-mono text-ink">/workspace</span> live here, in volumes
                      you can back up with one script.
                    </div>
                  </CardContent>
                </Card>

                <div className="hidden items-center md:flex" aria-hidden="true" style={order(3)}>
                  <ArrowRight className="size-[18px] text-ink-3" />
                </div>

                <Card className={cn(cardBase, "[--card-spacing:--spacing(5)]")} style={order(4)}>
                  <CardContent>
                    <div className="microlabel">Your model</div>
                    <ul className="mt-3 space-y-2 text-[14px] text-ink">
                      <li>ChatGPT or Claude</li>
                      <li>An API key</li>
                      <li>Your own endpoint</li>
                    </ul>
                    <p className="mt-4 text-[12.5px] leading-[1.45] text-ink-3">
                      The only outside connection, and you choose it.
                    </p>
                  </CardContent>
                </Card>
              </Reveal>
            </div>

            <Reveal
              as="ul"
              stagger={70}
              className="mx-auto mt-12 grid max-w-[960px] gap-x-10 gap-y-6 sm:grid-cols-2"
            >
              {selfHostedFacts.map(([title, body], i) => (
                <li key={title} className="flex gap-3" style={order(i)}>
                  <span className="mt-[7px] inline-block h-2 w-2 shrink-0 rounded-full bg-ink" />
                  <div>
                    <div className="text-[15.5px] font-medium text-ink">{title}</div>
                    <p className="mt-1 text-[14.5px] leading-[1.5] text-ink-2 text-pretty">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* FAQ */}
        <section id="faq" className="scroll-mt-16 py-24">
          <div className="container-page grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <SectionHeading
              align="left"
              label="Questions"
              title="Before you install."
              body="The practical details that matter before you give a bot real work."
            />
            <Reveal delay={120}>
              <Accordion className="border-y border-line">
                {faqs.map((f) => (
                  <AccordionItem key={f.q} value={f.q}>
                    <AccordionTrigger className="items-center gap-6 rounded-none py-5 text-[17px] text-ink hover:no-underline **:data-[slot=accordion-trigger-icon]:size-5 **:data-[slot=accordion-trigger-icon]:text-ink-2">
                      {f.q}
                    </AccordionTrigger>
                    <AccordionContent className="max-w-[62ch] pb-6 text-[15.5px] leading-[1.6] text-ink-2 text-pretty">
                      {f.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </Reveal>
          </div>
        </section>

        <Separator />

        {/* Closing */}
        <section className="py-24">
          <Reveal stagger={90} className="container-page text-center">
            <div
              className="mx-auto flex justify-center gap-1.5"
              aria-hidden="true"
              style={order(0)}
            >
              {(
                [
                  ["circle", "#ff7a1a"],
                  ["drop", "#925df2"],
                  ["cloud", "#27baae"],
                  ["square", "#4b8efb"],
                  ["hexagon", "#ef479b"],
                ] as const
              ).map(([shape, color], i) => (
                <span
                  key={shape}
                  className="float inline-flex"
                  style={{ "--d": `${i * 380}ms` } as React.CSSProperties}
                >
                  <BotAvatar shape={shape} color={color} size={36} blink blinkDelay={i * 1300} />
                </span>
              ))}
            </div>
            <h2
              className="display mx-auto mt-6 max-w-[16ch] text-[44px] leading-[1.04] text-ink sm:text-[60px]"
              style={order(1)}
            >
              Don&apos;t rent an agent. Run one.
            </h2>
            <p
              className="mx-auto mt-5 max-w-[520px] text-[17px] leading-[1.55] text-ink-2 text-pretty"
              style={order(2)}
            >
              Your first bot is one command away. Install takes a few minutes. The first result
              usually takes less.
            </p>
            <div
              className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
              style={order(3)}
            >
              <InstallCommand />
              <Button
                variant="outline"
                size="lg"
                className={cn(bigCta, "gap-2 border-line-strong bg-surface")}
                render={<a href={GITHUB} />}
                nativeButton={false}
              >
                <GithubMark />
                Star on GitHub
              </Button>
            </div>
          </Reveal>
        </section>
      </main>

      <Separator />

      <footer>
        <div className="container-page flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Wordmark size={18} />
            <p className="mt-2 text-[13px] text-ink-3">Open source, self-hosted AI agents. Built in the open.</p>
          </div>
          <nav
            aria-label="Footer"
            className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-2"
          >
            <a className="py-2 hover:text-ink" href={GITHUB}>
              GitHub
            </a>
            <a className="py-2 hover:text-ink" href={INSTALL_GUIDE}>
              Download
            </a>
            <a className="py-2 hover:text-ink" href={`${GITHUB}/issues`}>
              Issues
            </a>
            <a className="py-2 hover:text-ink" href={`${GITHUB}/releases`}>
              Releases
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
