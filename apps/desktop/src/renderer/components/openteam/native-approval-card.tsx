import { nativeApprovalOutcome } from "@openteam/product-core/activity";
import { PermissionSpinner } from "./permission-spinner";
import type { ApprovalDecision, ApprovalView } from "@openteam/contracts";
import { PermissionIcon } from "./permission-icon";
import { useId, useState } from "react";
import "./permission-cards.css";

type CookieItem = { origin: string; profileId: string; profileDisplayName: string };
export type NativeApprovalPresentation =
  | { kind: "saved-login"; title: string; site: string; category: string; purpose: string }
  | { kind: "cookie-import"; items: CookieItem[] };
const itemKey = (item: CookieItem) => JSON.stringify([item.profileId, item.origin]);

/** Public metadata only. Passwords and cookie bytes never enter this component. */
export function NativeApprovalCard({
  approval,
  presentation,
  busy,
  error,
  onResolve,
}: {
  approval: ApprovalView;
  presentation: NativeApprovalPresentation;
  busy: boolean;
  error: string;
  onResolve: (decision: ApprovalDecision, selectedItems?: readonly string[]) => Promise<void>;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [excluded, setExcluded] = useState(new Set<string>());
  const details = approval.details as Record<string, unknown>;
  const { pending, accepted, filling, failed, status } = nativeApprovalOutcome(approval);
  if (presentation.kind === "saved-login") {
    let site = presentation.site;
    try {
      site = new URL(site).host;
    } catch {
      /* Display the reviewed host unchanged. */
    }
    const heading = (
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <PermissionIcon
          name="key"
          aria-hidden="true"
          className="permission-secondary size-3.5 shrink-0 translate-y-[1.78125px]"
          strokeWidth={1.25}
        />
        <span className="permission-receipt-copy">
          <span className="permission-title" id={titleId}>
            {presentation.title}
          </span>
          <span className="permission-field-label">
            {presentation.category} · {site}
          </span>
        </span>
      </div>
    );
    return (
      <section
        aria-labelledby={titleId}
        role="region"
        className={`permission-surface credential-approval rounded-2xl p-3 ${pending || filling ? "flex flex-col gap-2.5" : "permission-receipt"}`}
      >
        {heading}
        {filling ? (
          <span role="status" aria-live="polite" className="permission-copy">
            Filling 1Password login for {site}
          </span>
        ) : pending ? (
          <>
            <span className="permission-copy">{presentation.purpose}</span>
            {error && (
              <p role="alert" className="text-[13px] text-red-600">
                {error}
              </p>
            )}
            <div className="permission-actions">
              <button
                className="permission-button permission-button-primary"
                disabled={busy}
                onClick={() => void onResolve("accept")}
              >
                Allow Once
              </button>
              <button
                className="permission-button"
                disabled={busy}
                onClick={() => void onResolve("decline")}
              >
                Deny
              </button>
            </div>
          </>
        ) : (
          <span
            className={`permission-pill ${failed ? "permission-pill-danger" : accepted ? "permission-pill-success" : "permission-pill-muted"}`}
          >
            {accepted && !failed && (
              <PermissionIcon
                name="check"
                aria-hidden="true"
                className="size-3"
                strokeWidth={1.25}
              />
            )}
            <span className="permission-pill-label">{status}</span>
          </span>
        )}
      </section>
    );
  }
  const approved = Array.isArray(details.selectedItems) ? new Set(details.selectedItems) : null;
  const items =
    accepted && approved
      ? presentation.items.filter((item) => approved.has(itemKey(item)))
      : presentation.items;
  const selected = items.filter((item) => !excluded.has(itemKey(item))).map(itemKey);
  const profiles = [...new Set(items.map((item) => item.profileId))];
  const toggle = (keys: string[], checked: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      for (const key of keys) checked ? next.delete(key) : next.add(key);
      return next;
    });
  return (
    <section
      aria-labelledby={titleId}
      className="permission-surface permission-approval flex min-w-0 flex-col gap-3 rounded-2xl bg-[#eeeeee] p-3 dark:bg-[#262626]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className="min-w-0 flex-1 text-[14px] font-medium leading-5 tracking-[-0.15px]"
            id={titleId}
          >
            The Bot wants to use your existing logins
          </span>
          <span
            className={`approval-status ${pending || filling ? "approval-status-pending" : !failed && accepted ? "approval-status-allowed" : approval.status === "declined" || failed ? "approval-status-denied" : "approval-status-muted"}`}
          >
            {pending || filling ? (
              <PermissionSpinner />
            ) : (
              <span aria-hidden="true" className="approval-status-dot" />
            )}
            <span>{pending ? "Approval needed" : filling ? "Importing logins" : status}</span>
          </span>
        </div>
        {pending && (
          <span className="permission-field-label">
            Copies cookies from Chrome on your computer so the bot can use sites you're already
            signed into.
          </span>
        )}
        <div className={`flex min-w-0 flex-col gap-1 ${open ? "" : "pb-1"}`}>
          <button
            aria-expanded={open}
            className="permission-secondary flex items-center gap-1.5 self-start text-[13px] font-normal leading-[18px]"
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <span className="grid size-3.5 place-items-center">
                <PermissionIcon name="down" className="size-2.5" />
              </span>
            ) : (
              <span className="grid size-3.5 place-items-center">
                <PermissionIcon name="right" className="size-2.5" />
              </span>
            )}{" "}
            {open ? "Hide" : "Show"} the sites
          </button>
          {open && (
            <div className="cookie-site-groups">
              {profiles.map((profile) => {
                const group = items.filter((item) => item.profileId === profile);
                const all = group.every((item) => !excluded.has(itemKey(item)));
                return (
                  <div key={profile} className="cookie-site-group">
                    <div className="cookie-profile-header">
                      <span>{group[0]?.profileDisplayName ?? profile}</span>
                      {pending && (
                        <button
                          disabled={busy}
                          aria-label={`${all ? "Deselect" : "Select"} all in ${group[0]?.profileDisplayName ?? profile}`}
                          onClick={() => toggle(group.map(itemKey), !all)}
                        >
                          {all ? "Deselect all" : "Select all"}
                        </button>
                      )}
                    </div>
                    <div>
                      {group.map((item) => (
                        <label key={itemKey(item)} className="cookie-site-row">
                          <span className="cookie-checkbox">
                            <input
                              type="checkbox"
                              aria-label={`${item.origin} in ${item.profileDisplayName}`}
                              disabled={busy || !pending}
                              checked={pending ? !excluded.has(itemKey(item)) : accepted}
                              onChange={(event) => toggle([itemKey(item)], event.target.checked)}
                            />
                            <svg aria-hidden="true" viewBox="0 0 16 16">
                              <path d="m4 8 2.5 2.5L12 5" />
                            </svg>
                          </span>
                          <span>{item.origin}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {pending && error && (
          <p role="alert" className="text-[13px] text-red-600">
            {error}
          </p>
        )}
      </div>
      {pending && (
        <div className="permission-actions">
          <button
            className="permission-button permission-button-primary"
            disabled={busy || !selected.length}
            onClick={() => void onResolve("accept", selected)}
          >
            Allow once
          </button>
          {details.supportsAlwaysAllow === true && (
            <button
              className="permission-button permission-button-outline"
              disabled={busy || !selected.length}
              onClick={() => void onResolve("always_allow", selected)}
            >
              Always allow
            </button>
          )}
          <button
            className="permission-button permission-button-outline"
            disabled={busy}
            onClick={() => void onResolve("decline")}
          >
            Deny
          </button>
        </div>
      )}
    </section>
  );
}
