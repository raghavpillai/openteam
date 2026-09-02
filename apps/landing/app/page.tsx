import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const faqs = [
  {
    question: "What do I need to install it?",
    answer:
      "Docker with Compose is the only system prerequisite for the released stack. The CLI checks the host, creates private installation secrets, pulls the versioned services, starts them, and waits for health. Setup then creates your owner account and configures your chosen inference provider.",
  },
  {
    question: "What keeps running when I close the app?",
    answer:
      "The server, worker, agent sessions, schedules, and graphical computer keep running in the self-hosted stack. The desktop and iPhone apps are clients you can close and return to later.",
  },
  {
    question: "What survives a restart?",
    answer:
      "OpenBot preserves each Bot's session, visible chat, memory, browser profile, and shared workspace. The stack reopens that working state after service or host restarts instead of sending the Bot back to a blank conversation.",
  },
  {
    question: "Where do my model credentials live?",
    answer:
      "Your provider credential stays inside the private computer service and its persistent volume. Agent shells, the desktop app, and the iPhone app cannot read it.",
  },
  {
    question: "Can I watch or take over a Bot's computer?",
    answer:
      "Yes. Open a Bot's live Linux screen to watch its browser, files, or terminal. You can take control when a sign-in, approval, or judgment call needs you.",
  },
];

function Brand() {
  return (
    <span className="brand-lockup">
      <span className="brand-mark">
        <span />
        <span />
      </span>
      <span>openbot</span>
    </span>
  );
}

function ProductCapture({
  src,
  alt,
  width,
  height,
  label,
  className = "",
  priority = false,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  label: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <figure className={`product-capture ${className}`}>
      <div className="capture-label">
        <span>
          <i /> Actual product UI
        </span>
        <b>{label}</b>
      </div>
      <div className="capture-viewport">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          sizes="(max-width: 640px) 92vw, (max-width: 920px) 78vw, 52vw"
          priority={priority}
        />
      </div>
      <figcaption>Captured from OpenBot with demo workspace data.</figcaption>
    </figure>
  );
}

export default function Home() {
  return (
    <main>
      <header className="site-nav">
        <a className="brand" href="#top" aria-label="OpenBot home">
          <Brand />
        </a>
        <nav className="nav-links" aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#features">Why it works</a>
          <a href="#get-started">Install</a>
        </nav>
        <Button asChild variant="outline" size="sm" className="nav-cta">
          <a href="https://github.com/raghavpillai/openbot">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </Button>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow hero-glow-one" />
        <div className="hero-glow hero-glow-two" />
        <Badge variant="outline" className="eyebrow">
          <span /> Self-hosted agents that keep working
        </Badge>
        <h1>
          Hand off the work.
          <br />
          <em>Come back to the result.</em>
        </h1>
        <p className="hero-copy">
          OpenBot gives AI agents a persistent computer, shared files, and enough time to finish the
          job. They keep working on your hardware after you close the app, and you can inspect or
          take over at any point.
        </p>
        <div className="hero-actions">
          <Button asChild size="lg">
            <a href="#get-started">
              <span className="github-glyph" aria-hidden="true">
                ⌘
              </span>{" "}
              Install OpenBot
            </a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href="#product">
              <span className="play-glyph" aria-hidden="true">
                ▶
              </span>{" "}
              See a job run
            </a>
          </Button>
        </div>
        <div className="hero-note">
          <span>Your server keeps the job running</span>
          <i /> <span>Desktop and iPhone keep you in control</span>
        </div>

        <div className="product-stage" id="product">
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <ProductCapture
            src="/screenshots/openbot-desktop-live.jpeg"
            alt="The real OpenBot desktop app showing a live multi-Bot conversation and its member panel"
            width={768}
            height={846}
            label="Desktop app"
            className="hero-desktop-capture"
            priority
          />
          <ProductCapture
            src="/screenshots/openbot-mobile-chat.png"
            alt="The real OpenBot iPhone app showing a conversation and an approval request"
            width={1206}
            height={2622}
            label="iPhone app"
            className="hero-phone-capture"
            priority
          />
        </div>
      </section>

      <section className="promise-strip" aria-label="OpenBot principles">
        <p>Work continues after you leave.</p>
        <span />
        <p>Files land in a shared workspace.</p>
        <span />
        <p>Watch every step or take control.</p>
      </section>

      <section className="features-section section-shell" id="features">
        <div className="section-heading">
          <Badge variant="warm">WHAT FINISHING THE JOB REQUIRES</Badge>
          <h2>
            Give agents the things
            <br />a chat window cannot.
          </h2>
          <p>
            A useful agent needs continuity, tools, somewhere to put the output, and a clear way for
            you to step in. OpenBot provides that working environment on a machine you control.
          </p>
        </div>

        <div className="feature-grid">
          <Card className="feature-card feature-card-wide computer-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                01
              </Badge>
              <h3>A computer they can actually use.</h3>
              <p>
                A Bot can browse the web, work in a terminal, and read or write shared files on its
                own Linux display. Watch live, or take control when a login or judgment call needs
                you.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual wide-screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-mobile-computer.png"
                alt="The real OpenBot iPhone computer view showing a Bot's Linux terminal and takeover controls"
                width={1206}
                height={2622}
                label="Live computer"
                className="card-capture phone-crop computer-crop"
              />
            </CardContent>
          </Card>

          <Card className="feature-card memory-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                02
              </Badge>
              <h3>Tomorrow starts where today stopped.</h3>
              <p>
                OpenBot reopens the same session, memory, browser profile, and workspace after a
                restart. You spend less time repeating context, and unfinished work can resume.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-mobile-home.png"
                alt="The real OpenBot iPhone home screen showing persistent Research, Ops, and Build Bots"
                width={1206}
                height={2622}
                label="Persistent Bots"
                className="card-capture phone-crop home-crop"
              />
            </CardContent>
          </Card>

          <Card className="feature-card team-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                03
              </Badge>
              <h3>One lead can divide the work.</h3>
              <p>
                Put several Bots in one room, or let a lead create private subagents for parallel
                research and verification. You get one coordinated result instead of disconnected
                chats.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-desktop-live.jpeg"
                alt="The real OpenBot desktop app showing a live multi-Bot room and its member panel"
                width={768}
                height={846}
                label="Multi-Bot room"
                className="card-capture desktop-crop team-crop"
              />
            </CardContent>
          </Card>

          <Card className="feature-card feature-card-wide routine-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                04
              </Badge>
              <h3>Recurring work runs without a reminder.</h3>
              <p>
                Schedule a brief, follow-up, or audit once. The same Bot wakes with its existing
                context, runs the job, and leaves an execution history plus the output for you to
                review.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual wide-screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-mobile-routine.png"
                alt="The real OpenBot iPhone routine editor showing its schedule, run action, and recent run history"
                width={1206}
                height={2622}
                label="Routine editor"
                className="card-capture phone-crop routine-crop"
              />
            </CardContent>
          </Card>

          <Card className="feature-card anywhere-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                05
              </Badge>
              <h3>Check the work without staying at your desk.</h3>
              <p>
                Use the iPhone app to see progress, search, reply, approve actions, and open a
                Bot&apos;s live computer. Step in only when the job needs you.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-mobile-search.png"
                alt="The real OpenBot iPhone search interface showing recent conversations across Bots"
                width={1206}
                height={2622}
                label="iPhone search"
                className="card-capture phone-crop search-crop"
              />
            </CardContent>
          </Card>

          <Card className="feature-card plugins-feature">
            <CardHeader className="feature-copy">
              <Badge variant="outline" className="number-badge">
                06
              </Badge>
              <h3>Adapt the agents to your work.</h3>
              <p>
                Connect tools through MCP plugins, turn repeatable instructions into saved skills,
                and edit project or user memory as ordinary files. Your operating knowledge stays
                with the system you run.
              </p>
            </CardHeader>
            <CardContent className="feature-visual screenshot-visual">
              <ProductCapture
                src="/screenshots/openbot-desktop-plugins.png"
                alt="The real OpenBot desktop plugin settings interface with connector, account, Bot access, and tool policy controls"
                width={1228}
                height={768}
                label="Plugin settings"
                className="card-capture desktop-crop"
              />
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="self-hosted-section" id="self-hosted">
        <div className="self-hosted-inner section-shell">
          <div className="self-copy">
            <Badge variant="outline">CONTROL WITHOUT GIVING UP CONTINUITY</Badge>
            <h2>
              Keep the work running
              <br />
              where you can
              <br />
              <em>inspect it.</em>
            </h2>
            <p>
              OpenBot runs the server, worker, database, and graphical computer as a private Docker
              Compose stack. The desktop and iPhone apps are clients; the jobs and model sign-in
              stay on the infrastructure you operate.
            </p>
            <ul>
              <li>
                <i>✓</i>
                <span>
                  <strong>Close the app, not the job</strong>
                  <small>
                    The server and worker keep active turns and routines moving while the clients
                    are closed.
                  </small>
                </span>
              </li>
              <li>
                <i>✓</i>
                <span>
                  <strong>Keep model credentials out of the clients</strong>
                  <small>
                    Your provider credential stays inside the private computer service rather than
                    the desktop or iPhone app.
                  </small>
                </span>
              </li>
              <li>
                <i>✓</i>
                <span>
                  <strong>Back up the whole working state</strong>
                  <small>
                    Sessions, messages, memory, browser profiles, and shared files live in
                    persistent stores you can inspect and recover together.
                  </small>
                </span>
              </li>
            </ul>
          </div>

          <div className="architecture-card" aria-label="OpenBot self-hosted architecture">
            <div className="arch-top">
              <span>YOUR DEVICES</span>
              <small>private clients</small>
            </div>
            <div className="device-row">
              <div>
                <b>▣</b>
                <span>Desktop</span>
              </div>
              <div>
                <b>▯</b>
                <span>iPhone</span>
              </div>
            </div>
            <div className="arch-flow">
              <span>authenticated connection</span>
            </div>
            <div className="server-box">
              <div className="server-title">
                <span className="brand-mark">
                  <span />
                  <span />
                </span>
                <span>
                  <strong>Your OpenBot stack</strong>
                  <small>Docker Compose · your hardware</small>
                </span>
                <b>PRIVATE</b>
              </div>
              <div className="service-grid">
                <div>
                  <span className="service-icon">↯</span>
                  <strong>Worker</strong>
                  <small>runs queued jobs</small>
                </div>
                <div>
                  <span className="service-icon">▤</span>
                  <strong>Postgres</strong>
                  <small>messages + schedules</small>
                </div>
                <div>
                  <span className="service-icon">⌘</span>
                  <strong>Agent runtime</strong>
                  <small>Pi sessions + inference</small>
                </div>
                <div>
                  <span className="service-icon">◫</span>
                  <strong>Linux desktop</strong>
                  <small>browser + files</small>
                </div>
              </div>
              <div className="volume-row">
                <span>Your durable state</span>
                <div>
                  <b>/workspace</b>
                  <b>sessions</b>
                  <b>memory</b>
                  <b>browser profiles</b>
                </div>
              </div>
            </div>
            <div className="arch-footer">
              <span className="pulse-dot" /> Running independently of the clients{" "}
              <b>Ready for work</b>
            </div>
          </div>
        </div>
      </section>

      <section className="work-section section-shell">
        <div className="section-heading compact-heading">
          <Badge variant="warm">START WITH A CLEAR DEFINITION OF DONE</Badge>
          <h2>
            Give OpenBot the jobs
            <br />
            that should end in a file.
          </h2>
          <p>
            The best first jobs have a clear input, a concrete output, and enough steps to benefit
            from a computer that stays available.
          </p>
        </div>
        <div className="work-grid">
          <Card className="work-card mint-work">
            <span>01</span>
            <h3>Research with receipts</h3>
            <p>
              Give a Bot a source folder and a question. It can browse, compare claims, write the
              report, and save it beside the source notes so you can check the work.
            </p>
            <div className="work-tags">
              <b>Report</b>
              <b>Source trail</b>
              <b>Shared files</b>
            </div>
          </Card>
          <Card className="work-card cream-work">
            <span>02</span>
            <h3>Recurring work without reminders</h3>
            <p>
              Schedule a brief, follow-up, or audit once. Each run uses the Bot&apos;s existing
              context, records what happened, and leaves the new output ready to review.
            </p>
            <div className="work-tags">
              <b>Scheduled</b>
              <b>Run history</b>
              <b>Reviewable output</b>
            </div>
          </Card>
          <Card className="work-card blue-work">
            <span>03</span>
            <h3>One owner for a multi-agent job</h3>
            <p>
              Ask a lead Bot to split a larger goal across specialists. The lead gathers the work
              and returns one coordinated result with the activity trail behind it.
            </p>
            <div className="work-tags">
              <b>Lead Bot</b>
              <b>Parallel work</b>
              <b>One result</b>
            </div>
          </Card>
        </div>
      </section>

      <section className="faq-section section-shell">
        <div className="faq-intro">
          <Badge variant="outline">BEFORE YOU INSTALL</Badge>
          <h2>
            Know what
            <br />
            you are running.
          </h2>
          <p>
            OpenBot is a self-hosted v0 for people comfortable running Docker. These are the
            practical details that matter before you give it real work.
          </p>
        </div>
        <div className="faq-list">
          {faqs.map((faq, index) => (
            <details key={faq.question} open={index === 0}>
              <summary>
                <span>{faq.question}</span>
                <i>+</i>
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="get-started-section section-shell" id="get-started">
        <div className="cta-glow" />
        <Badge variant="outline">DOCKER IS THE ONLY SYSTEM PREREQUISITE</Badge>
        <h2>
          Install it.
          <br />
          <em>Give one Bot a real job.</em>
        </h2>
        <p>
          The CLI pulls the released services, starts the private stack, checks its health, and then
          walks you through your owner account and inference-provider sign-in.
        </p>
        <div className="install-command">
          <span>$</span>
          <code>bunx --bun @openbot/cli install</code>
          <b>⌘C</b>
        </div>
        <div className="cta-actions">
          <Button asChild size="lg">
            <a href="https://github.com/raghavpillai/openbot#install-the-released-server-stack">
              Open the install guide <span aria-hidden="true">↗</span>
            </a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href="https://github.com/raghavpillai/openbot">Browse the source</a>
          </Button>
        </div>
      </section>

      <footer>
        <div className="footer-inner section-shell">
          <a href="#top" className="footer-brand">
            <Brand />
            <small>Agents that keep working on your hardware.</small>
          </a>
          <div className="footer-links">
            <a href="#features">Features</a>
            <a href="#self-hosted">Self-hosted</a>
            <a href="https://github.com/raghavpillai/openbot">GitHub</a>
          </div>
          <p>Open source. Built on Pi with your choice of inference provider.</p>
        </div>
      </footer>
    </main>
  );
}
