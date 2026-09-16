import Image from "next/image";
import {
  ArrowDown,
  ArrowUpRight,
  FileText,
  GitBranch,
  Globe2,
  LockKeyhole,
  Monitor,
  Server,
  Terminal,
} from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { SectionBot } from "@/components/section-bot";
import { GithubMark } from "@/components/brand";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { LandingEffects } from "@/components/landing-effects";
import { InstallCard } from "@/components/install-card";
import { PluginsDemo } from "@/components/plugins-demo";
import { ProductDemo } from "@/components/product-demo";
import { DemoTaskLink } from "@/components/demo-task-link";
import { TeamWorkflowDemo } from "@/components/team-workflow-demo";
import { WorkerCapabilities } from "@/components/worker-capabilities";
import { MobileDemo } from "@/components/app-demo-details";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import "./landing.css";
import "./monochrome.css";
import "./structure.css";
import "./alive.css";

const GITHUB = "https://github.com/raghavpillai/openteam";
const questions = [
  [
    "What does OpenTeam do?",
    "OpenTeam lets you run your own team of AI agents. Give each agent a role, connect apps through plugins, and message agents individually or in group chats. They can browse the web, run code, share files, and delegate work to each other. Conversations and saved memory persist between tasks, and agents keep running while your server stays on.",
  ],
  [
    "What do I need to run it?",
    "A machine that stays on, a running Docker Engine with Compose 2.20+, and a supported model account, API key, or compatible endpoint. Linux can run the engine directly; Docker Desktop supplies it on macOS and Windows. We recommend 8 GB of RAM and 8 GB of free disk space. Guided setup installs the server; the desktop app connects to it.",
  ],
  [
    "Which model providers can I connect?",
    "Connect a ChatGPT Plus/Pro or Claude Pro/Max account, use an OpenAI or Anthropic API key, or configure an OpenAI-, Anthropic-, or Google-compatible endpoint. Claude sign-in uses paid extra usage. Model access and other usage limits depend on your provider and plan.",
  ],
  [
    "How do plugins work?",
    "Plugins connect workers to apps and tools. Install a connector from the catalog, connect accounts, and choose which workers may use each connection. Allow individual tools, require approval, or deny them. Add a custom MCP server for internal tools, and save reusable instructions as skills.",
  ],
  [
    "Can I watch or stop an agent?",
    "Yes. View its live screen, inspect its files, or stop its current run. Take over the mouse and keyboard to sign in or complete a step, then return control to the agent. You can also require approval for individual connected tools.",
  ],
  [
    "Will agents keep working when I close the app?",
    "Server-side turns and schedules continue while your server stays on. Keep the OpenTeam desktop app running when work needs its approval bridge: launching delegated tasks, including computer-use workers, or accessing your physical computer.",
  ],
  [
    "What does OpenTeam cost?",
    "There is no OpenTeam subscription. You pay for the machine that runs it and any charges from your model provider.",
  ],
  [
    "Where does my data live?",
    "Chats, saved memory, files, and browser sessions are stored on your server. Model requests go to the inference provider you connect, and plugins communicate with the services you enable.",
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
    <div className="landing ot-home" id="top">
      <LandingEffects />
      <a href="#main" className="ot-skip">
        Skip to content
      </a>
      <SiteHeader home />
      <main id="main">
        <section className="ot-hero ot-container ot-bot-section">
          <div className="ot-hero-top">
            <div>
              <a className="ot-eyebrow ot-release" href={`${GITHUB}/releases`}>
                <span className="ot-version">v0</span> OPEN SOURCE · SELF-HOSTED
                <ArrowUpRight size={13} />
              </a>
              <h1>
                <span className="ot-title-line"><span>Run your own </span></span>
                <span className="ot-title-line"><span>AI team.</span></span>
              </h1>
            </div>
            <div className="ot-hero-description">
              <p>
                Digital workers that run on <strong>your compute</strong> and work in your apps. They
                have their <strong>own computer and shared workspace</strong>, remember your
                instructions, and <strong>delegate work</strong> to each other.
              </p>
              <div className="ot-hero-actions">
                <GetStarted />
                <a href="#product" className="ot-text-link">
                  Try the demo <ArrowDown size={15} />
                </a>
              </div>
            </div>
          </div>
          <div id="product" tabIndex={-1} className="ot-product-anchor">
            <ProductDemo />
          </div>
          <div className="ot-demo-caption">
            <span>
              <Monitor size={14} /> Choose a task. Open its screen or generated file.
            </span>
            <span>Interactive product recreation · Sample tasks and data</span>
          </div>
          <SectionBot bot="research" />
        </section>
        <nav className="ot-proof-strip ot-container" aria-label="Why run OpenTeam">
          <a href="#open-source">
            <Server size={19} />
            <span>
              <strong>Your compute</strong>
              <small>Run on your computer or server</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href="#open-source">
            <Terminal size={19} />
            <span>
              <strong>Your inference</strong>
              <small>Connect the provider you choose</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href={GITHUB}>
            <GithubMark />
            <span>
              <strong>Open source</strong>
              <small>Read the code. Make it your own.</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
        </nav>
        <section id="use-cases" className="ot-use-cases ot-section ot-container ot-bot-section">
          <div className="ot-section-heading">
            <div>
              <h2>
                Delegate research,
                <br />
                <span>reporting, and code.</span>
              </h2>
            </div>
            <p>
              Get a sourced recommendation, a daily report, or a tested code change.
              Open a demo to see the work and its files.
            </p>
          </div>
          <div className="ot-jobs">
            {[
              {
                number: "01",
                task: "research" as const,
                shape: "helmet" as const,
                color: "#ff7a1a",
                name: "Research",
                title: "Compare vendors",
                result: "A comparison, recommendation, and source links.",
                icon: FileText,
                tags: "WEB + FILES",
              },
              {
                number: "02",
                task: "operations" as const,
                shape: "pod" as const,
                color: "#925df2",
                name: "Operations",
                title: "Check dashboards",
                result: "A daily report showing what changed.",
                icon: Globe2,
                tags: "BROWSER + ROUTINES",
              },
              {
                number: "03",
                task: "engineering" as const,
                shape: "chip" as const,
                color: "#27baae",
                name: "Engineering",
                title: "Fix failing tests",
                result: "A proposed fix, with the diff and test results.",
                icon: GitBranch,
                tags: "TERMINAL + CODE",
              },
            ].map((job) => (
              <article key={job.number} className="ot-job">
                <div className="ot-job-top">
                  <BotAvatar shape={job.shape} color={job.color} size={32} ambient />
                  <span>{job.name}</span>
                  <span className="ot-job-number">{job.number}</span>
                </div>
                <h3>{job.title}</h3>
                <div className="ot-job-result">
                  <job.icon size={17} />
                  <span>{job.result}</span>
                </div>
                <span className="ot-eyebrow ot-job-tags">{job.tags}</span>
                <DemoTaskLink task={job.task} className="ot-text-link ot-job-demo-link">
                  See {job.name.toLowerCase()} demo <ArrowUpRight size={15} />
                </DemoTaskLink>
              </article>
            ))}
          </div>
          <SectionBot bot="engineering" />
        </section>
        <section
          id="how-it-works"
          className="ot-section ot-container ot-team-section ot-bot-section"
        >
          <div className="ot-section-heading">
            <div>
              <h2>
                How your AI team
                <br />
                <span>works together.</span>
              </h2>
            </div>
            <p>
              Workers can message each other, delegate subtasks, and use the same project files.
            </p>
          </div>
          <div className="ot-team-explainer">
            <ol className="ot-team-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Give each worker a role.</h3>
                  <p>Define its responsibilities and save instructions it can reuse.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Connect apps and skills.</h3>
                  <p>Add plugins and choose which accounts each worker can access.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Let workers hand off tasks.</h3>
                  <p>
                    Put workers in a group chat to share context, delegate subtasks, and build
                    on each other&apos;s files.
                  </p>
                </div>
              </li>
            </ol>
            <TeamWorkflowDemo />
          </div>
          <SectionBot bot="research" side="right" />
        </section>
        <section id="plugins" className="ot-section ot-container ot-plugins ot-bot-section">
          <div className="ot-section-heading">
            <div>
              <h2>
                Connect your apps.
                <br />
                <span>Add reusable skills.</span>
              </h2>
            </div>
            <p>
              Give workers access to GitHub, Notion, Slack, and Linear. Plugins connect your
              accounts and add reusable skills. You choose which workers can use them.
            </p>
          </div>
          <PluginsDemo />
          <div className="ot-plugin-points">
            <article>
              <h3>Choose who can use each app.</h3>
              <p>
                Connect multiple accounts. Give Engineering access to GitHub and Research access to
                Notion. Allow individual tools, require approval, or deny them.
              </p>
            </article>
            <article>
              <h3>Save your team&apos;s instructions.</h3>
              <p>
                Ask a worker to save your research playbook, report format, or review checklist
                as a skill. The team can reuse it on future tasks.
              </p>
            </article>
            <article>
              <h3>Connect your own tools.</h3>
              <p>
                Add a remote MCP server or run a local one on the team&apos;s computer.
                Give workers tools for your internal systems and choose who can use them.
              </p>
            </article>
          </div>
          <a
            className="ot-text-link ot-plugins-source"
            href={`${GITHUB}/blob/main/apps/server/src/plugins/catalog.ts`}
          >
            View the plugin catalog source <ArrowUpRight size={16} />
          </a>
          <SectionBot bot="operations" side="right" />
        </section>
        <section
          id="capabilities"
          className="ot-section ot-container ot-worker-section ot-bot-section"
        >
          <div className="ot-section-heading">
            <div>
              <h2>
                A computer, memory,
                <br />
                <span>and a schedule.</span>
              </h2>
            </div>
            <p>Watch the screen, edit saved memory, or schedule recurring work. Try each below.</p>
          </div>
          <WorkerCapabilities />
          <SectionBot bot="operations" />
        </section>
        <section
          id="mobile"
          aria-labelledby="mobile-heading"
          className="ot-section ot-container ot-mobile-section"
        >
          <div className="ot-mobile-copy">
            <span className="ot-eyebrow">OPENTEAM FOR IPHONE</span>
            <h2 id="mobile-heading">
              Take your team<br />
              <span>with you.</span>
            </h2>
            <p>
              Send messages, review files, and follow the work from your iPhone.
              Pick up the same conversations you started on desktop, with the same
              workers on your server.
            </p>
            <p className="ot-mobile-availability">
              The iPhone app is currently available to build from source.
            </p>
            <a href="/download#mobile" className="ot-text-link">
              Get the iPhone app <ArrowUpRight size={15} />
            </a>
          </div>
          <MobileDemo />
        </section>
        <section
          id="open-source"
          className="ot-section ot-container ot-ownership-section ot-bot-section"
        >
          <div className="ot-ownership">
            <div>
              <h2>
                Your compute.
                <br />
                <span>Your workspace.</span>
              </h2>
              <a href={GITHUB} className="ot-text-link">
                <GithubMark /> View source on GitHub <ArrowUpRight size={16} />
              </a>
            </div>
            <div className="ot-ownership-facts">
              {[
                {
                  icon: LockKeyhole,
                  title: "Workspace stored on your server.",
                  text: "Chats, memory, files, and browser profiles live on your server. Model requests go to the provider you choose.",
                },
                {
                  icon: Server,
                  title: "Run on the machine you choose.",
                  text: "Use Docker Compose on a VPS, home server, or spare machine. You control where OpenTeam runs.",
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
          </div>
          <div
            className="ot-providers ot-ownership-providers"
            aria-label="Supported model providers"
          >
            <p>
              <strong>Bring your own inference.</strong>
            </p>
            <div className="ot-provider-logo ot-provider-openai">
              <Image src="/logos/openai.svg" alt="OpenAI" width={1604} height={718} unoptimized />
            </div>
            <div className="ot-provider-logo ot-provider-anthropic">
              <Image
                src="/logos/anthropic.svg"
                alt="Anthropic"
                width={570}
                height={64}
                unoptimized
              />
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
          </div>
          <SectionBot bot="engineering" side="right" />
        </section>
        <section id="faq" className="ot-section ot-container ot-faq ot-bot-section">
          <div>
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
          <SectionBot bot="operations" side="right" />
        </section>
        <section id="get-started" className="ot-start ot-container ot-bot-section">
          <div>
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
          <InstallCard />
          <SectionBot bot="research" />
        </section>
      </main>
      <SiteFooter home />
    </div>
  );
}
