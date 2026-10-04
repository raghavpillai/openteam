export interface UserFormTarget {
  kind: "ref" | "selector" | "label";
  value: string;
}
export interface UserFormField {
  id: string;
  label: string;
  type:
    | "text"
    | "email"
    | "tel"
    | "password"
    | "otp"
    | "number"
    | "date"
    | "select"
    | "textarea"
    | "checkbox";
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  secret?: boolean;
  target?: UserFormTarget;
  extra_key?: string;
}
export interface UserForm {
  title: string;
  instruction: string;
  reason?: "auth" | "checkout" | "profile" | "other";
  domain?: string;
  fields: UserFormField[];
  submitAfterFill?: boolean;
}
export interface UserFormReceipt {
  formId: string;
  status: "submitted" | "dismissed" | "escalated";
  fields: Array<{ id: string; status: "filled" | "held" | "unfilled" | "dropped" | "unknown" }>;
  submitAttempted: boolean;
  submitSucceeded: boolean;
  snapshot?: string;
  heldUntil?: string;
  interrupted?: boolean;
  title?: string;
  domain?: string;
  fieldTypes?: Record<string, UserFormField["type"]>;
  requestedSubmit?: boolean;
  fillFailureKinds?: Record<string, string>;
  domainMismatch?: { liveHost?: string };
  pageMoved?: { signal: "navigated" | "target_gone" };
  unknownFieldIds?: string[];
  heldFieldIds?: string[];
}
export type UserFormValues = Record<string, string | boolean>;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
};
const line = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};
const optionalBoolean = (value: unknown, name: string) => {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} must be a boolean`);
  return value as boolean | undefined;
};

export function normalizeFormDomain(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("A valid destination domain is required");
  return url.hostname.toLowerCase();
}
export function formFieldIsSecret(field: Pick<UserFormField, "type" | "secret">): boolean {
  return field.type === "password" || field.type === "otp" || field.secret === true;
}
export function formFieldIsPayment(field: Pick<UserFormField, "id" | "label">): boolean {
  return /(?:card.?number|credit.?card|debit.?card|cvv|cvc|security.?code|\bssn\b|social.?security|\biban\b|passport|government.?id|tax.?id)/i.test(
    `${field.id} ${field.label}`
  );
}
export function parseUserFormTarget(value: unknown): UserFormTarget {
  const item = record(value);
  if (!["ref", "selector", "label"].includes(String(item.kind)))
    throw new Error("Unknown form target kind");
  return {
    kind: item.kind as UserFormTarget["kind"],
    value: line(item.value, "target.value", 4096),
  };
}
export function parseUserForm(value: unknown): UserForm {
  const input = record(value);
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 8)
    throw new Error("A form needs 1–8 fields");
  const domain =
    typeof input.domain === "string" && input.domain.trim()
      ? normalizeFormDomain(input.domain.trim())
      : undefined;
  const ids = new Set<string>();
  const fields = input.fields.map((raw): UserFormField => {
    const item = record(raw);
    const id = line(item.id, "field.id", 64);
    if (String(item.id).trim().length > 64 || ids.has(id))
      throw new Error("Form field IDs must be unique and at most 64 characters");
    ids.add(id);
    if (
      ![
        "text",
        "email",
        "tel",
        "password",
        "otp",
        "number",
        "date",
        "select",
        "textarea",
        "checkbox",
      ].includes(String(item.type))
    )
      throw new Error(`Unknown field type for ${id}`);
    const type = item.type as UserFormField["type"];
    const secret = formFieldIsSecret({ type, secret: optionalBoolean(item.secret, "secret") });
    const target = item.target === undefined ? undefined : parseUserFormTarget(item.target);
    if ((target || secret) && !domain)
      throw new Error(`Field ${id} requires a verified destination domain`);
    if (secret && !target) throw new Error(`Secret field ${id} requires a fill target`);
    let options: UserFormField["options"];
    if (type === "select") {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 20)
        throw new Error(`Select field ${id} needs 1–20 options`);
      options = item.options.map((rawOption) => {
        const option = record(rawOption);
        return {
          label: line(option.label, "option.label", 120),
          value: line(option.value, "option.value", 1000),
        };
      });
    }
    const field: UserFormField = {
      id,
      type,
      label: line(item.label, "field.label", 120),
      ...(secret ? { secret: true } : {}),
      ...(target ? { target } : {}),
      ...(options ? { options } : {}),
      ...(item.required !== undefined
        ? { required: optionalBoolean(item.required, "required") }
        : {}),
      ...(typeof item.placeholder === "string"
        ? { placeholder: item.placeholder.slice(0, 400) }
        : {}),
    };
    if (typeof item.extra_key === "string" && item.extra_key.trim()) {
      if (
        secret ||
        formFieldIsPayment(field) ||
        /password|passcode|secret|token|api.?key|credential/i.test(
          `${field.id} ${field.label} ${item.extra_key}`
        )
      )
        throw new Error("Secret-shaped fields cannot use vault extras");
      field.extra_key = item.extra_key.trim().slice(0, 255);
    }
    return field;
  });
  const submitAfterFill = optionalBoolean(input.submitAfterFill, "submitAfterFill");
  if (submitAfterFill) {
    const anchors = fields.filter(
      (field) =>
        field.target && ["text", "email", "tel", "password", "otp", "number"].includes(field.type)
    );
    if (
      !domain ||
      anchors.length !== 1 ||
      fields.filter((field) => field.target).length !== 1 ||
      fields.some(formFieldIsPayment)
    )
      throw new Error(
        "submitAfterFill requires exactly one targeted single-line field and no payment or government-ID fields"
      );
  }
  if (
    input.reason !== undefined &&
    !["auth", "checkout", "profile", "other"].includes(String(input.reason))
  )
    throw new Error("Unknown form reason");
  return {
    title: line(input.title, "title", 120),
    instruction: line(input.instruction, "instruction", 400),
    fields,
    ...(domain ? { domain } : {}),
    ...(input.reason ? { reason: input.reason as UserForm["reason"] } : {}),
    ...(submitAfterFill ? { submitAfterFill: true } : {}),
  };
}

/** Values are only for the human-to-host path; never serialize them in a receipt. */
export function validateUserFormValues(form: UserForm, value: unknown): UserFormValues {
  const input = record(value);
  const result: UserFormValues = Object.create(null);
  for (const key of Object.keys(input))
    if (!form.fields.some((field) => field.id === key)) throw new Error("Unknown submitted field");
  for (const field of form.fields) {
    const value = input[field.id];
    if (value !== undefined && typeof value !== (field.type === "checkbox" ? "boolean" : "string"))
      throw new Error(`Invalid value for ${field.id}`);
    if (
      field.required &&
      (value === undefined || value === false || (typeof value === "string" && !value.trim()))
    )
      throw new Error(`${field.label} is required`);
    if (typeof value === "string" && value.length > 20_000)
      throw new Error("Submitted field exceeds the length limit");
    if (
      field.type === "select" &&
      typeof value === "string" &&
      value &&
      !field.options?.some((option) => option.value === value)
    )
      throw new Error("Invalid select option");
    if (typeof value === "string" || typeof value === "boolean") result[field.id] = value;
  }
  return result;
}

export function parseFormRemap(value: unknown): Array<{ fieldId: string; target: UserFormTarget }> {
  const input = record(value);
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 8)
    throw new Error("Supply 1–8 held field targets");
  const seen = new Set<string>();
  return input.targets.map((raw) => {
    const item = record(raw);
    if (Object.keys(item).some((key) => !["fieldId", "target"].includes(key)))
      throw new Error("Remap accepts targets only, never values");
    const fieldId = line(item.fieldId, "fieldId", 64);
    if (seen.has(fieldId)) throw new Error("Duplicate remap field");
    seen.add(fieldId);
    return { fieldId, target: parseUserFormTarget(item.target) };
  });
}

/** Whitelist the status-only host response before it reaches durable model data. */
export function parseUserFormReceipt(raw: unknown): UserFormReceipt {
  const value = record(raw);
  if (
    typeof value.formId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.formId) ||
    !["submitted", "dismissed", "escalated"].includes(String(value.status)) ||
    !Array.isArray(value.fields) ||
    value.fields.length > 8 ||
    typeof value.submitAttempted !== "boolean" ||
    typeof value.submitSucceeded !== "boolean"
  )
    throw new Error("Invalid form receipt");
  const fields = value.fields.map((raw) => {
    const field = record(raw);
    if (
      typeof field.id !== "string" ||
      !field.id ||
      field.id.length > 64 ||
      !["filled", "held", "unfilled", "dropped", "unknown"].includes(String(field.status))
    )
      throw new Error("Invalid form field receipt");
    return { id: field.id, status: field.status as UserFormReceipt["fields"][number]["status"] };
  });
  return {
    formId: value.formId,
    status: value.status as UserFormReceipt["status"],
    fields,
    submitAttempted: value.submitAttempted,
    submitSucceeded: value.submitSucceeded,
    ...(typeof value.title === "string" ? {title:value.title.slice(0,200)} : {}),
    ...(typeof value.domain === "string" ? {domain:normalizeFormDomain(value.domain)} : {}),
    ...(value.requestedSubmit === true ? {requestedSubmit:true} : {}),
    ...(value.fieldTypes && typeof value.fieldTypes === "object" ? {fieldTypes:Object.fromEntries(Object.entries(value.fieldTypes).filter(([key,type]) => fields.some(field=>field.id===key) && ["text","email","tel","password","otp","number","date","select","textarea","checkbox"].includes(String(type)))) as Record<string,UserFormField["type"]>} : {}),
    ...(value.fillFailureKinds && typeof value.fillFailureKinds === "object" ? {fillFailureKinds:Object.fromEntries(Object.entries(value.fillFailureKinds).filter(([key,kind])=>fields.some(field=>field.id===key) && ["driver_unavailable","target_gone","target_missing","in_unreachable_frame","in_closed_shadow","fill_op_failed","hidden_target","page_moved"].includes(String(kind)))) as Record<string,string>} : {}),
    ...(value.domainMismatch && typeof value.domainMismatch === "object" ? {domainMismatch: typeof (value.domainMismatch as any).liveHost === "string" ? {liveHost:normalizeFormDomain((value.domainMismatch as any).liveHost)} : {}} : {}),
    ...(value.pageMoved && typeof value.pageMoved === "object" && ["navigated","target_gone"].includes((value.pageMoved as any).signal) ? {pageMoved:{signal:(value.pageMoved as any).signal}} : {}),
    ...(value.interrupted === true ? { interrupted: true } : {}),
    ...(typeof value.snapshot === "string" ? { snapshot: value.snapshot.slice(0, 32000) } : {}),
    ...(typeof value.heldUntil === "string" && Number.isFinite(Date.parse(value.heldUntil))
      ? { heldUntil: value.heldUntil }
      : {}),
  };
}
