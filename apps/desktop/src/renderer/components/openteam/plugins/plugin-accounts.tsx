import type { PluginConnectionView } from "@openteam/contracts";
import { Check, LoaderCircle, SquarePen, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../../lib/cn";

const button =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[#77777717] px-3 text-[12px] outline-none transition-colors duration-120 ease-out hover:bg-[#7777772b] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-45";
const iconButton =
  "grid size-5 shrink-0 cursor-pointer place-items-center rounded text-foreground-tertiary outline-none transition-colors duration-120 ease-out hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-45";

export function PluginAccountRow({
  connection,
  busy,
  onRename,
  onConnect,
  onRemove,
  children,
}: {
  connection: PluginConnectionView;
  busy: boolean;
  onRename: (name: string) => void;
  onConnect: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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
      <div className="group/account flex min-h-[48px] items-center gap-2 px-3.5 py-3">
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
                  setAlias(connection.alias);
                  setEditing(false);
                }
              }}
              className="min-w-0 max-w-full [field-sizing:content] border-0 bg-transparent p-0 text-[13px] leading-[18px] outline-none"
            />
          ) : (
            <span className="truncate text-[13px] font-medium">{connection.alias}</span>
          )}
          <button
            aria-label={`${editing ? "Save" : "Edit"} ${connection.alias} account`}
            aria-expanded={editing}
            disabled={busy || (editing && alias.trim().length < 2)}
            className={iconButton}
            onClick={() => {
              if (editing) save();
              else {
                setConfirmingRemove(false);
                setEditing(true);
              }
            }}
            type="button"
          >
            {editing ? <Check className="size-3" /> : <SquarePen className="size-3" />}
          </button>
          {!editing && (
            <button
              aria-label={`${connection.alias} account settings`}
              aria-expanded={expanded}
              title="Account settings"
              className={cn(
                iconButton,
                "opacity-0 group-hover/account:opacity-100 focus-visible:opacity-100",
                expanded && "opacity-100"
              )}
              onClick={() => setExpanded((value) => !value)}
              type="button"
            >
              <Settings2 className="size-3" />
            </button>
          )}
        </div>
        {!editing && (
          <span
            role="status"
            title={
              connection.statusMessage ??
              (connection.status === "needs_auth" ? "Authentication required" : status)
            }
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
        )}
        {!editing && !ready && (
          <button className={button} type="button" disabled={busy} onClick={onConnect}>
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {connection.configured ? "Retry" : "Set up"}
          </button>
        )}
        {editing && (connection.alias !== "default" || connection.status !== "needs_auth") && (
          <button
            aria-label={`${confirmingRemove ? "Confirm removal of" : "Remove"} ${connection.alias} account`}
            className={cn(button, "text-red-600 dark:text-red-400")}
            disabled={busy}
            type="button"
            onClick={() => {
              if (confirmingRemove) {
                setEditing(false);
                onRemove();
              } else setConfirmingRemove(true);
            }}
          >
            {confirmingRemove ? "Confirm" : "Remove"}
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
            aria-label="New account label"
            placeholder="Label this account, e.g. work or personal"
            className="h-8 min-w-0 flex-1 rounded-md border border-black/10 bg-background px-2 text-[12px] outline-none dark:border-white/10"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <button className={button} type="submit" disabled={busy || alias.trim().length < 2}>
            Add Account
          </button>
          <button
            className={button}
            type="button"
            onClick={() => {
              setOpen(false);
              setAlias("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="flex min-h-[42px] w-full cursor-pointer items-center gap-1.5 px-3.5 text-left text-[13px] text-foreground-secondary outline-none transition-colors duration-120 ease-out hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:cursor-default disabled:opacity-45"
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
