import "./permission-cards.css";
import { PermissionIcon } from "./permission-icon";
import { openComputerHandoff } from "../../lib/computer-handoff";
import { userFormOutcome } from "@openteam/product-core/rich-messages";
import type { ChannelMessageView } from "@openteam/contracts";
import {
  formFieldIsSecret,
  validateUserFormValues,
  type UserForm,
  type UserFormField,
} from "@openteam/contracts/review-cards";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../client/openteam-api";

export function UserFormCard({ message, form }: { message: ChannelMessageView; form: UserForm }) {
  const inFlight = useRef(false);
  const metadata = message.metadata as Record<string, unknown>;
  const [localMetadata, setLocalMetadata] = useState(metadata);
  const state = String(localMetadata.cardState ?? "pending");
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  const outcome = userFormOutcome(form, localMetadata);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setLocalMetadata(metadata);
    if (metadata.cardState && metadata.cardState !== "pending") {
      setValues({});
      setError("");
    }
  }, [metadata]);
  useEffect(() => {
    let active = true;
    if (state === "pending")
      void api
        .userFormPrefill(message.id)
        .then((prefill) => {
          if (active) setValues((current) => ({ ...prefill, ...current }));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [message.id, state]);
  const set = (id: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [id]: value }));
  let valid = true;
  try {
    validateUserFormValues(form, values);
  } catch {
    valid = false;
  }
  const submit = async (mode: "submit" | "dismissed" | "escalated" = "submit") => {
    const dismiss = mode !== "submit";
    if (inFlight.current || state !== "pending" || (!dismiss && !valid)) return;
    const previous = authoritative.current;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = dismiss
        ? await api.dismissUserForm(message.id, mode as "dismissed" | "escalated")
        : await api.submitUserForm(message.id, values);
      setValues({});
      if (authoritative.current === previous) {
        const next = result.message.metadata as Record<string, unknown>;
        setLocalMetadata(next);
        if (mode === "escalated" && next.cardState === "escalated" && message.senderBotId)
          openComputerHandoff({ botId: message.senderBotId, messageId: message.id });
      }
    } catch {
      // Provider errors can echo submitted values. Never display their raw text.
      if (authoritative.current === previous)
        setError("We couldn't confirm the form was completed. Check the page before trying again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const receipt = localMetadata.formReceipt as Record<string, unknown> | undefined;
  const failed =
    state === "fill_failed" ||
    receipt?.interrupted === true ||
    !!receipt?.domainMismatch ||
    !!receipt?.pageMoved ||
    outcome.fields.some((field) =>
      ["Held for recovery", "Discarded", "Check the page"].includes(field.status)
    ) ||
    (receipt?.submitAttempted === true && receipt?.submitSucceeded !== true);
  const status = pending ? "sending" : failed ? "fill_failed" : state;
  const summary =
    status === "sending"
      ? "Sending…"
      : status === "submitted"
        ? form.domain
          ? "Filled into the page. Secret values were never shown to your Bot."
          : "Form submitted. Secret values were never shown to your Bot."
        : status === "fill_failed"
          ? "Could not fill into the page — it may have moved or changed. Secret values were never shown to your Bot."
          : status === "escalated"
            ? "You chose to do this step on the screen instead."
            : status === "expired"
              ? outcome.summary
              : "Dismissed without filling anything.";
  const label =
    status === "sending"
      ? "Sending"
      : status === "submitted"
        ? "Submitted"
        : status === "fill_failed"
          ? "Not filled"
          : status === "escalated"
            ? "On screen"
            : status === "expired"
              ? "Expired"
              : "Dismissed";
  const card =
    "permission-surface rich-message-card w-full max-w-[520px] min-w-0 rounded-2xl bg-[#eeeeee] p-3 dark:bg-[#262626]";
  if (status !== "pending")
    return (
      <section
        className={`${card} permission-receipt`}
        aria-labelledby={titleId}
        aria-busy={status === "sending"}
        role="region"
      >
        <span className="permission-receipt-copy">
          <span className="permission-title" id={titleId}>
            {form.title}
          </span>
          <span className="permission-copy" role="status">
            {summary}
          </span>
        </span>
        <span className="permission-pill">
          {status === "submitted" && (
            <PermissionIcon name="check" className="size-3" />
          )}
          {status === "sending" && <span aria-hidden="true" className="permission-spinner" />}
          <span className="permission-pill-label">{label}</span>
        </span>
      </section>
    );
  return (
    <form
      className={`${card} flex flex-col gap-2.5`}
      aria-labelledby={titleId}
      autoComplete="on"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void submit();
      }}
    >
      <div className="flex min-w-0 flex-col">
        <span className="permission-title" id={titleId}>
          {form.title}
        </span>
        <span className="permission-copy">{form.instruction}</span>
      </div>
      {form.fields.map((field) => {
        const label = `${field.label}${field.required ? " *" : ""}`;
        return field.type === "checkbox" ? (
          <label className="flex min-w-0 items-center gap-2" key={field.id}>
            <input
              aria-label={field.label}
              aria-required={field.required || undefined}
              checked={values[field.id] === true}
              disabled={pending}
              name={field.id}
              onChange={(event) => set(field.id, event.target.checked)}
              type="checkbox"
            />
            <span className="permission-copy permission-checkbox-label">{label}</span>
          </label>
        ) : (
          <label className="permission-field" key={field.id}>
            <span className="permission-field-label">{label}</span>
            {field.type === "select" ? (
              <select
                className="permission-input"
                name={field.id}
                disabled={pending}
                onChange={(event) => set(field.id, event.target.value)}
                required={field.required}
                value={String(values[field.id] ?? "")}
              >
                <option value="" disabled />
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                className="permission-input"
                name={field.id}
                disabled={pending}
                onChange={(event) => set(field.id, event.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                value={String(values[field.id] ?? "")}
              />
            ) : (
              <input
                {...formInputAttributes(field, form.fields)}
                className="permission-input"
                disabled={pending}
                aria-label={field.label}
                onChange={(event) => set(field.id, event.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                value={String(values[field.id] ?? "")}
              />
            )}
          </label>
        );
      })}
      {form.submitAfterFill && (
        <p className="permission-field-label">
          After filling the code, this will press Enter on {form.domain}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] leading-[18px] text-red-600">
          {error}
        </p>
      )}
      <div className="permission-actions">
        <button
          className="permission-button permission-button-primary"
          disabled={pending || !valid}
          type="submit"
        >
          Continue
        </button>
        {message.senderBotId && (
          <button
            className="permission-button"
            disabled={pending}
            onClick={() => void submit("escalated")}
            type="button"
          >
            Open the screen
          </button>
        )}
        <button
          className="permission-button permission-button-ghost"
          disabled={pending}
          onClick={() => void submit("dismissed")}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </form>
  );
}

/** Browser autofill hints belong to the human form; values stay on the private host path. */
function formInputAttributes(
  field: UserFormField,
  siblings: UserFormField[]
): React.InputHTMLAttributes<HTMLInputElement> {
  if (field.type === "email") {
    const purpose = siblings.some((item) => item.type === "password" || item.type === "otp")
      ? "username"
      : "email";
    return { type: "text", name: purpose, autoComplete: purpose, inputMode: "email" };
  }
  if (field.type === "otp")
    return {
      type: "text",
      name: "one-time-code",
      autoComplete: "one-time-code",
      inputMode: "numeric",
    };
  if (field.type === "tel")
    return { type: "tel", name: field.id, autoComplete: "tel", inputMode: "tel" };
  if (field.type === "number")
    return { type: "number", name: field.id, autoComplete: "off", inputMode: "numeric" };
  if (field.type === "date") return { type: "date", name: field.id, autoComplete: "off" };
  if (formFieldIsSecret(field)) {
    const password =
      field.type === "password" ||
      /(?:^|[^a-z])(password|passwd|pwd|passcode)(?:$|[^a-z])/i.test(
        `${field.id.replace(/([a-z])([A-Z])/g, "$1 $2")} ${field.label}`
      );
    return {
      type: "password",
      name: password ? "password" : field.id,
      autoComplete: password ? "current-password" : "off",
    };
  }
  const username = /user|login|account/i.test(`${field.id} ${field.label}`);
  return {
    type: "text",
    name: username ? "username" : field.id,
    autoComplete: username ? "username" : "on",
  };
}
