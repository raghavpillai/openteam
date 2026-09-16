import { useEffect, useState } from "react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { api } from "../../../client/openteam-api";
import { SectionLabel, SettingsGroup } from "./ui";

export function MachineSettings() {
  const [machines, setMachines] = useState<Awaited<ReturnType<typeof api.machines>>>([]);
  const [display,setDisplay]=useState({width:1280,height:800});
  const [displaySaved,setDisplaySaved]=useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => setMachines(await api.machines());
  useEffect(() => { void api.computerDisplay().then(setDisplay).catch(e=>setError(clientErrorMessage(e,"Could not load display settings"))); void load().catch(e => setError(clientErrorMessage(e, "Could not load computers"))); }, []);
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await load(); } catch (e) { setError(clientErrorMessage(e, "Could not update computers")); }
    finally { setBusy(false); }
  };
  return <>
    <SectionLabel>Connected computers</SectionLabel>
    <SettingsGroup>
      <p className="py-2 text-xs text-foreground-secondary">Computers registered to this deployment remain listed when offline. Each computer keeps its own execution permissions.</p>
      {machines.map(machine => <div key={machine.machineId} className="flex items-center gap-3 py-2 text-xs">
        <div className="min-w-0 flex-1"><div>{machine.label} · {machine.connected ? "Online" : "Offline"}</div><div className="truncate text-foreground-secondary">{machine.bridgeUrl}</div></div>
        <button type="button" disabled={busy} onClick={() => void change(() => api.removeMachine(machine.machineId))}>Remove</button>
      </div>)}
      <form className="flex gap-2 py-2" onSubmit={event => { event.preventDefault(); void change(async () => { await api.registerMachine(address); setAddress(""); }); }}>
        <input aria-label="Computer bridge URL" type="url" required placeholder="http://computer.local:port" value={address} onChange={event => setAddress(event.target.value)} className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs" />
        <button type="submit" disabled={busy || !address.trim()} className="text-xs">Add computer</button>
        <button type="button" disabled={busy} onClick={() => void change(load)} className="text-xs">Refresh</button>
      </form>
      <form className="flex flex-wrap items-center gap-2 py-2 text-xs" onSubmit={event=>{event.preventDefault();void change(async()=>{setDisplay(await api.saveComputerDisplay(display));setDisplaySaved(true);});}}>
        <span>Box display</span>
        <input aria-label="Box display width" className="w-20 rounded border bg-background px-2 py-1" type="number" min={640} max={7680} required value={display.width} onChange={e=>{setDisplaySaved(false);setDisplay({...display,width:Number(e.target.value)});}} /> ×
        <input aria-label="Box display height" className="w-20 rounded border bg-background px-2 py-1" type="number" min={480} max={4320} required value={display.height} onChange={e=>{setDisplaySaved(false);setDisplay({...display,height:Number(e.target.value)});}} />
        <button disabled={busy} type="submit">Save display</button>
        <p className="w-full text-foreground-secondary">{displaySaved ? "Saved. " : ""}Applies to newly opened box desktops. Restart an existing box desktop to apply it there.</p>
      </form>
      {error && <p role="alert" className="py-2 text-xs text-red-600">{error}</p>}
    </SettingsGroup>
  </>;
}
