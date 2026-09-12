import Image from "next/image";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Code2,
  FileText,
  GitBranch,
  Globe2,
  HardDrive,
  LockKeyhole,
  Monitor,
  Server,
  Smartphone,
  Terminal,
} from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { GithubMark } from "@/components/brand";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { LandingEffects } from "@/components/landing-effects";
import { InstallCommand } from "@/components/install-command";
import { PluginsDemo } from "@/components/plugins-demo";
import {
  ProductDemo,
  ComputerDemo,
  RoutineDemo,
  MobileDemo,
  MemoryDemo,
} from "@/components/product-demo";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import "./landing.css";
import "./monochrome.css";

const GITHUB = "https://github.com/raghavpillai/openteam";
const questions = [
  [
    "What does OpenTeam do?",
    "OpenTeam is a self-hosted workspace for AI agents. Each agent has a role and an ongoing conversation. Agents can browse the web, run code, and create files on a persistent Linux computer. Conversations, memory, and browser profiles stay on your server between tasks.",
  ],
  [
    "What do I need to run it?",
    "A machine that stays on, Docker with Compose 2.20+, and a supported model account, API key, or compatible endpoint. A VPS, home server, or spare Mac works. We recommend 8 GB of RAM and 8 GB of free disk space. Guided setup installs the server; the desktop app connects to it.",
  ],
  [
    "Which model providers can I connect?",
    "Connect a ChatGPT Plus/Pro or Claude Pro/Max account, use an OpenAI or Anthropic API key, or configure an OpenAI-, Anthropic-, or Google-compatible endpoint. Usage limits and model access depend on your provider and plan.",
  ],
  [
    "How do plugins work?",
    "Plugins add app connections, reusable skills, or both. Install a bundled package or import your own, connect any required accounts, and choose which agents can use them. Tool policies let you allow a call, require approval, or deny it. You can also add a compatible MCP server and create private skills in the app.",
  ],
  [
    "Can I watch or stop an agent?",
    "Yes. View its live screen, inspect its files, or stop its current run. Take over the mouse and keyboard to sign in or complete a step, then return control to the agent. You can also require approval for individual connected tools.",
  ],
  [
    "Will agents keep working when I close the app?",
    "Yes, as long as your server stays on. Agents and scheduled tasks run on the server. The desktop and iPhone apps are clients, so closing an app does not stop a job.",
  ],
  [
    "What does OpenTeam cost?",
    "There is no OpenTeam subscription. You pay for the machine that runs it and any charges from your model provider.",
  ],
  [
    "How mature is OpenTeam?",
    "OpenTeam is early software for people comfortable with Docker and a terminal. The desktop app supports macOS, Windows, and Linux; check the download page for available builds. The iPhone app must currently be built from source. It is not available through the App Store or TestFlight.",
  ],
];
function GetStarted({
  children = "Install OpenTeam",
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Button
      className={`ot-button ${className}`}
      render={<a href="/download" />}
      nativeButton={false}
    >
      {children}
      <ArrowUpRight size={17} />
    </Button>
  );
}
export default function Home() {
  return (
    <div className="landing" id="top">
      <LandingEffects />
      <a href="#main" className="ot-skip">
        Skip to content
      </a>
      <SiteHeader home />
      <main id="main">
        <section className="ot-hero ot-container">
          <div className="ot-hero-top">
            <div>
              <a className="ot-eyebrow ot-release" href={`${GITHUB}/releases`}>
                <span className="ot-version">v0</span> OPEN SOURCE · SELF-HOSTED
                <ArrowUpRight size={13} />
              </a>
              <h1>
                AI agents with
                <br />
                <span>computer access.</span>
              </h1>
            </div>
            <div className="ot-hero-description">
              <p>
                Message an agent to research vendors, check dashboards, or fix a failing test.
                Agents use a Linux computer, plugins, and reusable skills to do the work on your
                server, even after you close the app.
              </p>
              <div className="ot-hero-actions">
                <GetStarted />
                <a href="#product" className="ot-text-link">
                  Try the demo <ArrowDown size={15} />
                </a>
              </div>
              <p className="ot-hero-note">Docker required · Bring your own inference</p>
            </div>
          </div>
          <div id="product" className="ot-product-anchor">
            <ProductDemo />
          </div>
          <div className="ot-demo-caption">
            <span>
              <Monitor size={14} /> Chat, task progress, and generated files.
            </span>
            <span>Interactive product recreation · Sample tasks and data</span>
          </div>
        </section>
        <section className="ot-providers ot-container" aria-label="Supported model providers">
          <p>
            <strong>Bring your own inference.</strong>
          </p>
          <div className="ot-provider-logo ot-provider-openai">
            <Image src="/logos/openai.svg" alt="OpenAI" width={1604} height={718} unoptimized />
          </div>
          <div className="ot-provider-logo ot-provider-anthropic">
            <Image src="/logos/anthropic.svg" alt="Anthropic" width={570} height={64} unoptimized />
          </div>
          <div className="ot-provider-logo ot-provider-google">
            <Image src="/logos/google.svg" alt="Google" width={74} height={24} unoptimized />
          </div>
          <div className="ot-provider-endpoint">
            <Terminal size={22} />
            <span>
              Compatible
              <br />
              endpoint
            </span>
          </div>
        </section>
        <section id="plugins" className="ot-section ot-container ot-plugins">
          <div className="ot-section-heading">
            <div>
              <p className="ot-eyebrow">PLUGINS</p>
              <h2>
                Connect your apps.
                <br />
                <span>Add reusable skills.</span>
              </h2>
            </div>
            <p>
              Connect GitHub, Notion, Slack, and Linear. Choose which accounts each agent can use,
              and which tools need your approval.
            </p>
          </div>
          <PluginsDemo />
          <div className="ot-plugin-points">
            <article>
              <h3>Control agent access.</h3>
              <p>
                Connect multiple accounts. Give Engineering access to GitHub and Research access to
                Notion. Allow individual tools, require approval, or deny them.
              </p>
            </article>
            <article>
              <h3>Save your team&apos;s instructions.</h3>
              <p>
                Save instructions and supporting files as a skill. Reuse your research playbook,
                report format, or review checklist across the agents you choose.
              </p>
            </article>
            <article>
              <h3>Build your own plugins.</h3>
              <p>
                Add an MCP server or package tools and skills together. Import a folder or ZIP, edit
                and test in the app, then export the package to share it.
              </p>
            </article>
          </div>
          <a
            className="ot-text-link ot-plugins-source"
            href={`${GITHUB}/tree/main/packages/plugins`}
          >
            Browse bundled plugins <ArrowUpRight size={16} />
          </a>
        </section>
        <section id="how-it-works" className="ot-section ot-container">
          <div className="ot-section-heading">
            <div>
              <p className="ot-eyebrow">EXAMPLE TASKS</p>
              <h2>
                Delegate research,
                <br />
                <span>reporting, and code.</span>
              </h2>
            </div>
            <p>
              Send a request in chat. Follow the agent&apos;s progress, then review its reports,
              source links, or code changes in your workspace.
            </p>
          </div>
          <div className="ot-jobs">
            {[
              {
                number: "01",
                shape: "helmet" as const,
                color: "#ff7a1a",
                name: "Research",
                request:
                  "Compare these vendors on price and features. Recommend one and cite your sources.",
                result: "A comparison, recommendation, and source links.",
                icon: FileText,
                tags: "WEB + FILES",
              },
              {
                number: "02",
                shape: "pod" as const,
                color: "#925df2",
                name: "Operations",
                request: "Check the dashboards every morning. Flag what changed.",
                result: "A daily report showing what changed.",
                icon: Globe2,
                tags: "BROWSER + ROUTINES",
              },
              {
                number: "03",
                shape: "chip" as const,
                color: "#27baae",
                name: "Engineering",
                request: "Run the tests, fix the failure, and show me the diff.",
                result: "A proposed fix, with the diff and test results.",
                icon: GitBranch,
                tags: "TERMINAL + CODE",
              },
            ].map((job) => (
              <article key={job.number} className="ot-job">
                <div className="ot-job-top">
                  <BotAvatar shape={job.shape} color={job.color} size={32} mode="idle" />
                  <span>{job.name}</span>
                  <span className="ot-job-number">{job.number}</span>
                </div>
                <h3>“{job.request}”</h3>
                <div className="ot-job-result">
                  <job.icon size={17} />
                  <span>{job.result}</span>
                </div>
                <span className="ot-eyebrow ot-job-tags">{job.tags}</span>
              </article>
            ))}
          </div>
        </section>
        <section className="ot-capabilities ot-container">
          <div className="ot-section-heading">
            <div>
              <p className="ot-eyebrow">AGENT CAPABILITIES</p>
              <h2>
                Computer access.
                <br />
                <span>Memory. Scheduled tasks.</span>
              </h2>
            </div>
          </div>
          <div className="ot-computer-row">
            <div className="ot-feature-copy">
              <div className="ot-feature-icon">
                <Monitor size={23} />
              </div>
              <h3>
                Watch the screen.
                <br />
                Take control when needed.
              </h3>
              <p>
                Agents use Chromium, a terminal, and a shared filesystem. Each agent has its own
                screen and browser profile.
              </p>
              <p>
                Watch the live screen. When an agent needs you to sign in, take control of the mouse
                and keyboard, then resume the task.
              </p>
              <a className="ot-text-link" href="#product">
                View the demo workspace <ArrowUpRight size={16} />
              </a>
            </div>
            <ComputerDemo />
          </div>
          <div className="ot-persistence-grid">
            <article className="ot-memory-card">
              <div className="ot-card-copy">
                <span className="ot-eyebrow">PERSISTENT CONTEXT</span>
                <h3>
                  Saved conversations.
                  <br />
                  Persistent memory.
                </h3>
                <p>
                  Each agent keeps its conversation, saved notes, and browser profile between tasks
                  and server restarts.
                </p>
              </div>
              <MemoryDemo />
            </article>
            <article className="ot-routine-card">
              <div className="ot-card-copy">
                <span className="ot-eyebrow">SCHEDULED TASKS</span>
                <h3>
                  Run tasks
                  <br />
                  on a schedule.
                </h3>
                <p>
                  Ask an agent to check your dashboards every morning or prepare a weekly report.
                  Set a schedule, then review each run in its conversation and run history.
                </p>
              </div>
              <RoutineDemo />
            </article>
          </div>
          <div className="ot-small-features ot-shared-features">
            {[
              {
                icon: HardDrive,
                title: "Share files across agents.",
                text: "Save a brief with one agent and ask another to work from it. Both can read and update the same workspace files.",
              },
              {
                icon: Code2,
                title: "Coordinate multiple agents.",
                text: "Put agents in a group chat. They can message each other and delegate subtasks.",
              },
            ].map((item) => (
              <div key={item.title}>
                <item.icon size={22} />
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="ot-anywhere">
          <div className="ot-container ot-anywhere-inner">
            <div className="ot-anywhere-copy">
              <p className="ot-eyebrow">DESKTOP + IPHONE</p>
              <h2>
                Close the app.
                <br />
                Agents keep running.
              </h2>
              <p>
                Jobs run on your server while it stays on. Use the desktop or iPhone app to check
                progress, review files, and send the next task.
              </p>
              <div className="ot-platforms">
                <span>
                  <Monitor size={17} /> macOS, Windows, Linux
                </span>
                <span>
                  <Smartphone size={17} /> iPhone · build from source
                </span>
              </div>
              <GetStarted />
            </div>
            <MobileDemo />
          </div>
        </section>
        <section id="open-source" className="ot-section ot-container ot-ownership">
          <div>
            <p className="ot-eyebrow">OPEN SOURCE + SELF-HOSTED</p>
            <h2>
              Run OpenTeam
              <br />
              <span>on your server.</span>
            </h2>
            <a href={GITHUB} className="ot-text-link">
              <GithubMark /> View source on GitHub <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="ot-ownership-facts">
            {[
              {
                icon: Server,
                title: "Deploy with Docker.",
                text: "Run OpenTeam with Docker Compose on a VPS, home server, or spare Mac.",
              },
              {
                icon: LockKeyhole,
                title: "Workspace stored on your server.",
                text: "Chats, memory, files, and browser profiles live on your server. Model requests go to the provider you choose.",
              },
              {
                icon: Terminal,
                title: "Choose your inference provider.",
                text: "Connect ChatGPT or Claude, use an OpenAI or Anthropic API key, or configure a compatible model endpoint.",
              },
              {
                icon: GitBranch,
                title: "Read and modify the code.",
                text: "Inspect the server, runtime, and apps. Build plugins, add skills, or modify the source.",
              },
            ].map((item) => (
              <article key={item.title}>
                <item.icon size={21} />
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="ot-start ot-container">
          <div>
            <p className="ot-eyebrow">GET STARTED</p>
            <h2>
              Install OpenTeam.
              <br />
              Connect your model.
            </h2>
            <p>
              No OpenTeam subscription.
              <br />
              You pay for hosting and model usage.
            </p>
            <GetStarted />
            <a className="ot-install-guide" href="/install/source">
              Read the install scripts <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="ot-setup">
            <div className="ot-terminal-heading">
              <Terminal size={16} />
              <span>Run on your server</span>
              <span>~/</span>
            </div>
            <div className="ot-setup-command">
              <InstallCommand />
            </div>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Install the server</strong>
                  <p>Run guided setup on the machine that will host your agents.</p>
                </div>
                <Check size={16} />
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Connect your model</strong>
                  <p>
                    Sign in to a supported account, add an API key, or use a compatible endpoint.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Create your first agent</strong>
                  <p>Connect the desktop app to your server and send your first task.</p>
                </div>
              </li>
            </ol>
            <p className="ot-setup-note">
              <Server size={14} /> Docker Compose 2.20+ · 8 GB RAM recommended
            </p>
          </div>
        </section>
        <section id="faq" className="ot-section ot-container ot-faq">
          <div>
            <p className="ot-eyebrow">FAQ</p>
            <h2>
              Setup, models,
              <br />
              <span>and costs.</span>
            </h2>
            <a className="ot-text-link" href={`${GITHUB}/issues`}>
              Ask a question on GitHub <ArrowUpRight size={15} />
            </a>
          </div>
          <Accordion>
            {questions.map(([q, a]) => (
              <AccordionItem key={q} value={q}>
                <AccordionTrigger className="ot-faq-trigger">{q}</AccordionTrigger>
                <AccordionContent className="ot-faq-answer">{a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      </main>
      <SiteFooter home />
    </div>
  );
}
