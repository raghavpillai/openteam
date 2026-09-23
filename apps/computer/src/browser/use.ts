import { snapshotAcrossFrames, refHandle, frameRefsByPage, referenceFill, referenceType, editableHandle, writeTargetFrameIsHidden, WRITE_TARGET_IS_HIDDEN_FN, gotoWithRecovery, navigationNote, recoverErrorPage, settleIntoErrorPage, isChromeErrorPage, markSecretFill, SPLIT_CHAR_GROUP_FN } from "./reference-driver";
import { resolveReferenceSelectOptions } from "./reference-select";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { BrowserDownloads } from "./downloads";
import type { Browser, BrowserContext, CDPSession, Dialog, ElementHandle, Frame, Locator, Page } from "playwright-core";
import { outOfProcessPlaywright } from "./playwright-driver";
import { normalizeFormDomain, formFieldIsSecret, type UserForm, type UserFormField } from "@openteam/contracts";
import type { FormPageBinding } from "../user-form-host";
import { redactSecrets } from "@openteam/shell-jobs";

type JsonObject = Record<string, unknown>;
export interface LoginPageBinding {
  focused?: boolean;
  pageId: string;
  origin: string;
  document: ElementHandle<HTMLElement>;
  password: ElementHandle<HTMLInputElement> | null;
  username: ElementHandle<HTMLInputElement> | null;
}
export function secureLoginOrigin(site: string): string {
  const url = new URL(site);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("Saved logins require HTTPS or a loopback origin");
  return url.origin;
}

const textResult = (
  text: string,
  details: Record<string, unknown> = {}
): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text }],
  details,
});

const boundedJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= 100_000
    ? serialized
    : `${serialized.slice(0, 100_000)}\n… browser output truncated`;
};

export const assertAllowedCdpMethod = (method: string): void => {
  const denied = [
    /^Input\./,
    /^Browser\./,
    /^Storage\./,
    /^Target\./,
    /^Security\./,
    /^SystemInfo\./,
    /^Tethering\./,
    /^Cast\./,
    /^Network\.(?:clearBrowserCache|clearBrowserCookies|deleteCookies|getAllCookies|getCookies|setCookie|setCookies|setExtraHTTPHeaders)$/,
    /^Emulation\.setGeolocationOverride$/,
    /^Page\.setDownloadBehavior$/,
  ];
  if (
    !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method) ||
    denied.some((rule) => rule.test(method))
  ) {
    throw new Error(`CDP method is not allowed: ${method}`);
  }
};

interface SnapshotElement {
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  disabled: boolean;
}

const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable="true"],[role],[tabindex]';

export const truncateAriaSnapshot = (snapshot: string, maxDepth: number): string => {
  const boundedDepth = Math.max(1, Math.min(40, Math.trunc(maxDepth)));
  const kept: string[] = [];
  let omitted = false;
  for (const line of snapshot.split("\n")) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    const depth = Math.floor(indentation / 2) + 1;
    if (depth <= boundedDepth) kept.push(line);
    else omitted = true;
  }
  if (omitted) kept.push(`${"  ".repeat(boundedDepth)}- … deeper structure omitted`);
  return kept.join("\n").trim();
};

export const sameOriginFrame = (pageUrl: string, frameUrl: string): boolean => {
  if (frameUrl === "about:blank" || frameUrl === "about:srcdoc") return true;
  try {
    return new URL(pageUrl).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
};

export class BrowserUseSession {
  private readonly ids = new WeakMap<Page, string>();
  private readonly refs = new Map<string, Map<string, ElementHandle<HTMLElement>>>();
  private readonly ownedPages = new Set<Page>();
  private readonly openers = new WeakMap<Page, Page>();
  private readonly targetIds = new Map<string, string>();
  private readonly cdpSessions = new WeakMap<Page, Promise<CDPSession>>();
  private nextViewId = 1;
  private currentViewId: string | null = null;
  private screenshotOrdinal = 0;
  private downloads?: BrowserDownloads;
  private readonly dialogs = new Map<Page, Dialog>();
  private readonly dialogObservers = new WeakMap<Page, Promise<void>>();
  private dialogOpened?: (page: Page) => void;
  private unfinishedOperation?: Promise<AgentToolResult<Record<string, unknown>>>;
  private dialogTimedOutOperation?: Promise<AgentToolResult<Record<string, unknown>>>;
  private cancelledNavigation?: Promise<AgentToolResult<Record<string, unknown>>>;
  private async drainDialogAction(): Promise<void> {
    const operation = this.unfinishedOperation;
    try { await operation; }
    catch (error) {
      // The dialog can arrive while the action's post-click screenshot starts.
      // Its failed observation is superseded by the fresh post-dialog snapshot.
      const expiredWhileDialogOpen = operation && operation === this.dialogTimedOutOperation &&
        /[Tt]imeout\s+\d+ms exceeded/.test(String(error));
      if (!expiredWhileDialogOpen && !/Open JavaScript dialog prevents evaluation/.test(String(error)) &&
          !(operation && operation === this.cancelledNavigation && /net::ERR_ABORTED/.test(String(error)))) throw error;
    }
    finally {
      if (this.unfinishedOperation === operation) this.unfinishedOperation = undefined;
      if (this.cancelledNavigation === operation) this.cancelledNavigation = undefined;
      if (this.dialogTimedOutOperation === operation) this.dialogTimedOutOperation = undefined;
    }
  }

  private dialogState(page: Page, summary = "Browser action opened a dialog") {
    const dialog = this.dialogs.get(page)!;
    const pendingDialog = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() };
    return textResult(`${summary}. Pending ${pendingDialog.type}: ${pendingDialog.message}\n` +
      `The page is paused. Use browser_cdp with method Page.handleJavaScriptDialog and params {accept: true|false, promptText?: string}, or respond through native Computer controls. Do not repeat the action that opened it.`,
      { viewId: this.idFor(page), url: page.url(), pendingDialog });
  }

  private async observeDialogs(page: Page): Promise<void> {
    let observer = this.dialogObservers.get(page);
    if (!observer) {
      observer = (async () => {
        const cdp = await this.cdpFor(page);
        cdp.on("Page.javascriptDialogClosed", event => {
          if (!event.result && this.dialogs.get(page)?.type() === "beforeunload")
            this.cancelledNavigation = this.unfinishedOperation;
          this.dialogs.delete(page);
        });
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        this.targetIds.set(this.idFor(page), targetInfo.targetId);
        await cdp.send("Page.enable");
      })().catch(error => { this.dialogObservers.delete(page); throw error; });
      this.dialogObservers.set(page, observer);
    }
    // A popup can pause in its first script before Page.enable finishes. Its
    // dialog must remain answerable while observation is being initialized.
    if (this.dialogs.has(page)) void observer.catch(() => {});
    else await observer;
  }

  private cdpFor(page: Page): Promise<CDPSession> {
    let connection = this.cdpSessions.get(page);
    if (!connection) {
      connection = this.context.newCDPSession(page).catch(error => {
        this.cdpSessions.delete(page);
        throw error;
      });
      this.cdpSessions.set(page, connection);
    }
    return connection;
  }

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly artifactDirectory: string,
    private readonly downloadDirectory: string,
    private readonly adoptDesktopPages = false
  ) {
    // Playwright otherwise auto-dismisses dialogs with no listeners, including
    // dialogs in another worker's tab on a separate connection to this Chrome.
    context.on("dialog", dialog => {
      const page = dialog.page();
      if (!page) return;
      if (this.ownedPages.has(page)) this.recordDialog(page, dialog);
      else void page.opener().then(opener => {
        if (!opener || !this.ownedPages.has(opener) || page.isClosed()) return;
        this.openers.set(page, opener);
        this.trackPage(page);
        this.currentViewId = this.idFor(page);
        this.recordDialog(page, dialog);
      }).catch(() => {});
    });
  }

  private recordDialog(page: Page, dialog: Dialog): void {
    if (this.dialogs.get(page) === dialog) return;
    this.dialogs.set(page, dialog);
    this.dialogOpened?.(page);
  }

  // The runtime endpoint belongs to one bot desktop. Native Chrome and its
  // managed workers must see the same tabs; explicit false retains an isolated
  // lease for callers that intentionally share an endpoint with unrelated work.
  static async connect(endpoint: string, artifactDirectory: string, adoptExisting = true, downloadDirectory = join(homedir(), "Downloads"), lease?: { targets: Map<string, string>; selected: string | null; nextId: number }): Promise<BrowserUseSession> {
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chromium did not provide a default browser context");
    const session = new BrowserUseSession(browser, context, artifactDirectory, downloadDirectory, adoptExisting);
    session.downloads = await BrowserDownloads.create(browser, context, () => session.leasedPages(), downloadDirectory);
    if (lease) {
      session.nextViewId = lease.nextId;
      session.currentViewId = lease.selected;
      for (const page of context.pages()) {
        const cdp = await context.newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send("Target.getTargetInfo");
          const match = [...lease.targets].find(([, target]) => target === targetInfo.targetId);
          if (match) {
            session.ids.set(page, match[0]);
            session.targetIds.set(match[0], targetInfo.targetId);
            session.trackPage(page);
          }
        } finally { await cdp.detach(); }
      }
    }
    if (adoptExisting) {
      for (const page of context.pages()) session.trackPage(page);
      context.on("page", page => session.trackPage(page));
      if (!lease) {
        const latest = session.leasedPages().at(-1);
        if (latest) session.currentViewId = session.idFor(latest);
      }
    } else if (!lease) session.trackPage(await context.newPage());
    await session.ensurePage();
    return session;
  }

  async reconnect(endpoint: string): Promise<BrowserUseSession> {
    // Retain exact IDs and selection. Desktop sessions also adopt new native
    // tabs from their same scoped endpoint; isolated leases never do so.
    // The failed action is not replayed. Element refs must be observed again.
    const session = await BrowserUseSession.connect(endpoint, this.artifactDirectory, this.adoptDesktopPages, this.downloadDirectory,
      { targets: this.targetIds, selected: this.currentViewId, nextId: this.nextViewId });
    session.registerPrivateValues([...this.privateValues]);
    return session;
  }

  get connected(): boolean {
    return this.browser.isConnected();
  }

  private readonly privateValues = new Set<string>();
  registerPrivateValues(values: string[]) { for (const value of values) if (value) this.privateValues.add(value); }
  async currentLoginSite(): Promise<string | null> {
    try { return secureLoginOrigin((await this.ensurePage()).url()); } catch { return null; }
  }
  async focusedLoginSite(): Promise<string | null> {
    const focused = [];
    for (const page of this.leasedPages()) {
      try { if (await page.evaluate(() => document.hasFocus() && document.visibilityState === "visible")) focused.push(secureLoginOrigin(page.url())); } catch { /* Closed or non-web page. */ }
    }
    return focused.length === 1 ? focused[0]! : null;
  }
  watchLoginFocus(fill: (site: string) => Promise<unknown>): () => void {
    let busy = false;
    const timer = setInterval(async () => {
      if (!this.connected) { clearInterval(timer); return; }
      if (busy) return;
      busy = true;
      try { const site = await this.focusedLoginSite(); if (site) await fill(site); } catch { /* Passive fill never interrupts browser use. */ }
      finally { busy = false; }
    }, 1500);
    timer.unref();
    return () => clearInterval(timer);
  }
  async loginBinding(site: string, focused = false): Promise<LoginPageBinding> {
    const origin = secureLoginOrigin(site);
    const candidates = this.leasedPages().filter(page => { try { return new URL(page.url()).origin === origin; } catch { return false; } });
    if (candidates.length !== 1) throw new Error("Open exactly one browser tab for the requested login site before using its saved credential");
    const page = candidates[0]!;
    if (focused && !await page.evaluate(() => globalThis.document.hasFocus() && globalThis.document.visibilityState === "visible")) throw new Error("The login page is not focused");
    const document = await page.$("html") as ElementHandle<HTMLElement> | null;
    const visible = async (selector: string) => {
      const handles = await page.$$(selector) as ElementHandle<HTMLInputElement>[];
      const result: ElementHandle<HTMLInputElement>[] = [];
      for (const handle of handles) if (await handle.evaluate(e => e.isConnected && !e.disabled && !e.readOnly && !!e.getClientRects().length)) result.push(handle); else await handle.dispose();
      return result;
    };
    const passwords = await visible('input[type="password"]');
    const users = await visible('input[autocomplete="username"],input[type="email"],input[name="username"],input[name="email"],input[id="username"]');
    if (!document || passwords.length > 1 || users.length > 1 || (!passwords.length && !users.length)) {
      await document?.dispose(); await Promise.all([...passwords,...users].map(h => h.dispose()));
      throw new Error("The page has no unambiguous login fields");
    }
    if (passwords[0] && await passwords[0].evaluate(field => Boolean(field.value))) {
      await document.dispose(); await Promise.all([...passwords,...users].map(handle=>handle.dispose()));
      throw new Error("The login password field is already filled");
    }
    if (!passwords.length && users[0] && await users[0].evaluate(field => Boolean(field.value))) {
      await document.dispose(); await Promise.all(users.map(handle => handle.dispose()));
      throw new Error("The login username field is already filled");
    }
    return { pageId: await this.formPageId(page), origin, document, password: passwords[0] ?? null, username: users[0] ?? null, focused };
  }
  async releaseLoginBinding(binding: LoginPageBinding) {
    await Promise.all([binding.document,binding.password,binding.username].map(handle => handle?.dispose().catch(() => {})));
  }
  async fillSavedLogin(binding: LoginPageBinding, credential: { origin: string; username?: string; password: string }): Promise<boolean> {
    if (credential.origin !== binding.origin) throw new Error("Credential origin mismatch");
    this.registerPrivateValues([credential.password, credential.username ?? ""]);
    try {
      // Element handles bind review to this exact document and these exact fields.
      // A reload, replacement field, redirect or changed form refuses the fill.
      const eligible = () => binding.document.evaluate((root,{origin,userField,passwordField,username,focused})=>{
        const live=(node:HTMLInputElement|null)=>!node || (node.isConnected&&node.ownerDocument===document&&!node.disabled&&!node.readOnly&&!!node.getClientRects().length);
        return (!focused || (document.hasFocus() && document.visibilityState === "visible"))&&root===document.documentElement&&root.isConnected&&location.origin===origin&&live(userField)&&live(passwordField)&&(!passwordField||!passwordField.value)&&(!userField?.value||userField.value===username)&&(!passwordField||!userField||passwordField.form===userField.form);
      },{origin:binding.origin,userField:binding.username,passwordField:binding.password,username:credential.username,focused:binding.focused});
      if(!await eligible())return false;
      const page=await this.formPage({pageId:binding.pageId,domain:new URL(binding.origin).hostname});
      if(binding.username && credential.username!==undefined)await referenceFill({page,element:binding.username,request:{element:"login username",value:credential.username,secret:true}});
      if(!await eligible())return false;
      if(binding.password)await referenceFill({page,element:binding.password,request:{element:"login password",value:credential.password,secret:true}});
      return await binding.document.evaluate((root,origin)=>root===document.documentElement&&root.isConnected&&location.origin===origin,binding.origin);
    } catch { return false; }
  }

  async importPrivateCookies(cookies: Array<Record<string, unknown>>): Promise<{injected:number;failed:number}> {
    this.registerPrivateValues(cookies.flatMap(cookie => typeof cookie.value === "string" ? [cookie.value] : []));
    const page = await this.ensurePage(); const cdp = await this.context.newCDPSession(page);
    let injected = 0;
    try {
      for (const cookie of cookies) {
        try { const result = await cdp.send("Network.setCookie", cookie as never); if (!result.success) break; injected++; }
        catch { break; }
      }
      return {injected,failed:cookies.length-injected};
    }
    finally { await cdp.detach(); }
  }

  private readonly formPageIds = new WeakMap<Page, string>();
  private async formPageId(page: Page): Promise<string> {
    const known = this.formPageIds.get(page); if (known) return known;
    const cdp = await this.context.newCDPSession(page);
    try {
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      this.formPageIds.set(page, targetInfo.targetId); return targetInfo.targetId;
    } finally { await cdp.detach(); }
  }

  async formPages(domain: string): Promise<FormPageBinding[]> {
    const pages: FormPageBinding[] = [];
    for (const page of this.leasedPages()) {
      try { if (normalizeFormDomain(page.url()) === domain) pages.push({ pageId: await this.formPageId(page), domain, url: page.url() }); } catch { /* Non-web tab. */ }
    }
    return pages;
  }

  private async formPage(binding: FormPageBinding): Promise<Page> {
    for (const page of this.leasedPages()) if (await this.formPageId(page) === binding.pageId) {
      if (normalizeFormDomain(page.url()) !== binding.domain) throw Object.assign(new Error("The form page changed domain"), {kind:"domain_mismatch",liveHost:normalizeFormDomain(page.url())});
      if (binding.url && page.url() !== binding.url) throw Object.assign(new Error("The form page moved"), {kind:"page_moved"});
      return page;
    }
    throw Object.assign(new Error("The form tab is no longer available"), {kind:"page_moved"});
  }

  private async formHandle(page: Page, field: UserFormField): Promise<ElementHandle<HTMLElement>> {
    const target = field.target; if (!target) throw new Error("No fill target");
    let handle: ElementHandle<HTMLElement> | null = null;
    if (target.kind === "ref") {
      try {handle = await this.requireRef(page, target.value.replace(/^\[?ref=|\]$/g, ""));}
      catch {
        // A stale ref can recover only by this field's own label, on the same consented page.
        const candidates=[];
        for(const frame of page.frames())if(sameOriginFrame(page.url(),frame.url())){
          const locator=frame.getByLabel(field.label,{exact:true});
          if(await locator.count()===1){const candidate=await locator.elementHandle();if(candidate)candidates.push(candidate);}
        }
        if(candidates.length!==1)throw Object.assign(new Error("The form control was replaced and its label is no longer unambiguous"),{kind:"page_moved"});
        handle=candidates[0] as ElementHandle<HTMLElement>;
      }
    } else {
      const matches: ElementHandle<HTMLElement>[] = [];
      for (const frame of page.frames()) {
        if (!sameOriginFrame(page.url(), frame.url())) continue;
        const locator = target.kind === "selector" ? frame.locator(target.value) : frame.getByLabel(target.value, { exact: true });
        const count = await locator.count();
        if (count > 1) throw new Error("The fill target is ambiguous");
        if (count === 1) { const candidate = await locator.elementHandle(); if (candidate) matches.push(candidate as ElementHandle<HTMLElement>); }
      }
      if (matches.length !== 1) throw new Error("The fill target is missing or ambiguous");
      handle = matches[0]!;
    }
    const frame = await handle.ownerFrame();
    if (!frame || !sameOriginFrame(page.url(), frame.url())) throw Object.assign(new Error("Cross-origin form target refused"),{kind:"in_unreachable_frame"});
    return handle;
  }

  async prepareForm(binding: FormPageBinding, form: UserForm): Promise<{reachable:string[];failureKinds:Record<string,string>}> {
    const page = await this.formPage(binding); const reachable: string[] = [], failureKinds:Record<string,string> = {};
    for (const field of form.fields) if (field.target) {
      try {
        const handle = await editableHandle(await this.formHandle(page, field)) as ElementHandle<HTMLElement>;
        if (await handle.evaluate(WRITE_TARGET_IS_HIDDEN_FN) || await writeTargetFrameIsHidden(page,handle)) failureKinds[field.id]="hidden_target";
        else if (await handle.evaluate((node) => node.isConnected && !node.hasAttribute("disabled") && !node.hasAttribute("readonly") && (node.matches("input,textarea,select") || node.isContentEditable))) reachable.push(field.id);
        else failureKinds[field.id]="target_unavailable";
      } catch(error) { failureKinds[field.id]=(error as any).kind ?? "target_missing"; }
    }
    return {reachable,failureKinds};
  }

  async fillForm(binding: FormPageBinding, field: UserFormField, value: string | boolean): Promise<boolean> {
    const page = await this.formPage(binding);
    const handle = await editableHandle(await this.formHandle(page, field)) as ElementHandle<HTMLElement>;
    if (await handle.evaluate(WRITE_TARGET_IS_HIDDEN_FN) || await writeTargetFrameIsHidden(page, handle)) throw new Error("target_hidden");
    if (!await handle.evaluate(node => node.isConnected && !node.hasAttribute("disabled") && !node.hasAttribute("readonly"))) throw new Error("target_unavailable");
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") return false;
      await handle.setChecked(value);
      return handle.isChecked().then(checked => checked === value);
    }
    if (typeof value !== "string") return false;
    this.registerPrivateValues([value]);
    const secret = true; // Every submitted form value is write-only, including nonsecret fields.
    if (field.type === "select") {
      await handle.selectOption(value);
      return handle.evaluate((node, expected) => (node as HTMLSelectElement).value === expected, value);
    }
    await referenceFill({ page, element: handle, request: { ref: field.target?.value, element: field.label, value, secret } });
    return true;
  }

  async formCanSave(binding: FormPageBinding, field: UserFormField): Promise<boolean> {
    const handle = await this.formHandle(await this.formPage(binding), field);
    return handle.evaluate((node) => {
      const attributes = ["type", "autocomplete", "name", "id", "aria-label"].map((key) => node.getAttribute(key) ?? "").join(" ");
      return node.isConnected && node.getAttribute("maxlength") !== "1" && !/password|one-time|cc-|card|cvv|cvc|ssn|secret|token|passcode|credential|api.?key/i.test(attributes);
    });
  }

  async submitForm(binding: FormPageBinding, field: UserFormField): Promise<boolean> {
    const page = await this.formPage(binding); const handle = await this.formHandle(page, field);
    if (!(await handle.evaluate((node, domain) => node.isConnected && location.hostname.toLowerCase() === domain, binding.domain))) return false;
    await handle.press("Enter"); return true;
  }

  async formSnapshot(binding: FormPageBinding): Promise<string> {
    const result = await this.captureSnapshot(await this.formPage({...binding,url:undefined}));
    return redactSecrets(result.lines.join("\n"), [...this.privateValues]);
  }

  async execute(toolName: string, raw: unknown): Promise<AgentToolResult<Record<string, unknown>>> {
    try {
      const result = await this.executeWithDialogs(toolName, raw);
      if (!this.privateValues.size) return result;
      return { ...result,
        content: result.content.map(part => part.type === "text" ? {...part, text: redactSecrets(part.text, [...this.privateValues])} : part),
        details: JSON.parse(redactSecrets(JSON.stringify(result.details ?? {}), [...this.privateValues])),
      };
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), [...this.privateValues]));
    }
  }

  private async executeWithDialogs(toolName: string, raw: unknown): Promise<AgentToolResult<Record<string, unknown>>> {
    const args = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
    const page = await this.ensurePage(this.viewId(args));
    const dialog = this.dialogs.get(page);
    if (toolName === "browser_cdp" && args.method === "Page.handleJavaScriptDialog") {
      if (!dialog) throw new Error("No dialog is showing");
      const params = args.params as JsonObject | undefined;
      if (typeof params?.accept !== "boolean" || (params.promptText !== undefined && typeof params.promptText !== "string"))
        throw new Error("Dialog handling requires accept: boolean and optional promptText: string");
      const opened = new Promise<AgentToolResult<Record<string, unknown>>>(resolve => {
        this.dialogOpened = openedPage => resolve(this.dialogState(openedPage));
      });
      try {
        if (!params.accept && dialog.type() === "beforeunload") this.cancelledNavigation = this.unfinishedOperation;
        if (params.accept) await dialog.accept(params.promptText as string | undefined);
        else await dialog.dismiss();
        if (this.dialogs.get(page) === dialog) this.dialogs.delete(page);
        if (this.dialogs.has(page)) return this.dialogState(page);
        // Accepting one dialog can synchronously open another. Report it without
        // waiting for the original click's JavaScript callback to finish.
        return await Promise.race([opened, this.drainDialogAction().then(() =>
          this.pageState(page, params.accept ? "Accepted browser dialog" : "Dismissed browser dialog"))]);
      } finally { this.dialogOpened = undefined; }
    }
    if (dialog) return this.dialogState(page, "Browser dialog still needs a response");
    // A native dialog response may have completed the previous browser action.
    // Drain it before a new action; never replay an action after a dialog.
    await this.drainDialogAction();
    const opened = new Promise<AgentToolResult<Record<string, unknown>>>(resolve => {
      this.dialogOpened = openedPage => resolve(this.dialogState(openedPage));
    });
    const operation: Promise<AgentToolResult<Record<string, unknown>>> = this.executeRaw(toolName, raw).catch(error => {
      // Record when the timeout occurred, not merely that a dialog appeared.
      // An observation/navigation timeout after the dialog closed must still fail.
      if (this.dialogs.size && /[Tt]imeout\s+\d+ms exceeded/.test(String(error)))
        this.dialogTimedOutOperation = operation;
      throw error;
    });
    this.unfinishedOperation = operation;
    try {
      const result = await Promise.race([operation, opened]);
      if (!result.details?.pendingDialog) this.unfinishedOperation = undefined;
      return result;
    } catch (error) {
      this.unfinishedOperation = undefined;
      const opener = this.openers.get(page);
      if (page.isClosed() && this.connected && opener && this.ownedPages.has(opener) && !opener.isClosed() &&
          /(?:Target|page|browser|context).*closed/i.test(String(error))) {
        this.currentViewId = this.idFor(opener);
        return this.pageState(opener, "Popup closed during the action. Showing its parent page; inspect the result before retrying. The action was not replayed.");
      }
      throw error;
    } finally {
      this.dialogOpened = undefined;
      // A rejected input after returning the dialog must not become unhandled.
      void operation.catch(() => {});
    }
  }
  private async executeRaw(toolName: string, raw: unknown): Promise<AgentToolResult<Record<string, unknown>>> {
    const args = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
    switch (toolName) {
      case "browser_navigate":
        return this.navigate(args);
      case "browser_snapshot":
        return this.snapshot(args);
      case "browser_click":
        return this.click(args);
      case "browser_mouse_click_xy":
        return this.mouseClick(args);
      case "browser_type":
        return this.type(args);
      case "browser_fill":
        return this.fill(args);
      case "browser_select_option":
        return this.selectOption(args);
      case "browser_press_key":
        return this.pressKey(args);
      case "browser_scroll":
        return this.scroll(args);
      case "browser_drag":
        return this.drag(args);
      case "browser_get_bounding_box":
        return this.boundingBox(args);
      case "browser_highlight":
        return this.highlight(args);
      case "browser_cdp":
        return this.cdp(args);
      case "browser_tabs":
        return this.tabs(args);
      case "browser_take_screenshot":
        return this.takeScreenshot(args);
      default:
        throw new Error(`Unknown browser-use tool: ${toolName}`);
    }
  }

  private async ensurePage(requestedViewId?: string): Promise<Page> {
    const pages = this.leasedPages();
    if (requestedViewId) {
      const requested = pages.find((page) => this.idFor(page) === requestedViewId);
      if (!requested) throw new Error(`Browser tab is unavailable: ${requestedViewId}`);
      this.currentViewId = requestedViewId;
      await this.observeDialogs(requested);
      return requested;
    }
    const selected = pages.find((page) => this.idFor(page) === this.currentViewId) ?? pages[0];
    if (selected) {
      this.currentViewId = this.idFor(selected);
      await this.observeDialogs(selected);
      return selected;
    }
    const created = await this.context.newPage();
    this.trackPage(created);
    this.currentViewId = this.idFor(created);
    await this.observeDialogs(created);
    return created;
  }

  private leasedPages(): Page[] {
    const pages = [...this.ownedPages].filter((page) => !page.isClosed());
    for (const page of [...this.ownedPages]) {
      if (page.isClosed()) this.ownedPages.delete(page);
    }
    return pages;
  }

  private trackPage(page: Page): void {
    if (this.ownedPages.has(page)) return;
    this.ownedPages.add(page);
    this.idFor(page);
    page.on("dialog", dialog => this.recordDialog(page, dialog));
    page.on("popup", (popup) => {
      this.openers.set(popup, page);
      this.trackPage(popup);
      this.currentViewId = this.idFor(popup);
    });
    page.on("close", () => {
      void this.cdpSessions.get(page)?.then(cdp => cdp.detach()).catch(() => {});
      this.cdpSessions.delete(page);
      this.ownedPages.delete(page);
      this.dialogs.delete(page);
      // Keep exact target IDs across transport loss (which also closes these
      // Page objects). A closed Chrome target cannot match on reconnection.
      this.refs.delete(this.idFor(page));
      if (this.connected && this.currentViewId === this.idFor(page)) this.currentViewId = null;
    });
    void this.observeDialogs(page).catch(() => {});
  }

  private idFor(page: Page): string {
    const existing = this.ids.get(page);
    if (existing) return existing;
    const id = `view-${this.nextViewId++}`;
    this.ids.set(page, id);
    return id;
  }

  private viewId(args: JsonObject): string | undefined {
    return typeof args.viewId === "string" ? args.viewId : undefined;
  }

  private async clearRefs(page: Page): Promise<void> {
    const refs = this.refs.get(this.idFor(page));
    this.refs.delete(this.idFor(page));
    if (refs) await Promise.allSettled([...refs.values()].map((handle) => handle.dispose()));
  }

  private async requireRef(page: Page, value: unknown): Promise<ElementHandle<HTMLElement>> {
    if (typeof value !== "string") throw new Error("An element ref is required");
    let handle = this.refs.get(this.idFor(page))?.get(value) ?? await refHandle(page, value) as ElementHandle<HTMLElement>;
    const connected = await handle?.evaluate((node) => node.isConnected).catch(() => false);
    if (!handle || !connected) {
      throw new Error(`Element ref ${value} is stale or unknown; take a fresh browser_snapshot`);
    }
    // A same-origin snapshot can return a child frame's node through the main
    // frame's JS realm. Playwright then uses that realm's viewport for clicks.
    // Rebind to the owning frame before any pointer, geometry or input action.
    const owner = await handle.ownerFrame();
    if (!owner || owner.isDetached()) throw new Error(`Element ref ${value} belongs to a detached frame; take a fresh browser_snapshot`);
    if (owner === page.mainFrame()) return handle;
    const owned = (await owner.evaluateHandle(node => node, handle)).asElement() as ElementHandle<HTMLElement> | null;
    if (!owned) throw new Error(`Element ref ${value} is no longer an element; take a fresh browser_snapshot`);
    if (owned !== handle) await handle.dispose();
    handle = owned;
    this.refs.get(this.idFor(page))?.set(value, handle);
    return handle;
  }

  private async pageState(
    page: Page,
    summary: string,
    fullPage = false,
    data?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (this.dialogs.has(page)) return this.dialogState(page, summary);
    await this.observeDialogs(page);
    const image = Buffer.from(await page.screenshot({ fullPage, timeout: 10_000, type: "png", mask: [page.locator('[data-openteam-private="true"]')] }));
    await mkdir(this.artifactDirectory, { recursive: true });
    const path = join(
      this.artifactDirectory,
      `browser-${Date.now()}-${this.screenshotOrdinal++}.png`
    );
    await writeFile(path, image, { mode: 0o644 });
    const pageViewId = this.idFor(page);
    const title = await page.title().catch(() => "");
    const downloads = await this.downloads?.forPage(page) ?? [];
    const downloadText = downloads.map(download => download.state === "completed"
      ? download.path ? `Downloaded ${download.filename} to ${download.path}` : `Download completed: ${download.filename}. Check ${download.directory} for the saved filename; the browser did not provide a verified file path.`
      : `Download ${download.state === "canceled" ? "canceled" : "in progress"}: ${download.filename} (destination: ${download.directory})`);
    return {
      content: [
        {
          type: "text",
          text: redactSecrets([summary === "Took a screenshot" ? `Saved a screenshot to ${path}` : summary, `Current page: ${title} (${page.url()})`, ...(data ? [data] : []), ...downloadText].join("\n\n"), [...this.privateValues]),
        },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ],
      details: { viewId: pageViewId, url: page.url(), title, path, coordinateSpace: fullPage ? "page" : "browser-viewport", ...(downloads.length ? { downloads } : {}) },
    };
  }

  private async navigate(args: JsonObject) {
    if (typeof args.url !== "string") throw new Error("url is required");
    const page =
      args.newTab === true
        ? await this.context.newPage().then((created) => {
            this.trackPage(created);
            return created;
          })
        : await this.ensurePage(this.viewId(args));
    this.currentViewId = this.idFor(page);
    await this.observeDialogs(page);
    const outcome = await gotoWithRecovery(page, args.url, true);
    await this.clearRefs(page);
    const safeUrl = new URL(args.url); safeUrl.username = ""; safeUrl.password = "";
    return this.pageState(page, `${args.newTab === true ? `Opened ${safeUrl.href} in a new tab` : `Navigated to ${safeUrl.href}`}${navigationNote(outcome)}`);
  }

  private async captureSnapshot(page: Page, args: JsonObject = {}) {
    await this.clearRefs(page);
    const result = await snapshotAcrossFrames(this.context, page, {
      interactive: args.interactive === true,
      maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : 20,
      selector: typeof args.selector === "string" && args.selector.length ? args.selector : undefined,
      stableRefs: false,
    });
    frameRefsByPage.set(page, result.refOwners);
    return result;
  }

  private async snapshot(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const result = await this.captureSnapshot(page, args);
    const output = await this.pageState(page, `Captured page snapshot (${result.refCount} interactive refs)`, false, result.lines.join("\n"));
    output.details = { ...output.details, refs: result.refCount, unreachableFrames: result.unreachableFrames, ...(result.selector ? { selectorMatched: result.selector.matched, selectorClosedShadow: result.selector.closedShadow } : {}) };
    return output;
  }

  private async snapshotFrame(
    frame: Frame,
    selector: string | undefined,
    refs: Map<string, ElementHandle<HTMLElement>>,
    startRef: number,
    maxDepth: number,
    interactiveOnly: boolean
  ): Promise<{ lines: string[]; nextRef: number }> {
    const lines: string[] = [];
    let nextRef = startRef;
    const scopes = this.deepLocator(frame, selector ?? "body");
    const scopeCount = Math.min(await scopes.count().catch(() => 0), 20);
    for (let scopeIndex = 0; scopeIndex < scopeCount && nextRef <= 500; scopeIndex += 1) {
      const scope = scopes.nth(scopeIndex);
      if (!interactiveOnly) {
        const structure = await scope.ariaSnapshot({ timeout: 5_000 }).catch(() => "");
        const truncated = truncateAriaSnapshot(structure, maxDepth);
        if (truncated) lines.push(`Structure:\n${truncated}`);
      }
      const candidateLocators: Locator[] = [];
      if (
        await scope
          .evaluate((node, match) => node.matches(match), INTERACTIVE_SELECTOR)
          .catch(() => false)
      ) {
        candidateLocators.push(scope);
      }
      const descendants = scope.locator(INTERACTIVE_SELECTOR);
      const descendantCount = Math.min(await descendants.count().catch(() => 0), 500 - nextRef + 1);
      for (let index = 0; index < descendantCount; index += 1) {
        candidateLocators.push(descendants.nth(index));
      }
      for (const locator of candidateLocators) {
        if (nextRef > 500) break;
        if (!(await locator.isVisible().catch(() => false))) continue;
        const handle = (await locator
          .elementHandle()
          .catch(() => null)) as ElementHandle<HTMLElement> | null;
        if (!handle) continue;
        const details = await this.snapshotElement(handle);
        if (!details) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ref = `e${nextRef++}`;
        refs.set(ref, handle);
        const metadata = [
          details.role ?? details.tag,
          details.type,
          details.disabled ? "disabled" : null,
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(
          `[ref=${ref}] ${metadata}${details.name ? ` ${JSON.stringify(details.name)}` : ""}`
        );
      }
    }
    return { lines, nextRef };
  }

  private deepLocator(frame: Frame, selector: string): Locator {
    const stages = selector
      .split(/\s*>>>\s*/)
      .map((stage) => stage.trim())
      .filter(Boolean);
    const [first, ...rest] = stages;
    if (!first) throw new Error("selector must not be empty");
    let locator = frame.locator(first);
    for (const stage of rest) locator = locator.locator(stage);
    return locator;
  }

  private snapshotElement(handle: ElementHandle<HTMLElement>): Promise<SnapshotElement | null> {
    return handle
      .evaluate((node): SnapshotElement => {
        const element = node as HTMLElement;
        const input = element as HTMLInputElement;
        const type = element.getAttribute("type");
        const text =
          type === "password"
            ? ""
            : (element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("placeholder") ??
              element.innerText ??
              element.getAttribute("name") ??
              input.value ??
              "");
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name: text.replace(/\s+/g, " ").trim().slice(0, 300),
          type,
          disabled: Boolean((element as HTMLButtonElement).disabled),
        };
      })
      .catch(() => null);
  }

  private async click(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.map((value) => (value === "ControlOrMeta" ? "Control" : value))
      : [];
    const hold = args.holdDurationMs;
    if (hold !== undefined && (typeof hold !== "number" || !Number.isInteger(hold) || hold < 1 || hold > 30_000)) throw new Error("holdDurationMs must be 1–30000");
    const box = await handle.boundingBox();
    await handle.click({
      button: (args.button as "left" | "right" | "middle") ?? "left",
      clickCount: args.doubleClick === true ? 2 : 1,
      modifiers: modifiers as Array<"Alt" | "Control" | "Meta" | "Shift">,
      ...(typeof hold === "number" ? {delay:hold,timeout:30_000 + hold} : {}),
      ...((typeof args.offsetX === "number" || typeof args.offsetY === "number") && box ? {
        position: {x:box.width / 2 + (typeof args.offsetX === "number" ? args.offsetX : 0),y:box.height / 2 + (typeof args.offsetY === "number" ? args.offsetY : 0)}
      } : {}),
    });
    return this.pageState(page, await this.recoverAfterAction(page, `Clicked ${args.element ?? args.ref}`));
  }

  private async mouseClick(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.x !== "number" || typeof args.y !== "number")
      throw new Error("x and y are required");
    const button = (args.button as "left" | "right" | "middle") ?? "left";
    if (typeof args.holdDurationMs === "number") {
      if (!Number.isInteger(args.holdDurationMs) || args.holdDurationMs < 1 || args.holdDurationMs > 30_000) throw new Error("holdDurationMs must be 1–30000");
      await page.mouse.move(args.x, args.y);
      await page.mouse.down({ button });
      try { await page.waitForTimeout(args.holdDurationMs); }
      finally { await page.mouse.up({ button }); }
    } else await page.mouse.click(args.x, args.y, { button });
    return this.pageState(page, await this.recoverAfterAction(page, `Clicked at (${args.x}, ${args.y})`));
  }

  private async type(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.text !== "string") throw new Error("text is required");
    const result = await referenceType({ page, request: args });
    return this.pageState(page, await this.recoverAfterAction(page, result.summary));
  }

  private async fill(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.value !== "string") throw new Error("value is required");
    const result = await referenceFill({ page, request: args });
    return this.pageState(page, result.summary);
  }

  private async recoverAfterAction(page: Page, summary: string): Promise<string> {
    if (this.dialogs.has(page)) return summary;
    await settleIntoErrorPage(this.context, page);
    if (page.isClosed() || !isChromeErrorPage(page)) return summary;
    try {
      const outcome = await recoverErrorPage(this.context, page);
      return summary + (outcome === undefined
        ? ". The page now shows Chrome's error page: the load failed (a form submission is never replayed automatically). Use browser_navigate with the intended URL, or re-submit the form, to retry."
        : `. The page landed on Chrome's error page, so it was reloaded automatically${navigationNote(outcome)}. Take a fresh browser_snapshot before acting on it.`);
    } catch (error) {
      return summary + `. The page landed on Chrome's error page and reloading it failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async selectOption(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    if (!Array.isArray(args.values) || args.values.some((value) => typeof value !== "string")) {
      throw new Error("values must be an array of strings");
    }
    const resolved = await handle.evaluate(resolveReferenceSelectOptions, args.values) as {kind:string;values?:string[];fuzzy?:boolean;optionCount?:number};
    if (resolved.kind === "unmatched") throw new Error(`None of the ${resolved.optionCount} options matched the requested value, by value or by visible label. Take a fresh browser_snapshot to read the control, and pass an option value or label the page actually offers.`);
    const selected = resolved.kind === "matched" ? await handle.selectOption(resolved.values!) : await handle.selectOption(args.values as string[]).catch(() => handle.selectOption((args.values as string[]).map(label => ({label}))));
    return this.pageState(page, `Selected ${JSON.stringify(selected)} in ${args.element ?? args.ref}${resolved.fuzzy ? " (matched the requested value to the page's option by its visible label)" : ""}`);
  }

  private async pressKey(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.key !== "string") throw new Error("key is required");
    const back = /^(?:BrowserBack|Alt\+(?:Arrow)?Left)$/i.test(args.key);
    const forward = /^(?:BrowserForward|Alt\+(?:Arrow)?Right)$/i.test(args.key);
    if (back || forward) {
      // A back/forward-cache restoration commits without firing a new DOMContentLoaded.
      const options = { waitUntil: "commit" as const, timeout: 20_000 };
      const response = back ? await page.goBack(options) : await page.goForward(options);
      await this.clearRefs(page);
      return this.pageState(page, `Requested browser history ${back ? "Back" : "Forward"}${response ? "" : " (no new document response; inspect the current page)"}`);
    }
    const key = args.key
      .replace(/ControlOrMeta/gi, "Control")
      .replace(/\bctrl\b/gi, "Control")
      .replace(/\balt\b/gi, "Alt")
      .replace(/\bshift\b/gi, "Shift")
      .replace(/\bmeta\b/gi, "Meta");
    await page.keyboard.press(key);
    return this.pageState(page, await this.recoverAfterAction(page, `Pressed ${key}`));
  }

  private async scroll(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.ref === "string") {
      await (await this.requireRef(page, args.ref)).scrollIntoViewIfNeeded();
      return this.pageState(page, `Scrolled ${args.element ?? args.ref} into view`);
    }
    const amount = typeof args.amount === "number" && args.amount > 0 ? args.amount : 300;
    let deltaX = typeof args.deltaX === "number" ? args.deltaX : 0;
    let deltaY = typeof args.deltaY === "number" ? args.deltaY : 0;
    if (deltaX === 0 && deltaY === 0) {
      const direction = args.direction ?? "down";
      if (direction === "up") deltaY = -amount;
      else if (direction === "down") deltaY = amount;
      else if (direction === "left") deltaX = -amount;
      else deltaX = amount;
    }
    await page.mouse.wheel(deltaX, deltaY);
    return this.pageState(page, `Scrolled by (${deltaX}, ${deltaY})`);
  }

  private async drag(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const source = await this.requireRef(page, args.sourceRef);
    const sourceBox = await source.boundingBox();
    if (!sourceBox) throw new Error("Source element has no visible bounding box");
    let targetX: number;
    let targetY: number;
    if (typeof args.targetRef === "string") {
      const targetBox = await (await this.requireRef(page, args.targetRef)).boundingBox();
      if (!targetBox) throw new Error("Target element has no visible bounding box");
      targetX = targetBox.x + targetBox.width / 2;
      targetY = targetBox.y + targetBox.height / 2;
    } else if (typeof args.targetX === "number" && typeof args.targetY === "number") {
      targetX = args.targetX;
      targetY = args.targetY;
    } else {
      throw new Error("Drag requires targetRef or targetX and targetY");
    }
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
    return this.pageState(page, `Dragged ${args.sourceRef} to (${Math.round(targetX)}, ${Math.round(targetY)})`);
  }

  private async boundingBox(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const box = await (await this.requireRef(page, args.ref)).boundingBox();
    if (!box) throw new Error("The element has no visible bounding box.");
    return this.pageState(page, `Bounding box for ${args.element ?? args.ref}`, false, JSON.stringify(Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value)]))));
  }

  private async highlight(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    const handle = await this.requireRef(page, args.ref);
    const original = await handle.evaluate((node) => {
      const element = node as HTMLElement;
      const value = element.style.outline;
      element.style.outline = "4px solid #ff2d55";
      element.style.outlineOffset = "2px";
      return value;
    });
    const duration = typeof args.durationMs === "number" ? args.durationMs : 2_000;
    const result = await this.pageState(page, `Highlighted ${args.element ?? args.ref} for ${duration}ms`);
    setTimeout(() => {
      void handle
        .evaluate((node, value) => {
          (node as HTMLElement).style.outline = value;
          (node as HTMLElement).style.outlineOffset = "";
        }, original)
        .catch(() => undefined);
    }, duration);
    return result;
  }

  private async cdp(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    if (typeof args.method !== "string") throw new Error("method is required");
    assertAllowedCdpMethod(args.method);
    if (this.privateValues.size && !/^(?:Performance\.getMetrics|DOM\.getBoxModel|Page\.getLayoutMetrics)$/.test(args.method)) {
      throw new Error("This browser contains private login data. Use the page interaction tools; arbitrary CDP inspection is unavailable for this session.");
    }
    const session = await this.cdpFor(page);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const raw = await Promise.race([session.send(args.method as never, (args.params ?? {}) as never),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("CDP request timed out")),25_000);})]);
      const scrub=(value:unknown):any=>typeof value === "string" ? redactSecrets(value,[...this.privateValues]) : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key,value])=>[key,scrub(value)])) : value;
      const result=scrub(raw);
      const state = await this.pageState(page, await this.recoverAfterAction(page, `Ran CDP ${args.method}`), false, boundedJson(result));
      state.details = {
        ...state.details,
        viewId: this.idFor(page),
        method: args.method,
        result,
      };
      return state;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runtime evidence for review; page content never grants authorization. */
  tabCloseReviewTarget(args: { index?: unknown }) {
    const page = typeof args.index === "number"
      ? this.leasedPages()[args.index]
      : this.leasedPages().find(page => this.idFor(page) === this.currentViewId);
    if (!page) throw new Error("Browser tab is unavailable");
    const describe = (target: Page) => ({
      viewId: this.idFor(target),
      url: redactSecrets(target.url(), [...this.privateValues]),
    });
    const opener = this.openers.get(page);
    return {
      source: "Browser runtime observation; not user authorization",
      target: describe(page),
      ...(opener && !opener.isClosed() ? { openedBy: describe(opener) } : {}),
    };
  }

  private async tabs(args: JsonObject) {
    const action = args.action;
    if (action === "new") {
      const page = await this.context.newPage();
      this.trackPage(page);
      this.currentViewId = this.idFor(page);
    } else if (action === "select") {
      if (typeof args.index !== "number") throw new Error("index is required when selecting a tab");
      const page = this.leasedPages()[args.index];
      if (!page) throw new Error(`Browser tab index is unavailable: ${args.index}`);
      this.currentViewId = this.idFor(page);
      await page.bringToFront();
    } else if (action === "close") {
      const pages = this.leasedPages();
      const page = typeof args.index === "number" ? pages[args.index] : await this.ensurePage();
      if (!page) throw new Error("Browser tab is unavailable");
      const selectedBefore = this.currentViewId;
      const opener = this.openers.get(page);
      const closedIndex = pages.indexOf(page);
      await this.clearRefs(page);
      await page.close();
      this.targetIds.delete(this.idFor(page));
      const remaining = this.leasedPages();
      // Closing a background tab keeps selection; closing a popup returns to
      // its opener. Otherwise use the neighboring tab, not an unrelated first
      // tab that may hold the user's pre-existing work.
      const next = remaining.find(candidate => this.idFor(candidate) === selectedBefore)
        ?? (opener && remaining.includes(opener) ? opener : remaining[Math.min(closedIndex, remaining.length - 1)]);
      this.currentViewId = next ? this.idFor(next) : null;
      await this.ensurePage();
    } else if (action !== "list") {
      throw new Error("action must be list, new, close, or select");
    }
    const pages = this.leasedPages();
    const entries = await Promise.all(
      pages.map(async (page, index) => ({
        index,
        viewId: this.idFor(page),
        selected: this.idFor(page) === this.currentViewId,
        title: await page.title().catch(() => ""),
        url: page.url(),
      }))
    );
    if (action === "list") return textResult(`Listed ${entries.length} tab(s)\n\n${JSON.stringify(entries.map(({ index, url, title }) => ({ index, url, title })), null, 1)}`, { tabs: entries.length });
    return this.pageState(await this.ensurePage(), action === "new" ? "Opened a new tab" : action === "select" ? `Selected tab ${args.index}` : "Closed a tab");
  }

  private async takeScreenshot(args: JsonObject) {
    const page = await this.ensurePage(this.viewId(args));
    return this.pageState(page, "Took a screenshot", args.fullPage === true);
  }
}
export { BROWSER_USE_TOOLS, type BrowserUseToolDefinition } from "./tool-definitions";
