import type { ChannelMessageView } from "@openteam/contracts";
import {
  formFieldIsSecret,
  validateUserFormValues,
  type UserForm,
} from "@openteam/contracts/review-cards";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";

export function UserFormCard({ message, form }: { message: ChannelMessageView; form: UserForm }) {
  const inFlight = useRef(false);
  const metadata = message.metadata as Record<string, unknown>;
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [save, setSave] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setState(String(metadata.cardState ?? "pending"));
  }, [metadata.cardState]);
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
  const submit = async (dismiss = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = dismiss
        ? await api.dismissUserForm(message.id)
        : await api.submitUserForm(message.id, values, save);
      setValues({});
      setState(
        String((result.message.metadata as Record<string, unknown>).cardState ?? "submitted")
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "The form could not be completed. Try again."
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <form
      className="rich-message-card flex w-full max-w-[520px] flex-col gap-3 rounded-2xl bg-[#eeeeee] p-4 text-sm dark:bg-[#262626]"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void submit();
      }}
    >
      <strong className="text-base">{form.title}</strong>
      {state !== "pending" ? (
        <p>
          {state === "dismissed"
            ? "Form dismissed"
            : state === "expired"
              ? "This form expired. Request a new form to continue."
              : state === "submitted"
                ? "Form submitted. Check the field status before continuing."
                : "The form could not finish filling every field. The bot can check the destination and recover held fields."}
        </p>
      ) : (
        <>
          <p>{form.instruction}</p>
          <p className="text-xs text-muted-foreground">
            {form.domain
              ? `Fill only on ${form.domain}`
              : "No destination website. These answers will not be filled into a page."}
          </p>
          {form.fields.map((field) => (
            <label className="flex flex-col gap-1.5" key={field.id}>
              <span>
                {field.label}
                {field.required ? " *" : ""}
              </span>
              {field.type === "checkbox" ? (
                <input
                  aria-label={field.label}
                  checked={values[field.id] === true}
                  disabled={pending}
                  onChange={(event) => set(field.id, event.target.checked)}
                  required={field.required}
                  type="checkbox"
                />
              ) : field.type === "select" ? (
                <select
                  className="rounded-lg border bg-background p-2"
                  disabled={pending}
                  onChange={(event) => set(field.id, event.target.value)}
                  required={field.required}
                  value={String(values[field.id] ?? "")}
                >
                  <option value="">Choose…</option>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  className="rounded-lg border bg-background p-2"
                  disabled={pending}
                  onChange={(event) => set(field.id, event.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  value={String(values[field.id] ?? "")}
                />
              ) : (
                <input
                  autoComplete={
                    field.type === "otp"
                      ? "one-time-code"
                      : formFieldIsSecret(field)
                        ? "current-password"
                        : "on"
                  }
                  className="rounded-lg border bg-background p-2"
                  disabled={pending}
                  onChange={(event) => set(field.id, event.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  type={formFieldIsSecret(field) ? "password" : field.type}
                  value={String(values[field.id] ?? "")}
                />
              )}
            </label>
          ))}
          {form.fields.some((field) => !formFieldIsSecret(field)) && (
            <label className="flex items-center gap-2 text-xs">
              <input
                checked={save}
                disabled={pending}
                onChange={(event) => setSave(event.target.checked)}
                type="checkbox"
              />
              Save nonsecret information for future forms
            </label>
          )}
          {form.submitAfterFill && (
            <p className="text-xs">
              After filling the code, this will press Enter on {form.domain}.
            </p>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              className="rounded-lg px-3 py-2"
              disabled={pending}
              onClick={() => void submit(true)}
              type="button"
            >
              Dismiss
            </button>
            <button
              className="rounded-lg bg-foreground px-3 py-2 text-background disabled:opacity-40"
              disabled={pending || !valid}
              type="submit"
            >
              {pending ? "Working…" : form.submitAfterFill ? "Fill and press Enter" : "Continue"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
