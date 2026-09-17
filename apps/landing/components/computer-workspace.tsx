"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, Camera, Check, ChevronDown, ChevronRight, Eye, FileJson, FileText,
  Folder, FolderOpen, Globe, Image as ImageIcon, LockKeyhole, MousePointer2, RotateCw,
  PencilLine, ShieldCheck, Sparkles,
} from "lucide-react";
import { BotAvatar } from "./bot-avatar";
import { useDemoCycle } from "./use-demo-cycle";
import "./computer-workspace.css";

const workers = [
  { name: "Research", shape: "helmet", color: "#ff7a1a" },
  { name: "Finance", shape: "chip", color: "#27baae" },
] as const;

const steps = [
  { target: "monthly", action: "Reading the pricing page", file: "requirements.md" },
  { target: "annual", action: "Comparing annual pricing", file: "brief.md" },
  { target: "sso", action: "Checking single sign-on on Growth", file: "requirements.md" },
  { target: "capture", action: "Saving a screenshot of the plans", file: "pricing.png" },
  { target: "price", action: "Saving prices and plan features", file: "vendor-pricing.json" },
  { target: "sso", action: "Finance is reviewing the total cost", file: "cost-review.md" },
  { target: "price", action: "Comparison ready in your shared workspace", file: "recommendation.md" },
] as const;

type FileActivity = { file: string; worker: 0 | 1; action: "Viewing" | "Editing" | "Saving" };
const fileActivity: readonly FileActivity[][] = [
  [{ file: "requirements.md", worker: 0, action: "Viewing" }],
  [{ file: "brief.md", worker: 0, action: "Viewing" }],
  [{ file: "requirements.md", worker: 0, action: "Viewing" }, { file: "company-context.md", worker: 1, action: "Viewing" }],
  [{ file: "pricing.png", worker: 0, action: "Saving" }],
  [{ file: "vendor-pricing.json", worker: 0, action: "Editing" }, { file: "vendor-pricing.json", worker: 1, action: "Viewing" }],
  [{ file: "vendor-pricing.json", worker: 1, action: "Viewing" }, { file: "cost-review.md", worker: 1, action: "Editing" }],
  [{ file: "recommendation.md", worker: 0, action: "Editing" }, { file: "cost-review.md", worker: 1, action: "Viewing" }],
];

type FileNode = {
  name: string;
  kind: "folder" | "md" | "json" | "png";
  createdAt?: number;
  children?: FileNode[];
};

// Keep the server's shared / projects / bots structure. Outputs accumulate as the demo runs.
const workspace: FileNode[] = [
  { name: "shared", kind: "folder", children: [
    { name: "company-context.md", kind: "md" },
    { name: "requirements.md", kind: "md" },
  ] },
  { name: "projects", kind: "folder", children: [
    { name: "vendor-review", kind: "folder", children: [
      { name: "brief.md", kind: "md" },
      { name: "pricing.png", kind: "png", createdAt: 3 },
      { name: "vendor-pricing.json", kind: "json", createdAt: 4 },
      { name: "cost-review.md", kind: "md", createdAt: 5 },
      { name: "recommendation.md", kind: "md", createdAt: 6 },
    ] },
  ] },
  { name: "bots", kind: "folder" },
];

function WorkspaceTree({ nodes, step, depth = 0 }: { nodes: FileNode[]; step: number; depth?: number }) {
  return (
    <ul className="cw-tree-branch">
      {nodes.filter((node) => node.createdAt === undefined || step >= node.createdAt).map((node) => {
        const activity = fileActivity[step].filter((item) => item.file === node.name);
        const active = activity.length > 0;
        const justCreated = node.createdAt === step;
        const Icon = node.kind === "folder" ? (node.children ? FolderOpen : Folder)
          : node.kind === "json" ? FileJson : node.kind === "png" ? ImageIcon : FileText;
        return (
          <li key={node.name} className={node.createdAt === undefined ? undefined : "cw-created-file"}>
            <div className="cw-file-row" data-active={active} data-new={justCreated} data-kind={node.kind}
              style={{ "--file-depth": depth } as CSSProperties}>
              <span className="cw-file-name">
                <span className="cw-disclosure" aria-hidden="true">
                  {node.kind === "folder" && (node.children ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
                </span>
                <Icon className="cw-file-icon" size={16} aria-hidden="true" />
                <span>{node.name}</span>
              </span>
              {active && (
                <span className="cw-file-presence">
                  {activity.map((item) => (
                    <span className="cw-file-person" key={item.worker} data-action={item.action}>
                      <BotAvatar {...workers[item.worker]} size={17} mode="thinking" />
                      <strong>{workers[item.worker].name}</strong>
                      <span className="cw-file-action">
                        {item.action === "Viewing" ? <Eye size={11} /> : <PencilLine size={11} />}
                        {item.action}
                        {item.action !== "Viewing" && <i className="cw-edit-pulse" aria-hidden="true"><i /><i /><i /></i>}
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </div>
            {node.children && <WorkspaceTree nodes={node.children} step={step} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function ComputerBrowser({ step, completedStep }: { step: number; completedStep: number }) {
  const browser = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const annual = completedStep >= 1;

  // Follow real UI targets so cursor movements stay accurate at every screen width.
  useLayoutEffect(() => {
    const element = browser.current;
    if (!element) return;
    const moveCursor = () => {
      const target = element.querySelector<HTMLElement>(`[data-cursor-target="${steps[step].target}"]`);
      if (!target) return;
      const frame = element.getBoundingClientRect();
      const bounds = target.getBoundingClientRect();
      setCursor({ x: bounds.left - frame.left + bounds.width * 0.64, y: bounds.top - frame.top + bounds.height * 0.65 });
    };
    moveCursor();
    const observer = new ResizeObserver(moveCursor);
    observer.observe(element);
    return () => observer.disconnect();
  }, [step]);

  return (
    <div className="cw-browser" ref={browser} data-browser-step={step}>
      <div className="cw-browser-toolbar" aria-hidden="true">
        <span className="cw-browser-arrows"><ArrowLeft size={13} /><ArrowRight size={13} /></span>
        <RotateCw size={12} />
        <span className="cw-address"><LockKeyhole size={10} /><span>northstar.example/pricing</span></span>
        <span className="cw-capture" data-cursor-target="capture"><Camera size={14} /></span>
      </div>
      <div className="cw-browser-page">
        <div className="cw-site-nav">
          <span className="cw-site-brand"><Sparkles size={17} strokeWidth={1.5} /> northstar</span>
          <span>Product <strong>Pricing</strong></span>
        </div>
        <div className="cw-pricing-heading">
          <h3>A plan for your next chapter.</h3>
          <p>One workspace. Room to grow.</p>
        </div>
        <div className="cw-billing" aria-label={annual ? "Annual pricing selected" : "Monthly pricing selected"}>
          <span data-selected={!annual} data-cursor-target="monthly">Monthly</span>
          <span data-selected={annual} data-cursor-target="annual">Annually <small>−17%</small></span>
        </div>
        <div className="cw-plans">
          <div className="cw-plan">
            <span className="cw-plan-name">Starter</span>
            <p className="cw-plan-price"><strong>${annual ? "24" : "29"}</strong><span>/ seat / mo</span></p>
            <span className="cw-plan-term">{annual ? "Billed annually" : "Billed monthly"}</span>
            <div className="cw-plan-cta">Start with Starter <ArrowRight size={12} /></div>
            <ul>
              <li><Check size={12} /> Shared projects</li>
              <li><Check size={12} /> Unlimited members</li>
              <li className="cw-plan-unavailable"><span>–</span> Single sign-on</li>
            </ul>
          </div>
          <div className="cw-plan cw-plan-growth" data-highlighted={completedStep >= 2}>
            <span className="cw-plan-name">Growth <span>For teams</span></span>
            <p className="cw-plan-price" data-cursor-target="price"><strong>${annual ? "49" : "59"}</strong><span>/ seat / mo</span></p>
            <span className="cw-plan-term">{annual ? "Billed annually" : "Billed monthly"}</span>
            <div className="cw-plan-cta">Choose Growth <ArrowRight size={12} /></div>
            <ul>
              <li><Check size={12} /> Everything in Starter</li>
              <li><Check size={12} /> Advanced permissions</li>
              <li className="cw-sso-feature" data-cursor-target="sso" data-found={completedStep >= 2}><ShieldCheck size={13} /> Single sign-on</li>
            </ul>
          </div>
        </div>
        <div className="cw-page-note"><LockKeyhole size={10} /> Your workspace, securely connected.</div>
      </div>
      <div className="cw-cursor" style={{ left: cursor?.x ?? "42%", top: cursor?.y ?? "35%" }} aria-hidden="true">
        <i className="cw-cursor-glow" /><i className="cw-cursor-click" key={step} />
        <MousePointer2 size={25} fill="#d4ffe8" stroke="#21624d" strokeWidth={1.6} />
        <span>Research</span>
      </div>
      {step === 3 && completedStep === 3 && <div className="cw-screen-capture" aria-hidden="true"><span><Camera size={14} /> Screenshot saved</span></div>}
    </div>
  );
}

export function ComputerWorkspace({ children }: { children?: ReactNode }) {
  const cycle = useDemoCycle(steps.length, [1800, 2400, 2400, 2000, 2200, 2600, 4200]);
  const step = cycle.index;
  const [completedStep, setCompletedStep] = useState(0);
  const outputCount = Math.max(0, completedStep - 2);

  // Let the pointer arrive and click before changing the page or creating its output.
  useEffect(() => {
    if (step === 0) { setCompletedStep(0); return; }
    if (!cycle.playing) return;
    const timer = window.setTimeout(() => setCompletedStep(step), 1050);
    return () => window.clearTimeout(timer);
  }, [step, cycle.playing]);
  return (
    <div className="ws-machine ws-ui cw-scene" ref={cycle.ref} {...cycle.props}>
      <div className="ws-machine-intro">{children}</div>
      <div className="cw-window" aria-label="Research uses its computer while files appear in the shared workspace">
        <div className="cw-titlebar">
          <div className="cw-traffic-lights" aria-hidden="true"><i /><i /><i /></div>
          <span><BotAvatar {...workers[0]} size={21} mode="still" /> Research’s computer</span>
          <span className="cw-computer-connected"><i /> Live</span>
        </div>
        <div className="cw-window-body">
          <div className="cw-computer">
            <div className="cw-desktop-surface"><ComputerBrowser step={step} completedStep={completedStep} /></div>
            <div className="cw-computer-activity" key={step}>
              <span className="cw-activity-avatar"><BotAvatar {...workers[step === 5 ? 1 : 0]} size={24} mode={step === 6 ? "idle" : "thinking"} /></span>
              <span><strong>{steps[step].action}</strong><small>{step === 5 ? "Finance · Shared workspace" : step === 6 ? "Research + Finance" : "Research · Browser"}</small></span>
              {step >= 3 && completedStep === step ? <Check size={16} /> : <span className="cw-thinking-dots" aria-hidden="true"><i /><i /><i /></span>}
              <i className="cw-task-progress" aria-hidden="true" />
            </div>
          </div>
          <aside className="cw-files" aria-label="Shared workspace file tree">
            <header className="cw-files-header">
              <div><Folder size={17} /><strong>Shared files</strong></div>
              <span className="cw-file-workers" aria-label="Research and Finance share these files">
                {workers.map((worker) => <BotAvatar key={worker.name} {...worker} size={21} mode="still" />)}
              </span>
            </header>
            <div className="cw-workspace-path">/workspace <span>{3 + outputCount} files</span></div>
            <div className="cw-file-tree"><WorkspaceTree nodes={workspace} step={completedStep} /></div>
            <div className="cw-save-status" key={completedStep}>
              {completedStep >= 3 ? <><Check size={13} /><span><strong>{steps[completedStep].file}</strong><small>{completedStep === 5 ? "Saved by Finance" : "Saved by Research"}</small></span></> : <><Globe size={14} /><span>Gathering information<small>Research · Browser</small></span></>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
