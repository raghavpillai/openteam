import type { PluginConnectionView } from "@openteam/contracts";
import { Check, LoaderCircle, Pencil, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../../lib/cn";

const button =
  "inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full bg-black/[0.045] px-3 text-[12px] hover:bg-black/[0.08] disabled:opacity-45 dark:bg-white/[0.07] dark:hover:bg-white/[0.12]";

export function PluginAccountRow({
  connection,
  busy,
  onRename,
  onConnect,
  children,
}: {
  connection: PluginConnectionView;
  busy: boolean;
  onRename: (name: string) => void;
  onConnect: () => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [alias, setAlias] = useState(connection.alias);
  useEffect(() => setAlias(connection.alias), [connection.alias]);
  const ready = connection.status === "ready";
  const status = ready
    ? "Connected"
    : connection.status === "needs_auth"
      ? "Needs auth"
      : connection.status === "error"
        ? "Connection error"
        : "Not connected";
  const save = () => {
    if (alias.trim().length < 2 || busy) return;
    onRename(alias.trim());
    setEditing(false);
  };
  return (
    <div className="border-t border-black/[0.065] first:border-t-0 dark:border-white/[0.07]">
      <div className="flex min-h-[48px] items-center gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {editing ? (
            <input
              autoFocus
              data-plugin-account-editor
              aria-label={`Rename ${connection.alias} account`}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAlias(connection.alias);
                  setEditing(false);
                }
              }}
              className="h-7 min-w-0 max-w-48 rounded-md border border-black/10 bg-background px-2 text-[13px] outline-none dark:border-white/10"
            />
          ) : (
            <span className="truncate text-[13px] font-medium">{connection.alias}</span>
          )}
          <button
            aria-label={`${editing ? "Save" : "Edit"} ${connection.alias} account`}
            disabled={busy || (editing && alias.trim().length < 2)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-foreground-tertiary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            onClick={() => (editing ? save() : setEditing(true))}
            type="button"
          >
            {editing ? <Check className="size-3" /> : <Pencil className="size-3" />}
          </button>
          <button
            aria-label={`${connection.alias} account settings`}
            aria-expanded={expanded}
            title="Account settings"
            className="grid size-6 shrink-0 place-items-center rounded-md text-foreground-tertiary hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <Settings2 className="size-3" />
          </button>
        </div>
        <span
          className={cn(
            "text-[12px]",
            ready
              ? "text-emerald-600 dark:text-emerald-400"
              : connection.status === "needs_auth"
                ? "text-amber-600 dark:text-amber-400"
                : "text-foreground-secondary"
          )}
        >
          {status}
        </span>
        {!ready && (
          <button className={button} type="button" disabled={busy} onClick={onConnect}>
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {connection.configured ? "Retry" : "Set up"}
          </button>
        )}
      </div>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function AddPluginAccount({
  connections,
  busy,
  onAdd,
}: {
  connections: PluginConnectionView[];
  busy: boolean;
  onAdd: (connection: PluginConnectionView, alias: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const [connector, setConnector] = useState(connections[0]?.connectorKey ?? "");
  const choices = [...new Map(connections.map((c) => [c.connectorKey, c])).values()];
  return (
    <div className="border-t border-black/[0.065] dark:border-white/[0.07]">
      {open ? (
        <form
          data-plugin-account-editor
          className="flex flex-wrap items-center gap-2 p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              setAlias("");
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const connection = choices.find((c) => c.connectorKey === connector);
            if (connection && alias.trim().length >= 2) {
              onAdd(connection, alias.trim());
              setOpen(false);
              setAlias("");
            }
          }}
        >
          {choices.length > 1 && (
            <select
              aria-label="Connector for new account"
              className="h-8 rounded-md bg-background px-2 text-[12px]"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
            >
              {choices.map((c) => (
                <option value={c.connectorKey} key={c.connectorKey}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <input
            autoFocus
            aria-label="New account name"
            placeholder="Account name, e.g. work"
            className="h-8 min-w-0 flex-1 rounded-md border border-black/10 bg-background px-2 text-[12px] outline-none dark:border-white/10"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <button className={button} type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className={button} type="submit" disabled={busy || alias.trim().length < 2}>
            Add Account
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-1.5 px-3 text-left text-[12px] text-foreground-secondary hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          <Plus className="size-3.5" />
          Add Another Account
        </button>
      )}
    </div>
  );
}
