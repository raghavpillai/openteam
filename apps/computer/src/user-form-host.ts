import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile, access, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  formFieldIsPayment,
  formFieldIsSecret,
  normalizeFormDomain,
  parseFormRemap,
  parseUserForm,
  validateUserFormValues,
  type UserForm,
  type UserFormField,
  type UserFormReceipt,
  type UserFormValues,
} from "@openteam/contracts";

export interface FormPageBinding {
  pageId: string;
  domain: string;
  sessionId?: string;
}
export interface FormBrowser {
  prepare(form: UserForm): Promise<{ binding: FormPageBinding; reachable: string[] }>;
  fill(binding: FormPageBinding, field: UserFormField, value: string | boolean): Promise<boolean>;
  submit(binding: FormPageBinding, field: UserFormField): Promise<boolean>;
  snapshot(binding: FormPageBinding): Promise<string>;
  canSave?(binding: FormPageBinding, field: UserFormField): Promise<boolean>;
}
interface SavedForm {
  botId: string;
  form: UserForm;
  binding?: FormPageBinding;
  createdAt: number;
  receipt?: UserFormReceipt;
  values?: UserFormValues;
  heldUntil?: number;
  remapped?: boolean;
  processing?: boolean;
  remapCallId?: string;
  remapProcessing?: boolean;
  remapPending?: boolean;
}
interface VaultEntry {
  key: string;
  label: string;
  value: string;
  updatedAt: number;
}
interface FormState {
  forms: Record<string, SavedForm>;
  vault: VaultEntry[];
}

export function formVaultKey(field: UserFormField, domain?: string): string | null {
  if (
    formFieldIsSecret(field) ||
    formFieldIsPayment(field) ||
    ["select", "checkbox"].includes(field.type)
  )
    return null;
  const descriptor = `${field.id} ${field.label}`.replace(/[_-]+/g, " ");
  if (/password|passcode|secret|token|api.?key|credential/i.test(descriptor)) return null;
  if (/user\s*(?:name|id)|screen\s*name/i.test(descriptor))
    return domain ? `username:${normalizeFormDomain(domain)}` : null;
  if (field.type === "email" || /\be-?mail\b/i.test(descriptor)) return "email";
  if (field.type === "tel" || /\b(?:phone|mobile|telephone|cell)\b/i.test(descriptor))
    return "phone";
  if (/\b(?:address|street|addr)\b/i.test(descriptor)) return "address";
  if (/\bname\b/i.test(descriptor) && !/company|business|account|login/i.test(descriptor)) {
    return /first|given/i.test(descriptor)
      ? "name:first"
      : /last|family|surname/i.test(descriptor)
        ? "name:last"
        : "name:full";
  }
  return field.extra_key ? `extra:${field.extra_key}` : null;
}

/** Only this host store sees submitted values. Encrypted state and its key are
 * private supervisor files, outside the agent UID's readable filesystem. */
export class UserFormHost {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly browser: (botId: string) => Promise<FormBrowser>
  ) {}

  private async state<T>(
    action: (state: FormState, checkpoint: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const operation = this.chain
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const keyPath = join(this.directory, "key");
        const statePath = join(this.directory, "state.enc");
        let key: Buffer;
        try {
          key = await readFile(keyPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (
            await access(statePath).then(
              () => true,
              () => false
            )
          )
            throw new Error("The private form key is missing; existing data was preserved");
          key = randomBytes(32);
          try {
            await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            key = await readFile(keyPath);
          }
        }
        let state: FormState = { forms: {}, vault: [] };
        try {
          const encrypted = await readFile(statePath);
          const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
          decipher.setAuthTag(encrypted.subarray(12, 28));
          state = JSON.parse(
            Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString()
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("The private form store cannot be read; existing data was preserved");
        }
        for (const [id, saved] of Object.entries(state.forms)) {
          if (saved.createdAt < Date.now() - 7 * 86_400_000) {
            delete state.forms[id];
            continue;
          }
          if (saved.heldUntil && saved.heldUntil < Date.now()) {
            delete saved.values;
            delete saved.heldUntil;
            if (saved.receipt) {
              delete saved.receipt.heldUntil;
              saved.receipt.fields = saved.receipt.fields.map((field) =>
                field.status === "held" ? { ...field, status: "dropped" } : field
              );
            }
          }
        }
        const checkpoint = async () => {
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, nonce);
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
          const temporary = `${statePath}.${randomUUID()}.tmp`;
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
            await file.sync();
          } finally {
            await file.close();
          }
          try {
            await rename(temporary, statePath);
          } finally {
            await rm(temporary, { force: true });
          }
        };
        const result = await action(state, checkpoint);
        await checkpoint();
        return result;
      });
    this.chain = operation;
    return operation;
  }

  async prepare(botId: string, formId: string, raw: unknown) {
    const form = parseUserForm(raw);
    return this.state(async (state) => {
      const existing = state.forms[formId];
      if (existing) {
        if (existing.botId !== botId) throw new Error("Form is unavailable");
        return existing.form;
      }
      let binding: FormPageBinding | undefined;
      if (form.fields.some((field) => field.target)) {
        const prepared = await (await this.browser(botId)).prepare(form);
        if (normalizeFormDomain(prepared.binding.domain) !== form.domain)
          throw new Error("The browser page does not match the requested domain");
        const reachable = new Set(prepared.reachable);
        form.fields = form.fields.filter((field) => !field.target || reachable.has(field.id));
        if (!form.fields.some((field) => field.target))
          throw new Error(
            "No requested fields are reachable on the page. Use request_box_help so the user can complete this step directly."
          );
        binding = prepared.binding;
      }
      state.forms[formId] = { botId, form, binding, createdAt: Date.now() };
      return form;
    });
  }

  async prefill(botId: string, formId: string) {
    return this.state(async (state) => {
      const saved = this.requireForm(state, botId, formId);
      return Object.fromEntries(
        saved.form.fields.flatMap((field) => {
          const key = formVaultKey(field, saved.form.domain);
          if (!key) return [];
          const entry = state.vault
            .filter((entry) => entry.key === key)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          return entry ? [[field.id, entry.value]] : [];
        })
      );
    });
  }

  async submit(botId: string, formId: string, rawValues: unknown, saveToVault = false) {
    return this.state(async (state, checkpoint) => {
      const saved = this.requireForm(state, botId, formId);
      if (saved.receipt) return saved.receipt;
      if (saved.processing) {
        delete saved.values;
        return (saved.receipt = {
          formId,
          status: "submitted",
          interrupted: true,
          fields: saved.form.fields.map((field) => ({ id: field.id, status: "unknown" })),
          submitAttempted: false,
          submitSucceeded: false,
        });
      }
      const values = validateUserFormValues(saved.form, rawValues);
      saved.processing = true;
      await checkpoint();
      const receipt = await this.fill(formId, saved, values, false);
      delete saved.processing;
      if (saveToVault)
        for (const field of saved.form.fields) {
          const value = values[field.id];
          const key = formVaultKey(field, saved.form.domain);
          if (
            field.target &&
            (!saved.binding ||
              !(await (
                await this.browser(botId)
              )
                .canSave?.(saved.binding, field)
                .catch(() => false)))
          )
            continue;
          if (key && typeof value === "string" && value.trim() && value.length <= 1024) {
            state.vault = state.vault.filter(
              (entry) => !(entry.key === key && entry.value === value)
            );
            state.vault.push({ key, value, label: field.label, updatedAt: Date.now() });
            state.vault = state.vault.slice(-200);
          }
        }
      saved.receipt = receipt;
      return receipt;
    });
  }

  async dismiss(botId: string, formId: string) {
    return this.state(async (state) => {
      const saved = this.requireForm(state, botId, formId);
      if (saved.receipt) return saved.receipt;
      delete saved.values;
      return (saved.receipt = {
        formId,
        status: "dismissed",
        fields: [],
        submitAttempted: false,
        submitSucceeded: false,
      });
    });
  }

  async remap(botId: string, raw: unknown, callId?: string) {
    const targets = parseFormRemap(raw);
    return this.state(async (state, checkpoint) => {
      const previous = Object.values(state.forms).find(
        (form) =>
          form.botId === botId && ((callId && form.remapCallId === callId) || form.remapPending)
      );
      if (previous) {
        if (previous.remapProcessing) {
          delete previous.values;
          delete previous.heldUntil;
          delete previous.remapProcessing;
          previous.receipt = {
            formId: previous.receipt!.formId,
            status: "submitted",
            interrupted: true,
            fields: previous.receipt!.fields.map((field) =>
              field.status === "held" ? { ...field, status: "unknown" } : field
            ),
            submitAttempted: false,
            submitSucceeded: false,
          };
        }
        return previous.receipt!;
      }
      const candidate = Object.entries(state.forms)
        .filter(([, item]) => item.botId === botId && item.values && !item.remapped)
        .sort(([, a], [, b]) => b.createdAt - a.createdAt)[0];
      if (!candidate) throw new Error("No held form fields remain for this bot");
      const [formId, saved] = candidate;
      const held = saved.values!;
      if (targets.some((target) => !Object.hasOwn(held, target.fieldId)))
        throw new Error("Remap accepts only field IDs listed as HELD");
      const selected = new Set(targets.map((target) => target.fieldId));
      const dropped = Object.keys(held).filter((id) => !selected.has(id));
      const fields = targets.map((target) => ({
        ...saved.form.fields.find((field) => field.id === target.fieldId)!,
        target: target.target,
      }));
      saved.remapped = true;
      saved.remapCallId = callId;
      saved.remapProcessing = true;
      saved.remapPending = true;
      await checkpoint();
      const original = saved.form;
      saved.form = { ...original, fields, submitAfterFill: false };
      const receipt = await this.fill(formId, saved, held, true);
      saved.form = original;
      delete saved.remapProcessing;
      receipt.fields.push(...dropped.map((id) => ({ id, status: "dropped" as const })));
      delete saved.values;
      delete saved.heldUntil;
      saved.receipt = receipt;
      return receipt;
    });
  }

  async pendingRemaps(botId: string) {
    return this.state(async (state) =>
      Object.values(state.forms)
        .filter((saved) => saved.botId === botId && saved.remapPending && saved.receipt)
        .map((saved) => {
          if (saved.remapProcessing) {
            delete saved.remapProcessing;
            delete saved.values;
            delete saved.heldUntil;
            saved.receipt = {
              ...saved.receipt!,
              interrupted: true,
              fields: saved.receipt!.fields.map((field) =>
                field.status === "held" ? { ...field, status: "unknown" } : field
              ),
              submitAttempted: false,
              submitSucceeded: false,
            };
          }
          return saved.receipt!;
        })
    );
  }
  async acknowledgeRemap(botId: string, formId: string) {
    return this.state(async (state) => {
      const saved = this.requireForm(state, botId, formId);
      delete saved.remapPending;
    });
  }

  private requireForm(state: FormState, botId: string, formId: string): SavedForm {
    const saved = state.forms[formId];
    if (!saved || saved.botId !== botId) throw new Error("Form is unavailable or expired");
    return saved;
  }

  private async fill(
    formId: string,
    saved: SavedForm,
    values: UserFormValues,
    remap: boolean
  ): Promise<UserFormReceipt> {
    const receipt: UserFormReceipt = {
      formId,
      status: "submitted",
      fields: [],
      submitAttempted: false,
      submitSucceeded: false,
    };
    let browser: FormBrowser | undefined;
    if (saved.binding) browser = await this.browser(saved.botId).catch(() => undefined);
    const held: UserFormValues = Object.create(null);
    for (const field of saved.form.fields) {
      const value = values[field.id];
      if (!field.target || value === undefined || value === "") {
        receipt.fields.push({ id: field.id, status: "unfilled" });
        continue;
      }
      const filled = Boolean(
        browser &&
          saved.binding &&
          (await browser.fill(saved.binding, field, value).catch(() => false))
      );
      receipt.fields.push({ id: field.id, status: filled ? "filled" : remap ? "dropped" : "held" });
      if (!filled && !remap) held[field.id] = value;
    }
    if (
      saved.form.submitAfterFill &&
      saved.binding &&
      browser &&
      saved.form.fields
        .filter((field) => field.target)
        .every((field) =>
          receipt.fields.some((item) => item.id === field.id && item.status === "filled")
        )
    ) {
      receipt.submitAttempted = true;
      receipt.submitSucceeded = await browser
        .submit(saved.binding, saved.form.fields.find((field) => field.target)!)
        .catch(() => false);
    }
    if (Object.keys(held).length) {
      saved.values = held;
      saved.heldUntil = Date.now() + 15 * 60_000;
      receipt.heldUntil = new Date(saved.heldUntil).toISOString();
      if (browser && saved.binding) {
        let snapshot = await browser
          .snapshot(saved.binding)
          .catch(() => "Browser snapshot unavailable; use request_box_help.");
        for (const value of Object.values(values))
          if (typeof value === "string" && value)
            snapshot = snapshot.split(value).join("[withheld]");
        receipt.snapshot = snapshot;
      }
    } else {
      delete saved.values;
      delete saved.heldUntil;
    }
    return receipt;
  }
}
