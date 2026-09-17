import { ArrowDown, ArrowUpRight, Server, Terminal } from "lucide-react";
import { SectionBot } from "@/components/section-bot";
import { GithubMark } from "@/components/brand";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { LandingEffects } from "@/components/landing-effects";
import { InstallCard } from "@/components/install-card";
import { ModelConnections } from "@/components/model-connections";
import { WorkerMemory } from "@/components/worker-memory";
import { ComputerWorkspace } from "@/components/computer-workspace";
import { AppConnections } from "@/components/app-connections";
import { MeetingRoutine } from "@/components/meeting-routine";
import { BotAvatar } from "@/components/bot-avatar";
import { ProductDemo } from "@/components/product-demo";
import { TeamWorkflowDemo } from "@/components/team-workflow-demo";
import { ComputerDemo, MobileDemo } from "@/components/app-demo-details";
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
import "./features.css";
import "./live-scenes.css";
import "./polish.css";
import "./mobile-polish.css";
import { WorkerProfiles } from "@/components/worker-showcase";

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
                <span className="ot-title-line">
                  <span>Run your own </span>
                </span>
                <span className="ot-title-line">
                  <span>AI team.</span>
                </span>
              </h1>
            </div>
            <div className="ot-hero-description">
              <p>
                Digital workers that run on <strong>your compute</strong> and work in your apps.
                They have their <strong>own computer and shared workspace</strong>, remember your
                instructions, and <strong>delegate work</strong> to each other.
              </p>
              <div className="ot-hero-actions">
                <GetStarted />
                <a href="#product" className="ot-text-link">
                  See it in action <ArrowDown size={15} />
                </a>
              </div>
            </div>
          </div>
          <div id="product" tabIndex={-1} className="ot-product-anchor">
            <ProductDemo />
          </div>
          <SectionBot bot="research" />
        </section>
        <nav className="ot-proof-strip ot-container" aria-label="Why run OpenTeam">
          <a href="#get-started">
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
        <section id="use-cases" className="ot-section ot-container ot-studio-section">
          <WorkerProfiles>
            <div className="ot-scene-copy">
              <h2>
                Build the team
                <br />
                <span>you need.</span>
              </h2>
              <p>
                Create specialized workers for the jobs you want to delegate. Give each one a role
                and its own instructions, then put your team to work on your own server.
              </p>
            </div>
          </WorkerProfiles>
        </section>
        <section id="capabilities" className="ot-section ot-container ot-machine-section">
          <ComputerWorkspace>
            <div className="ot-scene-copy">
              <h2>
                A computer
                <br />
                <span>of their own.</span>
              </h2>
              <p>
                Each worker has its own desktop and browser, with a shared workspace for files they
                use together. Give them access to your computer when a job needs local files or
                tools.
              </p>
            </div>
          </ComputerWorkspace>
        </section>
        <section id="plugins" className="ot-section ot-container ot-apps-section">
          <AppConnections>
            <div className="ot-scene-copy">
              <h2>
                Bring your
                <br />
                <span>apps and data.</span>
              </h2>
              <p>
                Give workers the context in your email, calendar, documents and meeting notes,
                alongside web search. Connect apps from the plugin marketplace, save workflows as
                reusable skills, or add your own tools through MCP.
              </p>
            </div>
          </AppConnections>
        </section>
        <section id="memory" className="ot-section ot-container ot-memory-section">
          <WorkerMemory>
            <div className="ot-scene-copy">
              <h2>
                They remember
                <br />
                <span>how you work.</span>
              </h2>
              <p>
                Workers pick up useful preferences and context as you work together, then bring
                those details into future conversations. Each has its own memory and can draw on
                shared knowledge, all stored as readable files on your compute.
              </p>
            </div>
          </WorkerMemory>
        </section>
        <section id="routines" className="ot-section ot-container ot-routine-section">
          <MeetingRoutine>
            <div className="ot-scene-copy">
              <h2>
                Leave recurring work
                <br />
                <span>to your team.</span>
              </h2>
              <p>
                Set the instructions once and choose when they run. A worker, or a group of them,
                handles the recurring work on schedule and delivers the result without a reminder
                from you.
              </p>
            </div>
          </MeetingRoutine>
        </section>
        <section id="how-it-works" className="ot-section ot-container ot-team-feature">
          <div className="ot-scene-copy ot-team-copy">
            <h2>
              Workers that
              <br />
              <span>help each other.</span>
            </h2>
            <p>
              Workers can share context and delegate parts of a job to each other or specialized
              helpers. Bring them into a group conversation to work together, each with its own
              instructions and memory.
            </p>
          </div>
          <div className="ot-team-stage">
            <TeamWorkflowDemo />
          </div>
        </section>
        <section id="control" className="ot-section ot-container ot-control-feature">
          <div className="ot-scene-copy">
            <h2>
              You stay
              <br />
              <span>in control.</span>
            </h2>
            <p>
              Choose what workers can do on their own and when they should ask you. Approve a step
              once or set rules for future work, and provide sensitive information privately.
            </p>
          </div>
          <div className="ot-control-stage">
            <ComputerDemo />
          </div>
        </section>
        <section
          id="mobile"
          aria-labelledby="mobile-heading"
          className="ot-section ot-container ot-mobile-section"
        >
          <div className="ot-mobile-copy ot-scene-copy">
            <h2 id="mobile-heading">
              Take your team
              <br />
              <span>with you.</span>
            </h2>
            <p>
              The desktop and iPhone apps connect to the same workers, conversations, and files, so
              you can pick up work wherever you are.
            </p>
            <a href="/download" className="ot-text-link">
              Get the apps <ArrowUpRight size={15} />
            </a>
          </div>
          <div className="ot-mobile-continuity">
            <div className="ot-desktop-receipt">
              <div>
                <BotAvatar shape="helmet" color="#ff7a1a" size={23} mode="still" />
                <strong>Research</strong>
                <span>Desktop</span>
              </div>
              <p>
                I saved the comparison in <strong>vendor-review.md.</strong>
              </p>
              <span className="ot-receipt-line" />
              <span className="ot-receipt-line" />
            </div>
            <div className="ot-device-sync" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <MobileDemo />
          </div>
        </section>
        <section id="open-source" className="ot-section ot-container ot-inference-feature">
          <div className="ot-scene-copy">
            <h2>
              Use the model
              <br />
              <span>you prefer.</span>
            </h2>
            <p>
              Sign in with ChatGPT or Claude, bring your own API keys, or connect a compatible
              hosted or local model.
            </p>
          </div>
          <ModelConnections />
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
        <section id="get-started" className="ot-start ot-container">
          <div className="ot-start-heading">
            <h2>
              One command
              <br />
              <span>to get started.</span>
            </h2>
            <div className="ot-start-intro">
              <p>
                Your computer or personal cloud. One installer to set up your server and connect
                your models.
              </p>
              <div className="ot-start-actions">
                <GetStarted />
                <a className="ot-install-guide" href="/install/source">
                  Read the install scripts <ArrowUpRight size={14} />
                </a>
              </div>
            </div>
          </div>
          <InstallCard />
        </section>
      </main>
      <SiteFooter home />
    </div>
  );
}
