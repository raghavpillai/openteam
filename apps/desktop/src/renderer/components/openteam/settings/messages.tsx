import { useCallback, useEffect, useState } from "react";
import type { MachineMessagesSettings } from "@openteam/client-core";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { api } from "../../../client/openteam-api";
import { InteractiveSwitch, SectionLabel, SettingsGroup, SettingsRow } from "./ui";

type Grant = "fullDiskAccess" | "automation" | "contacts";
const GRANTS: Array<{ key: Grant; title: string; description: string }> = [
  { key: "fullDiskAccess", title: "Full Disk Access", description: "Lets bots search your texts" },
  { key: "automation", title: "Automation", description: "Lets bots send texts through Messages" },
  { key: "contacts", title: "Contacts", description: "Lets bots find people by name" },
];

const grantState = (permissions: OpenTeamMessagesPermissions, key: Grant) =>
  key === "fullDiskAccess" ? (permissions.fullDiskAccess ? "granted" : "denied") : permissions[key];

/** This Mac's Messages switch, its macOS grants, and who bots may text without asking. */
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSend = useCallback(() => {
    if (!machineId) return;
    void api.machineMessages(machineId).then(setSend).catch(() => setSend(null));
  }, [machineId]);
  useEffect(() => {
    void window.openteam?.computer.messagesPermissions().then(setPermissions).catch(() => {});
    loadSend();
    // Grants change in System Settings, outside the app; the server clears send rules when the switch flips.
    const timer = setInterval(() => {
      void window.openteam?.computer.messagesPermissions().then(setPermissions).catch(() => {});
      loadSend();
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadSend]);

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(clientErrorMessage(cause, failure));
    } finally {
      setBusy(false);
    }
  };

  if (!computer.messagesSupported) return null;
  return (
    <>
      <SectionLabel>Messages</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Use Messages"
          description="Lets OpenTeam bots read and send texts on this Mac"
          control={
            <InteractiveSwitch
              label="Use Messages"
              checked={computer.messagesEnabled}
              disabled={busy}
              onChange={(messagesEnabled) =>
                void act(async () => {
                  onComputerChange(await window.openteam!.computer.update({ messagesEnabled }));
                  setSend((current) => current && { ...current, sendWithoutAsking: false, allowedRecipients: [] });
                }, "Couldn’t change Messages")
              }
            />
          }
        />
        {computer.messagesEnabled && permissions
          ? GRANTS.map((grant) => {
              const state = grantState(permissions, grant.key);
              return (
                <SettingsRow
                  key={grant.key}
                  title={grant.title}
                  description={grant.description}
                  control={
                    state === "granted" ? (
                      <span className="text-[12px] text-foreground-secondary">Allowed</span>
                    ) : (
                      <button
                        className="inline-flex h-7 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground disabled:text-foreground-tertiary dark:bg-white/[0.09]"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setPermissions(await window.openteam!.computer.messagesPermissions(grant.key));
                          }, "Couldn’t ask macOS for this permission")
                        }
                        type="button"
                      >
                        {grant.key === "fullDiskAccess" || state === "denied" ? "Open System Settings" : "Allow"}
                      </button>
                    )
                  }
                />
              );
            })
          : null}
        {computer.messagesEnabled && send ? (
          <>
            <SettingsRow
              title="Send Without Asking"
              description="Skips the approval card for every text"
              control={
                <InteractiveSwitch
                  label="Send Without Asking"
                  checked={send.sendWithoutAsking}
                  disabled={busy}
                  onChange={(sendWithoutAsking) =>
                    void act(async () => setSend(await api.updateMachineMessages(machineId, { sendWithoutAsking })), "Couldn’t save Messages settings")
                  }
                />
              }
            />
            <SettingsRow
              title="Allowed recipients"
              description={send.allowedRecipients.length ? "Bots can text these people without asking first" : "Choose “Always allow” on a text’s approval card to add someone"}
            />
            {send.allowedRecipients.map((recipient) => (
              <SettingsRow
                key={recipient.recipient}
                title={recipient.recipientName ?? recipient.recipient}
                description={recipient.recipientName ? recipient.recipient : undefined}
                control={
                  <button
                    className="text-[12px] text-foreground-secondary hover:text-foreground"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => setSend(await api.updateMachineMessages(machineId, { removeRecipient: recipient.recipient })), "Couldn’t remove this recipient")
                    }
                    type="button"
                  >
                    Remove
                  </button>
                }
              />
            ))}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="pb-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsGroup>
    </>
  );
}
