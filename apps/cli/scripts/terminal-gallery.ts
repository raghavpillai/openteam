import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const galleryWidths = [24, 40, 60, 76, 90, 110];
export interface TerminalGalleryScenario {
  id: string;
  title: string;
  reports: Record<number, Record<string, string>>;
}

/** Shows the actual ANSI renderer output without a shell or live Docker connection. */
export const writeTerminalGallery = (
  directory: string,
  data: TerminalGalleryScenario[],
  command: "doctor" | "status" | "model"
): string => {
  const widths = galleryWidths;
  const label = command === "status" ? "status / health" : command;
  const modes =
    command === "model"
      ? { full: "Full editor content", terminal: "24-row terminal" }
      : command === "status"
        ? { full: "Status / health" }
        : { full: "Doctor", compact: "Installation" };
  mkdirSync(resolve(directory), { recursive: true });
  const path = resolve(directory, "index.html");
  writeFileSync(
    path,
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenTeam ${label} — CLI preview</title>
<style>
*{box-sizing:border-box} body{margin:0;background:#f2f4f7;color:#17202b;font:14px system-ui,sans-serif}
header{padding:24px 32px 16px;border-bottom:1px solid #d9dee7;background:white}h1{font-size:22px;margin:0 0 6px}p{margin:0;color:#586477}
nav{display:flex;flex-wrap:wrap;gap:16px;align-items:end;padding:18px 32px;background:white;border-bottom:1px solid #d9dee7}
label{display:grid;gap:6px;color:#586477;font-size:12px}select{border:1px solid #c2cad6;border-radius:6px;padding:8px;background:white;color:#17202b;font:14px system-ui}
main{padding:24px 32px}h2{font-size:16px;margin:0 0 12px;font-weight:600}.screen{overflow:auto;max-width:100%;border-radius:10px;background:#10151c;box-shadow:0 3px 14px #16203222;padding:18px 12px}
pre{color:#dce3ec;font:13px/1.55 Menlo,Consolas,monospace;margin:0;tab-size:4;white-space:pre;min-width:max-content}
.c1{font-weight:700}.c31{color:#ff7b86}.c32{color:#8ad896}.c33{color:#efd47d}.c36{color:#7fcadd}.c90{color:#a4afbf}
.light .screen{background:#fff}.light pre{color:#17202b}.light .c31{color:#af1c30}.light .c32{color:#176c36}.light .c33{color:#805a00}.light .c36{color:#116679}.light .c90{color:#536477}
.plain pre span{color:inherit;font-weight:normal}footer{padding:16px 32px;color:#586477;font-size:12px}
</style>
<header><h1>OpenTeam ${label} · CLI preview</h1><p>Simulated scenarios rendered by the CLI. No Docker commands, service changes, or network probes run in this viewer.</p></header>
<nav>
<label>Scenario<select id="scenario"></select></label>
<label>Report<select id="mode">${Object.entries(modes)
      .map(([value, name]) => `<option value="${value}">${name}</option>`)
      .join("")}</select></label>
<label>Columns<select id="width">${widths.map((width) => `<option${width === 90 ? " selected" : ""}>${width}</option>`).join("")}</select></label>
<label>Appearance<select id="theme"><option value="dark">Dark terminal</option><option value="light">Light terminal</option></select></label>
<label>ANSI colors<select id="color"><option value="color">On</option><option value="plain">Off</option></select></label>
</nav><main><h2 id="title"></h2><div class="screen"><pre id="terminal" aria-label="CLI output"></pre></div></main>
<footer>${data.length} scenarios · 6 terminal widths. Run bun run preview:${command} --list to preview these cases in your own terminal.</footer>
<script>
const scenarios=${JSON.stringify(data).replace(/</g, "\\u003c")};
const controls=Object.fromEntries(['scenario','mode','width','theme','color'].map(id=>[id,document.getElementById(id)]));
for(const scenario of scenarios){const option=document.createElement('option');option.value=scenario.id;option.textContent=scenario.title;controls.scenario.append(option);}
const params=new URLSearchParams(location.search);
for(const [id,control] of Object.entries(controls)) if(params.has(id)&&[...control.options].some(option=>option.value===params.get(id)))control.value=params.get(id);
function render(){
 const scenario=scenarios.find(s=>s.id===controls.scenario.value);
 document.getElementById('title').textContent=scenario.title;
 document.body.className=controls.theme.value+' '+controls.color.value;
 const terminal=document.getElementById('terminal');terminal.replaceChildren();
 const output=scenario.reports[controls.width.value][controls.mode.value];
 const pattern=/\\x1b\\[([0-9;]*)m/g;let last=0;let classes=[];let match;
 const append=text=>{if(!text)return;const span=document.createElement('span');span.className=classes.join(' ');span.textContent=text;terminal.append(span);};
 while((match=pattern.exec(output))){append(output.slice(last,match.index));for(const code of match[1].split(';').map(Number)){if(code===0)classes=[];else if([1,31,32,33,36,90].includes(code))classes.push('c'+code);}last=pattern.lastIndex;}
 append(output.slice(last));
 const query=new URLSearchParams(Object.entries(controls).map(([id,control])=>[id,control.value]));history.replaceState(null,'','?'+query);
}
Object.values(controls).forEach(control=>control.addEventListener('change',render));render();
</script></html>`
  );
  return path;
};
