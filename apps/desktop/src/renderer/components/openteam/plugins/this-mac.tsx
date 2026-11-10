import { Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { missingGrants, OPEN_MESSAGES_PERMISSIONS_EVENT, useMessagesIcon } from "../settings/messages-permissions-dialog";

const pill =
  "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full bg-foreground/[0.08] px-3 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-foreground/[0.12] focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default disabled:opacity-50";

/** "This Mac": apps on the Mac running OpenTeam, set up in place. Messages is the one so far. */
export function ThisMacSection({ query }: { query: string }) {
  const icon = useMessagesIcon();
  const [computer, setComputer] = useState<OpenTeamComputerSettings | null>(null);
  const [permissions, setPermissions] = useState<OpenTeamMessagesPermissions | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void window.openteam?.computer.get().then(setComputer).catch(() => {});
    void window.openteam?.computer.messagesPermissions().then(setPermissions).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("openteam:machines-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("openteam:machines-changed", refresh);
    };
  }, [refresh]);
  const normalized = query.trim().toLocaleLowerCase();
  if (!computer?.messagesSupported) return null;
  if (normalized && !"messages imessage sms texts read and reply to texts mac".includes(normalized)) return null;
  const ready = computer.messagesEnabled && permissions !== null && !missingGrants(permissions).length;
  const setUp = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if (!computer.messagesEnabled) setComputer(await window.openteam!.computer.update({ messagesEnabled: true }));
      window.dispatchEvent(new Event("openteam:machines-changed"));
      window.dispatchEvent(new Event(OPEN_MESSAGES_PERMISSIONS_EVENT));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Mac apps" className="mb-7">
      <div className="mb-2 px-2">
        <h3 className="text-[14px] font-medium">This Mac</h3>
        <p className="mt-0.5 text-[12px] text-foreground-secondary">OpenTeam asks the first time it needs each one, or you can allow them now</p>
      </div>
      <div className="flex min-w-0 items-center gap-3 rounded-2xl px-3 py-3">
        {icon ? <img alt="" className="size-9 shrink-0" src={icon} /> : <span className="size-9 shrink-0 rounded-[9px] bg-[#34c759]" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-[18px]">Messages</span>
          <span className={`block truncate text-[13px] leading-[18px] ${failed ? "text-red-600" : "text-foreground-secondary"}`}>
            {failed ? "Couldn't save. Try again." : "Read and reply to texts"}
          </span>
        </span>
        {ready ? (
          <span className="inline-flex items-center gap-1 px-1 text-[12px] text-foreground-secondary">
            <Check className="size-3 text-emerald-600" />
            Allowed
          </span>
        ) : (
          <button className={pill} disabled={busy || permissions === null} onClick={() => void setUp()} type="button">
            Set up
          </button>
        )}
      </div>
    </section>
  );
}
