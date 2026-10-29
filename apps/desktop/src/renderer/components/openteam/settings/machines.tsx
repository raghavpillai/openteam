import { useEffect, useState } from "react";
import { Monitor, MoreHorizontal } from "lucide-react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { api } from "../../../client/openteam-api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { lastOpened } from "./last-opened";
import { SectionLabel, SettingsGroup } from "./ui";

type Machine = Awaited<ReturnType<typeof api.machines>>[number];

const MESSAGES_LABELS: Record<string, string> = {
  ready: "Messages on",
  needs_permission: "Messages needs permissions",
  off: "Messages off",
};

/** One row per computer: online now or when it was last opened, and whether Messages is on there. */
function DeviceRow({ machine, current, busy, onChange }: { machine: Machine; current: boolean; busy: boolean; onChange: (action: () => Promise<unknown>) => void }) {
  const online = machine.enabled && machine.connected;
  const status = !machine.enabled ? "Disabled" : online ? "Online now" : lastOpened(machine.lastSeenAt);
  const messages = machine.transport === "relay" ? MESSAGES_LABELS[machine.messages] : undefined;
  return (
    <div className="flex min-h-[52px] items-center gap-3 border-t border-black/[0.065] py-2 first:border-t-0 dark:border-white/[0.07]">
      <Monitor aria-hidden className="size-4 shrink-0 text-foreground-secondary" strokeWidth={1.7} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-[17px] text-foreground">
          {machine.label}
          {current ? <span className="text-foreground-secondary"> · This computer</span> : null}
        </div>
        <div className="mt-px flex items-center gap-1.5 text-[12px] leading-4 text-foreground-secondary">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-foreground-tertiary"}`} />
          <span className="truncate">
            {machine.transport === "relay" ? "Computer" : machine.bridgeUrl} · {status}
            {messages ? ` · ${messages}` : ""}
          </span>
        </div>
      </div>
      {!current ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label={`More actions for ${machine.label}`} className="grid size-7 place-items-center rounded-md text-foreground-secondary hover:bg-black/[0.06] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.08]" disabled={busy} type="button">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {machine.transport === "relay" ? (
              <DropdownMenuItem onSelect={() => onChange(() => api.setMachineEnabled(machine.machineId, !machine.enabled))}>
                {machine.enabled ? "Disable" : "Enable"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onChange(() => api.removeMachine(machine.machineId))}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function MachineSettings() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<{machineId:string;connected:boolean;configured:boolean;error:string|null} | null>(null);
  const load = async () => {
    const [roster, status] = await Promise.all([api.machines(), window.openteam?.auth.machineStatus?.().catch(() => null)]);
    setMachines(roster); setLocal(status ?? null);
  };
  useEffect(() => { void load().catch(e => setError(clientErrorMessage(e, "Could not load computers"))); }, []);
  useEffect(() => {
    const refresh = () => { void load().catch(() => {}); };
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("openteam:machines-changed", refresh);
    return () => { clearInterval(timer); window.removeEventListener("openteam:machines-changed", refresh); };
  }, []);
  // This computer first, then the ones online, then the rest.
  const rank = (machine: Machine) =>
    local?.machineId === machine.machineId ? 0 : machine.connected ? 1 : machine.enabled ? 2 : 3;
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await load(); } catch (e) { setError(clientErrorMessage(e, "Could not update computers")); }
    finally { setBusy(false); }
  };
  return <>
    <SectionLabel>Manage devices</SectionLabel>
    <SettingsGroup>
      {local && !local.connected && <p role="status" className="pt-3 text-xs text-foreground-secondary">{local.error ?? (local.configured ? "Connecting this computer…" : "Sign in to connect this computer.")}</p>}
      {[...machines].sort((a, b) => rank(a) - rank(b)).map(machine => (
        <DeviceRow busy={busy} current={local?.machineId === machine.machineId} key={machine.machineId} machine={machine} onChange={action => void change(action)} />
      ))}
      {!machines.length ? <p className="py-3 text-xs text-foreground-secondary">Open the OpenTeam desktop app on a computer and sign in to add it here.</p> : null}
      {error && <p role="alert" className="pb-3 text-xs text-red-600">{error}</p>}
    </SettingsGroup>
  </>;
}

const fieldClass =
  "h-8 rounded-[8px] border border-black/[0.09] bg-background px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-white/[0.1]";
const buttonClass =
  "inline-flex h-8 shrink-0 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]";

/** Manual bridges and the bot's screen size: rarely needed, kept out of the device list. */
export function AdvancedComputerSettings() {
  const [display,setDisplay]=useState({width:1280,height:800});
  const [displaySaved,setDisplaySaved]=useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.computerDisplay().then(setDisplay).catch(e=>setError(clientErrorMessage(e,"Could not load display settings"))); }, []);
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); window.dispatchEvent(new Event("openteam:machines-changed")); } catch (e) { setError(clientErrorMessage(e, "Could not update computers")); }
    finally { setBusy(false); }
  };
  return <>
    <SectionLabel>Advanced</SectionLabel>
    <SettingsGroup>
      <details className="animated-disclosure border-b border-black/[0.065] py-3 text-[12.5px] dark:border-white/[0.07]"><summary>Connect a bridge manually</summary>
      <form className="flex gap-2 pt-2.5" onSubmit={event => { event.preventDefault(); void change(async () => { await api.registerMachine(address); setAddress(""); }); }}>
        <input aria-label="Computer bridge URL" type="url" required placeholder="http://computer.local:port" value={address} onChange={event => setAddress(event.target.value)} className={`${fieldClass} min-w-0 flex-1`} />
        <button type="submit" disabled={busy || !address.trim()} className={buttonClass}>Add computer</button>
      </form>
      </details>
      <form className="py-3" onSubmit={event=>{event.preventDefault();void change(async()=>{setDisplay(await api.saveComputerDisplay(display));setDisplaySaved(true);});}}>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span className="mr-auto">Box display</span>
          <input aria-label="Box display width" className={`${fieldClass} w-20`} type="number" min={640} max={7680} required value={display.width} onChange={e=>{setDisplaySaved(false);setDisplay({...display,width:Number(e.target.value)});}} />
          <span aria-hidden className="text-foreground-secondary">×</span>
          <input aria-label="Box display height" className={`${fieldClass} w-20`} type="number" min={480} max={4320} required value={display.height} onChange={e=>{setDisplaySaved(false);setDisplay({...display,height:Number(e.target.value)});}} />
          <button className={buttonClass} disabled={busy} type="submit">Save display</button>
        </div>
        {error && <p role="alert" className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-1.5 text-[12px] leading-4 text-foreground-secondary">{displaySaved ? "Saved. " : ""}Applies to newly opened box desktops. Restart an existing box desktop to apply it there.</p>
      </form>
    </SettingsGroup>
  </>;
}
