import { ChevronDown, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MachineMessagesSettings } from "@openteam/client-core";
import { api } from "../../../client/openteam-api";
import { MessagesPermissionsDialog, missingGrants } from "./messages-permissions-dialog";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

/** This Mac's Messages switch, its macOS permissions, and who OpenTeam may text without asking. */
export function MessagesSettings({
  computer,
  onComputerChange,
}: {
  computer: OpenTeamComputerSettings;
  onComputerChange: (value: OpenTeamComputerSettings) => void;
}) {
  const machineId = computer.machine.machineId;
  const [permissions, setPermissions] = useState<OpenTeamMessagesPermissions | null>(null);
  const [send, setSend] = useState<MachineMessagesSettings | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<"enabled" | "standing" | "recipient" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);

  const changed = () => window.dispatchEvent(new Event("openteam:machines-changed"));
  const loadSend = useCallback(() => {
    if (!machineId) return;
    void api
      .machineMessages(machineId)
      .then((value) => {
        setSend(value);
        setSendFailed(false);
      })
      .catch(() => setSendFailed(true));
  }, [machineId]);
  useEffect(() => {
    const refresh = () => void window.openteam?.computer.messagesPermissions().then(setPermissions).catch(() => {});
    refresh();
    loadSend();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadSend]);

  if (!computer.messagesSupported) return null;
  const enabled = computer.messagesEnabled;
  const missing = missingGrants(permissions);

  const setEnabled = async (messagesEnabled: boolean) => {
    setSaving("enabled");
    setFailed(null);
    try {
      onComputerChange(await window.openteam!.computer.update({ messagesEnabled }));
      // The server clears send rules whenever the switch flips.
      setSend((current) => current && { ...current, sendWithoutAsking: false, allowedRecipients: [] });
      changed();
      if (messagesEnabled) {
        const current = await window.openteam!.computer.messagesPermissions().catch(() => null);
        if (current) setPermissions(current);
        if (missingGrants(current).length) setDialogOpen(true);
      }
    } catch {
      setFailed("enabled");
    } finally {
      setSaving(null);
    }
  };
  const updateSend = async (key: string, input: { sendWithoutAsking?: boolean; removeRecipient?: string }, failure: "standing" | "recipient") => {
    setSaving(key);
    setFailed(null);
    try {
      setSend(await api.updateMachineMessages(machineId, input));
    } catch {
      setFailed(failure);
    } finally {
      setSaving(null);
    }
  };

  const recipients = send?.allowedRecipients ?? [];
  return (
    <>
      <SectionLabel>Messages</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Use Messages"
          description={failed === "enabled" ? "Couldn't save. Try again." : "Lets OpenTeam read and send texts on this Mac"}
          control={<InteractiveSwitch label="Use Messages" checked={enabled} disabled={saving !== null} onChange={(value) => void setEnabled(value)} />}
        />
        {enabled ? (
          <SettingsRow
            title="macOS permissions"
            description={!permissions ? "Loading…" : missing.length ? `Needs ${missing.join(", ")}` : "Automation, Contacts and Full Disk Access are allowed"}
            control={
              <button
                className="inline-flex h-7 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
                disabled={!permissions}
                onClick={() => setDialogOpen(true)}
                type="button"
              >
                {missing.length ? "Set up" : "Review"}
              </button>
            }
          />
        ) : null}
        {enabled ? (
          <SettingsRow
            title="Send Without Asking"
            description={!send ? (sendFailed ? "Couldn't load this setting" : "Loading…") : failed === "standing" ? "Couldn't save. Try again." : "Skips the approval card for every text"}
            control={
              sendFailed ? (
                <button className="text-[12px] text-foreground-secondary hover:text-foreground" onClick={loadSend} type="button">
                  Retry
                </button>
              ) : (
                <InteractiveSwitch
                  label="Send Without Asking"
                  checked={send?.sendWithoutAsking ?? false}
                  disabled={!send || saving !== null}
                  onChange={(sendWithoutAsking) => void updateSend("standing", { sendWithoutAsking }, "standing")}
                />
              )
            }
          />
        ) : null}
        {enabled && send && !send.sendWithoutAsking && recipients.length ? (
          <>
            <SettingsRow
              title="Allowed recipients"
              description={failed === "recipient" ? "The change could not be applied. Try again." : "OpenTeam can text these people without asking first"}
              control={
                <button
                  aria-expanded={recipientsOpen}
                  className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground dark:bg-white/[0.09]"
                  onClick={() => setRecipientsOpen((open) => !open)}
                  type="button"
                >
                  {recipients.length === 1 ? "1 person" : `${recipients.length} people`}
                  <ChevronDown aria-hidden className={`size-3.5 transition-transform ${recipientsOpen ? "rotate-180" : ""}`} strokeWidth={2.25} />
                </button>
              }
            />
            {recipientsOpen ? (
              <ul className="pb-2">
                {recipients.map((recipient) => (
                  <li className="flex items-center gap-3 py-1.5 pl-3" key={recipient.recipient}>
                    <div className="min-w-0 flex-1">
                      {recipient.recipientName ? <div className="truncate text-[12.5px] font-medium">{recipient.recipientName}</div> : null}
                      <div className="truncate text-[12px] text-foreground-secondary" dir="ltr">{recipient.recipient}</div>
                    </div>
                    <button
                      aria-label={`Remove ${recipient.recipientName ?? recipient.recipient}`}
                      className="rounded-md p-1 text-foreground-secondary hover:bg-black/[0.06] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.08]"
                      disabled={saving !== null}
                      onClick={() => void updateSend(recipient.recipient, { removeRecipient: recipient.recipient }, "recipient")}
                      type="button"
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </SettingsGroup>
      <MessagesPermissionsDialog
        onChange={(value) => {
          setPermissions(value);
          changed();
        }}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}
