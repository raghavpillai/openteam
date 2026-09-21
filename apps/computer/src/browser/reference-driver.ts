// @ts-nocheck
// Browser algorithms from the captured Grok Bot 0.47.0 driver (2026-09-12).
// Adaptations: long-lived host navigation deadlines and private-value screenshot masks.
import { randomUUID } from "node:crypto";

const ACTION_TIMEOUT_MS = 10000;

const NAVIGATE_TIMEOUT_MS = 25000;

const NAVIGATE_RETRY_DELAYS_MS = [1000, 2500];

const LOAD_SETTLE_TIMEOUT_MS = 5000;

const WATCHDOG_MS = 90000;

const RESULT_RESERVE_MS = 12000;

const DRIVER_STARTED_AT = Date.now();

const ERROR_PAGE_SETTLE_MS = 600;

const CHROME_ERROR_PAGE_PREFIX = "chrome-error://";

const TRANSIENT_NAVIGATION_ERROR =
	/net::ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_(RESET|CLOSED|REFUSED|ABORTED|FAILED|TIMED_OUT)|EMPTY_RESPONSE|NETWORK_CHANGED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_TIMED_OUT|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|SOCKET_NOT_CONNECTED|HTTP2_PROTOCOL_ERROR|HTTP2_PING_FAILED|HTTP2_SERVER_REFUSED_STREAM|QUIC_PROTOCOL_ERROR|QUIC_HANDSHAKE_FAILED|NETWORK_IO_SUSPENDED)\b/;

const RELOADABLE_PROTOCOLS = new Set(["http:", "https:"]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline(promise, ms, message) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function navigationOutrunsPlaywright(context, page) {
	let session;
	try {
		session = await context.newCDPSession(page);
		const info = await session.send("Target.getTargetInfo");
		return info.targetInfo.url !== page.url();
	} catch {
		return false;
	} finally {
		if (session !== undefined) await detachOrNote(session, "navigation probe's");
	}
}

async function settleIntoErrorPage(context, page) {
	if (page.isClosed() || isChromeErrorPage(page)) return;
	if (!(await navigationOutrunsPlaywright(context, page))) return;
	const deadline = Date.now() + ERROR_PAGE_SETTLE_MS;
	while (Date.now() < deadline) {
		await sleep(100);
		if (page.isClosed() || isChromeErrorPage(page)) return;
	}
}

function isTransientNavigationError(error) {
	try {
		const message = error instanceof Error ? String(error.message) : String(error);
		return TRANSIENT_NAVIGATION_ERROR.test(message);
	} catch {
		return false;
	}
}

function isChromeErrorPage(page) {
	return page.url().startsWith(CHROME_ERROR_PAGE_PREFIX);
}

function stripUrlCredentials(url) {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.href;
	} catch {
		return url;
	}
}

function anotherAttemptFitsWatchdog(startedAt) {
	const remaining = startedAt + WATCHDOG_MS - Date.now();
	return remaining > NAVIGATE_TIMEOUT_MS + LOAD_SETTLE_TIMEOUT_MS + RESULT_RESERVE_MS;
}

async function stopLoading(page) {
	let session;
	try {
		session = await page.context().newCDPSession(page);
		await session.send("Page.stopLoading");
	} catch (failure) {
		noteIgnoredFailure("Page.stopLoading", failure);
	} finally {
		if (session !== undefined) await detachOrNote(session, "stop-loading");
	}
}

function redactUrlCredentialsInText(text) {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+@/gi, "$1");
}

function failureLine(failure) {
	let message;
	try {
		message = failure instanceof Error ? String(failure.message) : String(failure);
	} catch {
		message = "unknown failure";
	}
	return redactUrlCredentialsInText(message.split("\n")[0]);
}

function noteIgnoredFailure(step, failure) {
	console.error("ignored: " + step + " failed: " + failureLine(failure));
}

function detachOrNote(session, owner) {
	return session
		.detach()
		.catch((failure) => noteIgnoredFailure("detaching the " + owner + " CDP session", failure));
}

function settleAfter(page, action, timeoutMs) {
	return page
		.waitForLoadState("domcontentloaded", { timeout: timeoutMs })
		.catch((failure) => noteIgnoredFailure("settling the page after " + action, failure));
}

function noteSkippedDocuments(step, count) {
	if (count > 0) noteIgnoredFailure(step, String(count) + " document(s) skipped");
}

async function markSecretFill(element, value) {
	await element.evaluate(MARK_SECRET_FILL_FN, value);
 await element.evaluate(el => { el.dataset.openteamPrivate = "true"; const parent = el.parentElement?.parentElement; if (parent) for (const node of parent.querySelectorAll('input[maxlength="1"]')) node.dataset.openteamPrivate = "true"; });
}

async function gotoWithRecovery(page, url, recovery) {
 const startedAt = Date.now();
	let lastFailure;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: NAVIGATE_TIMEOUT_MS,
			});
			await page
				.waitForLoadState("load", { timeout: LOAD_SETTLE_TIMEOUT_MS })
				.catch((failure) => noteIgnoredFailure("waiting for the load event", failure));
			if (!recovery) return { retries: 0, status: undefined };
			if (!isChromeErrorPage(page)) {
				return { retries: attempt, status: response === null ? undefined : response.status() };
			}
			lastFailure = new Error(
				"Chrome showed its error page instead of " + stripUrlCredentials(url),
			);
		} catch (error) {
			await stopLoading(page);
			if (!recovery) throw new Error(failureLine(error));
			if (!isTransientNavigationError(error)) {
				if (attempt === 0) throw new Error(failureLine(error));
				throw new Error(
					"The page did not load after " +
						String(attempt + 1) +
						" attempts; the last one failed with: " +
						failureLine(error) +
						". Earlier attempts hit a transient network failure (" +
						failureLine(lastFailure) +
						").",
				);
			}
			lastFailure = error;
		}
		const exhausted = attempt >= NAVIGATE_RETRY_DELAYS_MS.length;
		if (exhausted || !anotherAttemptFitsWatchdog(startedAt)) {
			throw new Error(
				"The page did not load after " +
					String(attempt + 1) +
					" attempts (" +
					failureLine(lastFailure) +
					"). The box's network path kept failing the request; retry browser_navigate, and report the failure if it persists.",
			);
		}
		await sleep(NAVIGATE_RETRY_DELAYS_MS[attempt]);
	}
}

function navigationNote(outcome) {
	const notes = [];
	if (outcome.retries > 0) {
		notes.push(
			"recovered after " +
				String(outcome.retries) +
				(outcome.retries === 1 ? " retry" : " retries") +
				" of a transient network failure",
		);
	}
	if (typeof outcome.status === "number" && outcome.status >= 400) {
		notes.push("the server answered HTTP " + String(outcome.status));
	}
	return notes.length > 0 ? " (" + notes.join("; ") + ")" : "";
}

async function intendedUrlFromHistory(context, page) {
	let session;
	try {
		session = await context.newCDPSession(page);
		const history = await session.send("Page.getNavigationHistory");
		const entry = history.entries[history.currentIndex];
		if (entry.transitionType === "form_submit") return undefined;
		return typeof entry.url === "string" ? entry.url : undefined;
	} catch {
		return undefined;
	} finally {
		if (session !== undefined) await detachOrNote(session, "navigation-history");
	}
}

function isReloadableUrl(url) {
	try {
		return RELOADABLE_PROTOCOLS.has(new URL(url).protocol);
	} catch {
		return false;
	}
}

async function recoverErrorPage(context, page) {
	const intendedUrl = await intendedUrlFromHistory(context, page);
	if (intendedUrl === undefined || !isReloadableUrl(intendedUrl)) return undefined;
	return gotoWithRecovery(page, intendedUrl, true);
}

const frameRefsByPage = new WeakMap();

const REF_LOOKUP_FN = ({ ref: r, token }) => {
	if (token !== undefined && globalThis.__sandRefState?.frameToken !== token) return "missing";
	const refs = globalThis.__sandRefs;
	if (refs == null || typeof refs.get !== "function") return "missing";
	const el = refs.get(r);
	if (el !== undefined && el !== null) {
		return el.isConnected === false ? "detached" : el;
	}
	const held = globalThis.__sandRefState?.byRef?.get(r);
	const node = held != null && typeof held.deref === "function" ? held.deref() : undefined;
	if (node != null && node.isConnected === false) return "detached";
	return "missing";
};

async function refHandle(page, ref) {
	const owners = frameRefsByPage.get(page);
	const token = owners != null ? owners[ref] : undefined;
	let why = "missing";
	if (typeof token !== "string") {
		const top = await page.evaluateHandle(REF_LOOKUP_FN, { ref });
		const topElement = top.asElement();
		if (topElement !== null) return topElement;
		why = await top.jsonValue().catch(() => "missing");
	} else {
		for (const frame of page.frames()) {
			if (frame === page.mainFrame() || frame.isDetached()) continue;
			const handle = await withDeadline(
				frame.evaluateHandle(REF_LOOKUP_FN, { ref, token }),
				FRAME_EVALUATE_TIMEOUT_MS,
				"ref lookup timed out",
			).catch((failure) => {
				noteIgnoredFailure("looking a ref up in a child frame", failure);
				return undefined;
			});
			if (handle === undefined) continue;
			const element = handle.asElement();
			if (element !== null) return element;
			if ((await handle.jsonValue().catch(() => "missing")) === "detached") {
				why = "detached";
				break;
			}
		}
	}
	throw new Error(
		"Unknown or stale ref " +
			JSON.stringify(ref) +
			(why === "detached"
				? ": the page replaced that element since the snapshot (a re-render or route change)"
				: "") +
			". Take a fresh browser_snapshot and use a ref from it.",
	);
}

const SNAPSHOT_FN = (opts) => {
	const doc = globalThis.document;
	const win = globalThis.window;
	let state = globalThis.__sandRefState;
	if (state == null || typeof state.counter !== "number" || state.byRef == null) {
		state = {
			generation: String(performance.timeOrigin),
			counter: 0,
			byElement: new WeakMap(),
			byRef: new Map(),
		};
		globalThis.__sandRefState = state;
	}
	if (state.stableRefs === undefined) {
		state.stableRefs = opts.stableRefs === true;
	}
	const stableRefs = state.stableRefs === true;
	const refStart = typeof opts.refStart === "number" ? opts.refStart : 0;
	if (state.counter < refStart) state.counter = refStart;
	if (!stableRefs && opts.probe !== true) {
		state.byRef.clear();
	}
	if (typeof opts.frameToken === "string" && typeof state.frameToken !== "string") {
		state.frameToken = opts.frameToken;
	}
	for (const [heldRef, held] of state.byRef) {
		const node = held != null && typeof held.deref === "function" ? held.deref() : undefined;
		if (node == null || node.isConnected !== true) state.byRef.delete(heldRef);
	}
	if (
		globalThis.__sandRefs == null ||
		typeof globalThis.__sandRefs.get !== "function" ||
		globalThis.__sandRefs instanceof Map
	) {
		globalThis.__sandRefs = {
			get: (r) => {
				const current = globalThis.__sandRefState;
				if (current == null) return undefined;
				const held = current.byRef.get(r);
				const node = held != null && typeof held.deref === "function" ? held.deref() : undefined;
				return node != null && node.isConnected === true ? node : undefined;
			},
		};
	}
	let refsThisWalk = 0;
	const lines = ["[gen=" + state.generation + "]"];
	const maxNodes = 400;
	let nodeCount = 0;
	const shadowOf = (el) => el.shadowRoot ?? el.__sandShadowRoot ?? null;
	let closedShadowSuspects = 0;
	const interactiveMatcher =
		"a[href], button, input, select, textarea, summary, " +
		'[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
		'[role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="combobox"], ' +
		'[role="option"], [role="switch"], [role="searchbox"], [role="textbox"], ' +
		'[role="slider"], [contenteditable="true"], [onclick], [draggable="true"]';
	const hidesSubtree = (el) => {
		if (el.getAttribute("aria-hidden") === "true") return true;
		// The element's OWN window: elements from a pierced same-origin child
		// frame belong to another document, whose getComputedStyle is the one
		// that knows them.
		const view =
			el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : win;
		const style = view.getComputedStyle(el);
		return style.display === "none" || style.visibility === "hidden";
	};
	const hasVisibleBox = (el) => {
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
	const isVisible = (el) => !hidesSubtree(el) && hasVisibleBox(el);
	const emptyBoxClipsEverythingInsideIt = (el) => {
		const view =
			el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : win;
		const style = view.getComputedStyle(el);
		return style.overflowX !== "visible" || style.overflowY !== "visible";
	};
	// A split-character code box (six maxlength=1 inputs) holds one character
	// of a host-filled secret, and the per-box element marks die when a form
	// re-render replaces the nodes. Registering bare single characters in the
	// value set would redact every lone digit on the page (quantity fields),
	// so a box is instead judged by its GROUP: when the group's concatenation
	// sits inside any registered secret (substring, so a partially distributed
	// fill from a failed write is still covered), the box's value is secret.
	const splitGroupHeldValue = (el) => {
		if (el.getAttribute("maxlength") !== "1") return undefined;
		let container = el.parentElement;
		for (let depth = 0; container !== null && depth < 3; depth++) {
			const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
			if (boxes.length >= 2 && boxes.includes(el)) {
				return boxes.map((box) => box.value).join("");
			}
			container = container.parentElement;
		}
		return undefined;
	};
	const isSecretSplitGroupMember = (el, secretFillValues) => {
		if (typeof secretFillValues[Symbol.iterator] !== "function") return false;
		const held = splitGroupHeldValue(el);
		if (held === undefined || held.length === 0) return false;
		for (const registered of secretFillValues) {
			if (typeof registered === "string" && registered.length > 1 && registered.includes(held)) {
				return true;
			}
		}
		return false;
	};
	// Secret fills that type per key (split OTP, masked-input retry) deposit
	// keystrokes wherever document focus moves, so a page that steals focus
	// mid-fill can divert a multi-character fragment into a control the fill
	// never targeted — one that carries no element mark and holds no exact
	// set member. Any value whose significant characters sit inside a
	// registered secret (raw or reformatted by a mask) is treated as such a
	// fragment and redacted; single characters stay visible, because blanking
	// every lone digit on the page would over-redact wildly. The reverse
	// containment redacts too: text that HOLDS a whole registered secret
	// (a contenteditable that appended the glyphs to its existing content).
	const secretSignificant = (text) =>
		String(text ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
	const isSecretFragmentValue = (candidate, secretFillValues) => {
		if (typeof secretFillValues[Symbol.iterator] !== "function") return false;
		if (typeof candidate !== "string") return false;
		const sig = secretSignificant(candidate);
		for (const registered of secretFillValues) {
			if (typeof registered !== "string" || registered.length <= 1) continue;
			if (candidate.length >= 2 && registered.includes(candidate)) return true;
			const sigRegistered = secretSignificant(registered);
			if (sig.length >= 2 && sigRegistered.includes(sig)) return true;
			if (candidate.includes(registered)) return true;
			if (sigRegistered.length > 1 && sig.includes(sigRegistered)) return true;
		}
		return false;
	};
	// The registered sets an element is judged against: its own window's (a
	// pierced frame's controls register there when they are the target) and
	// the top window's (the mark registers on top too, so a fragment a
	// focus-steal diverted into ANOTHER frame's control is still recognized).
	const secretFillSetsFor = (el) => {
		const sets = [];
		const view =
			el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : win;
		const own = view.__sandSecretFillValues;
		if (own !== undefined && own !== null) sets.push(own);
		const top = win.__sandSecretFillValues;
		if (view !== win && top !== undefined && top !== null) sets.push(top);
		return sets;
	};
	const isSecretForElement = (el, candidate, checkSplitGroup) =>
		secretFillSetsFor(el).some(
			(set) =>
				(typeof set.has === "function" && set.has(candidate)) ||
				(checkSplitGroup && isSecretSplitGroupMember(el, set)) ||
				isSecretFragmentValue(candidate, set),
		);
	const SECRET_AUTOCOMPLETE_TOKEN =
		/^(?:current-password|new-password|one-time-code|cc-(?:number|csc|exp(?:-month|-year)?))$/;
	const declaresSecretValue = (el) =>
		(el.getAttribute("type") ?? "").toLowerCase() === "password" ||
		(el.getAttribute("autocomplete") ?? "")
			.toLowerCase()
			.split(/\s+/)
			.some((token) => SECRET_AUTOCOMPLETE_TOKEN.test(token));
	// Visible frames whose document this snapshot could not enter (cross-origin
	// content, or a frame still loading). Reported instead of guessed at, so
	// the host and the model can tell "not on the page" apart from "may live in
	// a frame the snapshot cannot see". Hidden frames (tracking pixels) never
	// count. Manual identity dedupe makes a frame met by both walks count once.
	const unreachableFrames = [];
	let pierceReach = null;
	let pierceFrames = [];
	const withReachedFrameElements = (result) => {
		if (opts.__sandFrameIdentityEnvelope !== true) return result;
		return {
			result,
			reachedFrameElements: typeof opts.selector === "string" ? pierceFrames : unreachableFrames,
		};
	};
	const frameDocumentOf = (el) => {
		let child;
		try {
			child = el.contentDocument && el.contentDocument.body ? el.contentDocument : null;
		} catch {
			child = null;
		}
		if (child) return child;
		if (isVisible(el)) {
			let alreadyReached = false;
			for (let index = 0; index < unreachableFrames.length; index++) {
				if (unreachableFrames[index] !== el) continue;
				alreadyReached = true;
				break;
			}
			if (!alreadyReached) unreachableFrames[unreachableFrames.length] = el;
			if (pierceReach !== null) pierceReach[pierceReach.length] = el;
		}
		return undefined;
	};
	const isClosedShadowSuspect = (el) =>
		el.tagName.includes("-") &&
		shadowOf(el) === null &&
		el.querySelector(interactiveMatcher) === null;
	const isDefinedCustomElement = (el) => {
		const view =
			el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : win;
		return (
			view.customElements !== undefined &&
			view.customElements.get(el.tagName.toLowerCase()) !== undefined
		);
	};
	const closedShadowUnlockPending = (el) => {
		const tried = el.__sandClosedShadowUnlockTried;
		if (tried === true) return false;
		if (tried === "undefined") return isDefinedCustomElement(el);
		return true;
	};
	// Deep querySelector for the scoped snapshot: searches the top document,
	// then open shadow roots and same-origin frames, breadth-first. The
	// explicit ">>>" combinator re-roots each following stage at the previous
	// match, so a pierce selector like
	// 'faceplate-text-input[name="username"] >>> input[name="username"]'
	// resolves the inner control.
	const deepQuery = (selector) => {
		const stages = selector
			.split(">>>")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		// Duplicate matches are the rule on real pages, not the edge case:
		// responsive sites render twin widgets (desktop + mobile) that reuse the
		// same ids and names with one twin hidden — aa.com's adc-text-input
		// booking fields are the canonical shape — and tree-order querySelector
		// hands back whichever twin comes first. A hidden first match used to
		// make the scoped snapshot mint nothing (target_missing) while a
		// perfectly fillable visible twin sat further down the page, so each
		// stage prefers the first VISIBLE match anywhere the deep walk can see
		// and keeps the first hidden match only as the fallback for diagnosis
		// when nothing visible matches.
		const queryStage = (roots, stage) => {
			const queue = [...roots];
			let hiddenFallback = null;
			while (queue.length > 0) {
				const scope = queue.shift();
				for (const found of scope.querySelectorAll(stage)) {
					if (isVisible(found)) return found;
					if (hiddenFallback === null) hiddenFallback = found;
				}
				for (const el of scope.querySelectorAll("*")) {
					const shadow = shadowOf(el);
					if (shadow) queue.push(shadow);
					const tag = el.tagName ? el.tagName.toLowerCase() : "";
					if (tag === "iframe" || tag === "frame") {
						const childDoc = frameDocumentOf(el);
						if (childDoc) queue.push(childDoc);
					}
				}
			}
			return hiddenFallback;
		};
		const searchRootsOf = (from) => {
			if (from === null) return [doc];
			const roots = [];
			const shadow = shadowOf(from);
			if (shadow) roots.push(shadow);
			if (/^(iframe|frame)$/i.test(from.tagName ?? "")) {
				const childDoc = frameDocumentOf(from);
				if (childDoc) roots.push(childDoc);
			}
			roots.push(from);
			return roots;
		};
		let matched = null;
		for (let stage = 0; stage < stages.length; stage++) {
			const unreachableFramesThisStageReached = [];
			pierceReach = unreachableFramesThisStageReached;
			const next = queryStage(searchRootsOf(matched), stages[stage]);
			pierceReach = null;
			if (next === null) {
				pierceFrames = unreachableFramesThisStageReached;
				return {
					element: null,
					closedShadow: matched !== null && isClosedShadowSuspect(matched),
					...(unreachableFramesThisStageReached.length > 0 ? { pierceStage: stage } : {}),
				};
			}
			matched = next;
		}
		return { element: matched, closedShadow: false };
	};
	const trim = (text, max) => {
		const t = (text ?? "").replace(/\s+/g, " ").trim();
		return t.length > max ? t.slice(0, max) + "…" : t;
	};
	const composedTextOf = (root) => {
		const seen = new Set();
		const visit = (node, depth) => {
			if (depth > 20 || seen.has(node)) return "";
			seen.add(node);
			if (node.nodeType === 3) return node.nodeValue ?? "";
			if (node.nodeType !== 1 && node.nodeType !== 11) return "";
			let children = node.childNodes;
			if (
				node.nodeType === 1 &&
				node.tagName.toLowerCase() === "slot" &&
				typeof node.assignedNodes === "function"
			) {
				const assigned = node.assignedNodes({ flatten: true });
				if (assigned.length > 0) children = assigned;
			}
			let text = "";
			for (const child of children) text += " " + visit(child, depth + 1);
			return text;
		};
		return visit(root, 0);
	};
	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria) return trim(aria, 80);
		// aria-labelledby resolves in the element's own root (its shadow root or
		// its document): shadow-DOM inputs are commonly named this way and carry
		// no aria-label of their own.
		const labelledby = el.getAttribute("aria-labelledby");
		if (labelledby) {
			const rootNode = el.getRootNode();
			const scope =
				rootNode && typeof rootNode.getElementById === "function" ? rootNode : el.ownerDocument;
			const text = labelledby
				.split(/\s+/)
				.map((id) => {
					const target = scope.getElementById(id);
					return target ? composedTextOf(target) : "";
				})
				.join(" ");
			const trimmed = trim(text, 80);
			if (trimmed) return trimmed;
		}
		if (el.labels && el.labels.length > 0) return trim(el.labels[0].innerText, 80);
		const placeholder = el.getAttribute("placeholder");
		if (placeholder) return trim(placeholder, 80);
		const alt = el.getAttribute("alt");
		if (alt) return trim(alt, 80);
		const title = el.getAttribute("title");
		if (title) return trim(title, 80);
		return trim(el.innerText ?? el.value ?? "", 80);
	};
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			const type = (el.getAttribute("type") ?? "text").toLowerCase();
			if (type === "button" || type === "submit" || type === "reset") return "button";
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "range") return "slider";
			return "textbox";
		}
		if (/^h[1-6]$/.test(tag)) return "heading";
		return tag;
	};
	const describe = (el, depth) => {
		const role = roleOf(el);
		let name = nameOf(el);
		// An editable's own text can be its snapshot name — a contenteditable's
		// content directly, and an input's or textarea's through nameOf's
		// innerText/value fallback — so glyphs a focus-steal diverted into one
		// would serialize there rather than on a value= line. The secret checks
		// gate exactly those names: a label- or aria-derived name never carried
		// typed glyphs, and wiping a real field label that happens to sit
		// inside a secret would hide the very label the model targets by.
		const editableHost =
			el.isContentEditable === true || el.getAttribute("contenteditable") === "true";
		const isValueBearing = /^(input|textarea)$/i.test(el.tagName);
		const nameCameFromOwnContent =
			editableHost || (isValueBearing && name === trim(el.innerText ?? el.value ?? "", 80));
		// An own-content name carries the SAME signals as a value= line: the
		// element mark, the split group's concatenation, and the registered
		// sets. Anything weaker would let an unlabeled split-OTP box serialize
		// its digit as the line's name while its value= sits redacted.
		const nameIsSecret =
			nameCameFromOwnContent &&
			(el.hasAttribute("data-sand-secret-filled") ||
				declaresSecretValue(el) ||
				isSecretForElement(el, name, isValueBearing));
		if (name.length > 0 && nameIsSecret) {
			name = "<redacted>";
		}
		let line = "  ".repeat(Math.min(depth, 6)) + "- " + role;
		if (name) line += " " + JSON.stringify(name);
		if (el.matches(interactiveMatcher) && !el.disabled) {
			let ref;
			if (stableRefs) {
				const cached = state.byElement.get(el);
				if (
					cached !== undefined &&
					(opts.probe === true || (cached.role === role && cached.name === name))
				) {
					ref = cached.ref;
				} else {
					if (cached !== undefined) state.byRef.delete(cached.ref);
					state.counter += 1;
					ref = "e" + String(state.counter);
					state.byElement.set(el, { ref: ref, role: role, name: name });
				}
				state.byRef.set(ref, new WeakRef(el));
			} else {
				ref = "e" + String(refStart + refsThisWalk + 1);
				if (opts.probe !== true) {
					state.byRef.set(ref, new WeakRef(el));
				}
			}
			refsThisWalk += 1;
			line += " [ref=" + ref + "]";
		}
		if (el.disabled) line += " disabled";
		if (el.draggable === true) line += " draggable";
		if (el.checked === true) line += " checked";
		const tag = el.tagName.toLowerCase();
		if (
			(tag === "input" || tag === "textarea") &&
			typeof el.value === "string" &&
			el.value.length > 0
		) {
			// A host-filled secret is redacted by two independent signals: the
			// driver's element mark (survives the site reformatting the value) and
			// the registered value sets (survive a re-render replacing the marked
			// element) — the element's own window's and the top window's, judged
			// by exact membership, the split group's concatenation, and fragment
			// containment (see isSecretForElement). Either signal alone redacts,
			// so a secret that landed in a plain text control is never serialized
			// back to the model.
			const hasSecretFillValue = isSecretForElement(el, el.value, tag === "input");
			const isSecret =
				declaresSecretValue(el) || el.hasAttribute("data-sand-secret-filled") || hasSecretFillValue;
			line += " value=" + (isSecret ? '"<redacted>"' : JSON.stringify(trim(el.value, 40)));
		}
		if (tag === "a") {
			const href = el.getAttribute("href");
			if (href && !href.startsWith("javascript:"))
				line += " href=" + JSON.stringify(trim(href, 80));
		}
		return line;
	};
	const walk = (el, depth) => {
		if (nodeCount >= maxNodes || depth > (opts.maxDepth ?? 20)) return;
		// Instanceof against the element's OWN window: a pierced child frame's
		// elements are instances of THAT frame's HTMLElement, never the top one.
		const view =
			el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : win;
		if (!(el instanceof view.HTMLElement)) return;
		const tag = el.tagName.toLowerCase();
		if (tag === "script" || tag === "style" || tag === "noscript") return;
		if (hidesSubtree(el)) return;
		const hasBox = hasVisibleBox(el);
		// Zero-size layout wrappers can contain painted controls, so omit their
		// own description but keep walking descendants. Frames still require a
		// visible box before traversal or unreachable accounting.
		if (tag === "iframe" || tag === "frame") {
			if (!hasBox) return;
			const childDoc = frameDocumentOf(el);
			if (childDoc !== undefined) {
				for (const child of childDoc.body.children) walk(child, depth);
			}
			return;
		}
		if (!hasBox && emptyBoxClipsEverythingInsideIt(el)) return;
		const isInteractive = el.matches(interactiveMatcher);
		const isHeading = /^h[1-6]$/.test(tag);
		const isTextual =
			!opts.interactive &&
			(tag === "p" || tag === "li" || tag === "label" || tag === "td" || tag === "th");
		if (hasBox && !isInteractive && isClosedShadowSuspect(el)) {
			if (opts.settleClosedShadow === true) {
				el.__sandClosedShadowUnlockTried = isDefinedCustomElement(el) ? true : "undefined";
			} else if (closedShadowUnlockPending(el)) {
				closedShadowSuspects += 1;
			}
		}
		let childDepth = depth;
		if (
			hasBox &&
			(isInteractive ||
				isHeading ||
				(isTextual &&
					trim(el.innerText, 10).length > 0 &&
					el.querySelector(interactiveMatcher) === null))
		) {
			nodeCount += 1;
			lines.push(describe(el, depth));
			childDepth = depth + 1;
			if (isInteractive || isTextual) return;
		}
		// An open shadow root's children walk like light children — the editable
		// controls of custom elements (e.g. <faceplate-text-input>) live there.
		// Both trees are covered exactly once: slotted light children stay in
		// el.children, the shadow tree's own nodes appear only here.
		const shadow = shadowOf(el);
		if (shadow) {
			for (const child of shadow.children) walk(child, childDepth);
		}
		for (const child of el.children) walk(child, childDepth);
	};
	let selectorDiagnosis;
	let root;
	if (opts.selector) {
		const queried = deepQuery(opts.selector);
		root = queried.element ?? undefined;
		selectorDiagnosis = {
			matched: queried.element !== null,
			closedShadow: queried.closedShadow,
			...(queried.pierceStage !== undefined ? { pierceStage: queried.pierceStage } : {}),
		};
	} else {
		root = doc.body;
	}
	if (!root) {
		return withReachedFrameElements({
			lines: ["[gen=" + state.generation + "]", "(no matching element for selector)"],
			refCount: 0,
			counterEnd: state.counter,
			frameToken: state.frameToken,
			unreachableFrames: unreachableFrames.length,
			closedShadowSuspects,
			selector: selectorDiagnosis,
		});
	}
	walk(root, 0);
	if (nodeCount >= maxNodes)
		lines.push("(snapshot truncated at " + String(maxNodes) + " elements)");
	// A scoped snapshot that matched an element but minted nothing fillable is
	// the closed-shadow signature when the match is a custom element whose
	// internals nothing can reach.
	if (selectorDiagnosis !== undefined && refsThisWalk === 0 && isClosedShadowSuspect(root)) {
		selectorDiagnosis.closedShadow = true;
	}
	if (!stableRefs && state.counter < refStart + refsThisWalk) {
		state.counter = refStart + refsThisWalk;
	}
	return withReachedFrameElements({
		lines,
		refCount: refsThisWalk,
		counterEnd: state.counter,
		frameToken: state.frameToken,
		unreachableFrames: unreachableFrames.length,
		closedShadowSuspects,
		selector: selectorDiagnosis,
	});
};

const FRAME_EVALUATE_TIMEOUT_MS = 4000;

const UNREACHABLE_FRAMES_NOTE =
	" frame(s) on this page could not be inspected — cross-origin and still loading, or otherwise unreadable — so fields inside them are NOT in this snapshot and have no refs)";

const PARENT_CAN_SCRIPT_FN = () => {
	try {
		return globalThis.parent.document !== null;
	} catch {
		return false;
	}
};

async function walkRootFrames(page) {
	const main = page.mainFrame();
	const roots = [];
	for (const frame of page.frames()) {
		if (frame === main || frame.isDetached()) continue;
		const scriptable = await withDeadline(
			frame.evaluate(PARENT_CAN_SCRIPT_FN),
			FRAME_EVALUATE_TIMEOUT_MS,
			"frame probe timed out",
		).catch((failure) => noteIgnoredFailure("probing a frame's cross-origin boundary", failure));
		if (scriptable !== false) continue;
		const element = await frame
			.frameElement()
			.catch((failure) => noteIgnoredFailure("resolving a cross-origin frame's element", failure));
		if (element === undefined || element === null) continue;
		const box = await element.boundingBox().catch((failure) => {
			noteIgnoredFailure("measuring a cross-origin frame's box", failure);
			return null;
		});
		if (box === null || box.width <= 0 || box.height <= 0) continue;
		let depth = 0;
		for (let f = frame.parentFrame(); f !== null; f = f.parentFrame()) depth += 1;
		roots.push({ frame, element, depth });
	}
	roots.sort((a, b) => a.depth - b.depth);
	return roots;
}

const FRAME_ATTACH_WAIT_MS = 1500;

async function awaitWalkRootFrames(page, expected) {
	const deadline = Date.now() + FRAME_ATTACH_WAIT_MS;
	for (;;) {
		const roots = await walkRootFrames(page);
		if (roots.length >= expected || Date.now() >= deadline) return roots;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function unlockClosedShadowRoots(context, page, frame) {
	let session;
	try {
		session = await context.newCDPSession(frame);
	} catch (failure) {
		noteIgnoredFailure("opening a CDP session for the closed-shadow unlock", failure);
		return false;
	}
	let scanned = false;
	try {
		const { root } = await withDeadline(
			session.send("DOM.getDocument", { depth: -1, pierce: true }),
			FRAME_EVALUATE_TIMEOUT_MS * 2,
			"DOM.getDocument timed out",
		);
		const closedRoots = [];
		const visit = (node) => {
			for (const shadow of node.shadowRoots ?? []) {
				if (shadow.shadowRootType === "closed") closedRoots.push(shadow.backendNodeId);
				visit(shadow);
			}
			for (const child of node.children ?? []) visit(child);
			if (node.contentDocument) visit(node.contentDocument);
			if (node.templateContent) visit(node.templateContent);
		};
		visit(root);
		scanned = true;
		for (const backendNodeId of closedRoots) {
			try {
				const { object } = await session.send("DOM.resolveNode", { backendNodeId });
				await session.send("Runtime.callFunctionOn", {
					objectId: object.objectId,
					functionDeclaration: "function () { if (this.host) this.host.__sandShadowRoot = this; }",
				});
				await session
					.send("Runtime.releaseObject", { objectId: object.objectId })
					.catch((failure) => noteIgnoredFailure("releasing an unlocked shadow root", failure));
			} catch (failure) {
				noteIgnoredFailure("unlocking a closed shadow root", failure);
			}
		}
	} catch (failure) {
		noteIgnoredFailure("listing the closed shadow roots", failure);
	} finally {
		await detachOrNote(session, "closed-shadow unlock's");
	}
	return scanned;
}

async function hostFramesFromElements(elementsHandle) {
	const frames = new Set();
	const handles = await elementsHandle.getProperties();
	for (const handle of handles.values()) {
		try {
			const element = handle.asElement();
			if (element === null) continue;
			const frame = await element.contentFrame().catch((failure) => {
				noteIgnoredFailure("resolving a walked frame's host identity", failure);
				return null;
			});
			if (frame !== null) frames.add(frame);
		} finally {
			await handle.dispose();
		}
	}
	return frames;
}

async function evaluateSnapshotFrame(frame, opts) {
	const envelope = await frame.evaluateHandle(SNAPSHOT_FN, {
		...opts,
		__sandFrameIdentityEnvelope: true,
	});
	const parts = await envelope.getProperties();
	try {
		const resultHandle = parts.get("result");
		const reachedHandle = parts.get("reachedFrameElements");
		if (resultHandle === undefined || reachedHandle === undefined) {
			throw new Error("Snapshot frame identity envelope was incomplete");
		}
		return {
			...(await resultHandle.jsonValue()),
			reachedHostFrames: await hostFramesFromElements(reachedHandle),
		};
	} finally {
		for (const handle of parts.values()) await handle.dispose();
		await envelope.dispose();
	}
}

async function snapshotFrame(context, page, frame, opts) {
	let result = await evaluateSnapshotFrame(frame, opts);
	if (result.closedShadowSuspects > 0 && (await unlockClosedShadowRoots(context, page, frame))) {
		result = await evaluateSnapshotFrame(frame, { ...opts, settleClosedShadow: true });
	}
	return result;
}

function frameLabelOf(element) {
	return element
		.evaluate((el) => {
			const title = el.getAttribute("title") ?? el.getAttribute("name") ?? "";
			let host = "";
			try {
				host = new URL(el.src, el.ownerDocument.baseURI).host;
			} catch {
				host = "";
			}
			return [title, host].filter((part) => part.length > 0).join(" ");
		})
		.catch(() => "");
}

const RAISE_REF_COUNTER_FLOOR_FN = (floor) => {
	const state = globalThis.__sandRefState;
	if (state != null && typeof state.counter === "number" && state.counter < floor) {
		state.counter = floor;
	}
};

function remainingPierceSelector(selector, fromStage) {
	return selector
		.split(">>>")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.slice(fromStage)
		.join(" >>> ");
}

const SNAPSHOT_REF_PATTERN = /\[ref=(e\d+)\]/;

function recordRefOwners(refOwners, lines, owner) {
	for (const line of lines) {
		const match = SNAPSHOT_REF_PATTERN.exec(line);
		if (match !== null) refOwners[match[1]] = owner;
	}
}

async function snapshotAcrossFrames(context, page, opts) {
	const scoped = typeof opts.selector === "string";
	const main = await snapshotFrame(context, page, page, { ...opts, refStart: 0 });
	const lines = [...main.lines];
	const refOwners = {};
	recordRefOwners(refOwners, main.lines, null);
	let refCount = main.refCount;
	let nextRef = typeof main.counterEnd === "number" ? main.counterEnd : refCount;
	let unreachable = main.unreachableFrames;
	let closedShadowSuspects = main.closedShadowSuspects ?? 0;
	let selectorDiagnosis = main.selector;
	const finish = () => {
		if (unreachable > 0) lines.push("(" + String(unreachable) + UNREACHABLE_FRAMES_NOTE);
		return {
			lines,
			refCount,
			refOwners,
			unreachableFrames: unreachable,
			closedShadowSuspects,
			selector: selectorDiagnosis,
		};
	};
	if (unreachable === 0) return finish();
	if (
		scoped &&
		(selectorDiagnosis === undefined ||
			selectorDiagnosis.matched ||
			selectorDiagnosis.pierceStage === undefined)
	) {
		return finish();
	}
	const roots = await awaitWalkRootFrames(page, unreachable);
	if (roots.length === 0) return finish();
	const searchedParents = new Map([
		[
			page.mainFrame(),
			{
				selector: opts.selector,
				pierceStage: selectorDiagnosis?.pierceStage,
				reachedFrames: main.reachedHostFrames,
			},
		],
	]);
	const crossOriginFrames = new Set(roots.map((root) => root.frame));
	const searchedAncestorOf = (frame) => {
		for (let ancestor = frame.parentFrame(); ancestor !== null; ancestor = ancestor.parentFrame()) {
			const searched = searchedParents.get(ancestor);
			if (searched !== undefined) return searched;
			if (crossOriginFrames.has(ancestor)) return undefined;
		}
		return undefined;
	};
	let successfullyWalkedFrames = 0;
	for (const { frame, element } of roots) {
		const parent = searchedAncestorOf(frame);
		if (parent === undefined || (scoped && parent.pierceStage === undefined)) continue;
		if (!parent.reachedFrames.has(frame)) continue;
		const selector = scoped
			? remainingPierceSelector(parent.selector, parent.pierceStage)
			: undefined;
		const frameOpts = { ...opts, selector, refStart: nextRef, frameToken: randomUUID() };
		let result;
		try {
			result = await withDeadline(
				snapshotFrame(context, page, frame, frameOpts),
				FRAME_EVALUATE_TIMEOUT_MS * 3,
				"the frame snapshot timed out",
			);
		} catch (failure) {
			noteIgnoredFailure("snapshotting a cross-origin frame", failure);
			continue;
		}
		searchedParents.set(frame, {
			selector,
			pierceStage: result.selector?.pierceStage,
			reachedFrames: result.reachedHostFrames,
		});
		successfullyWalkedFrames += 1;
		if (typeof result.counterEnd === "number") nextRef = Math.max(nextRef, result.counterEnd);
		unreachable += result.unreachableFrames;
		closedShadowSuspects += result.closedShadowSuspects ?? 0;
		if (scoped) {
			if (result.selector === undefined || !result.selector.matched) continue;
			lines.length = 0;
			selectorDiagnosis = result.selector;
		}
		if (typeof result.frameToken === "string") {
			recordRefOwners(refOwners, result.lines, result.frameToken);
		}
		refCount += result.refCount;
		const frameLines = result.lines.filter((line) => !line.startsWith("[gen="));
		if (frameLines.length > 0) {
			lines.push(
				'- frame "' + (await frameLabelOf(element)) + '" (cross-origin, walked in its own context)',
			);
			lines.push(...frameLines.map((line) => "  " + line));
		}
		if (scoped) break;
	}
	if (successfullyWalkedFrames > 0) {
		await page
			.evaluate(RAISE_REF_COUNTER_FLOOR_FN, nextRef)
			.catch((failure) => noteIgnoredFailure("raising the top frame's ref counter", failure));
	}
	unreachable = Math.max(0, unreachable - successfullyWalkedFrames);
	return finish();
}

const EDITABLE_TARGET_FN = (el) => {
	// Editable = a control the write ops can act on. Hidden and button-like
	// input types never are: custom widgets commonly keep an input
	// type="hidden" for form association, and descending to it would trade a
	// click on the host (which delegated focus may deliver) for a write that
	// times out on an invisible element.
	const NEVER_EDITABLE_INPUT_TYPES = [
		"hidden",
		"button",
		"submit",
		"reset",
		"image",
		"file",
		"checkbox",
		"radio",
	];
	const isEditable = (node) => {
		const tag = node.tagName ? node.tagName.toLowerCase() : "";
		if (tag === "textarea" || tag === "select" || node.isContentEditable === true) return true;
		if (tag !== "input") return false;
		const type = (node.getAttribute("type") ?? "text").toLowerCase();
		return !NEVER_EDITABLE_INPUT_TYPES.includes(type);
	};
	// The descent walks PAST an editable the page hides from the user: bot
	// honeypots (GitHub's input[name^="required_field_"]), autofill decoys
	// (Amazon's #auth-credential-autofill-hint), a two-step login's unrevealed
	// password (Microsoft's #i0118). Hidden is the snapshot's isVisible rule:
	// not rendered, a zero-size box, or the control's OWN aria-hidden — an
	// ANCESTOR's aria-hidden does not count, because cookie-consent and modal
	// libraries set it on main/#app while the fields underneath stay painted.
	const isHiddenDecoy = (node) => {
		const view =
			node.ownerDocument && node.ownerDocument.defaultView
				? node.ownerDocument.defaultView
				: globalThis;
		const style = view.getComputedStyle(node);
		if (style.display === "none" || style.visibility === "hidden") return true;
		const rect = node.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return true;
		return node.getAttribute("aria-hidden") === "true";
	};
	if (isEditable(el)) return el;
	const queue = [el];
	while (queue.length > 0) {
		const current = queue.shift();
		const shadow = current.shadowRoot ?? current.__sandShadowRoot ?? null;
		const scopes = shadow ? [shadow, current] : [current];
		for (const scope of scopes) {
			for (const child of scope.children) {
				if (isEditable(child) && !isHiddenDecoy(child)) return child;
				queue.push(child);
			}
		}
	}
	return el;
};

async function editableHandle(element) {
	const handle = await element.evaluateHandle(EDITABLE_TARGET_FN);
	return handle.asElement() ?? element;
}

const WRITE_TARGET_IS_HIDDEN_FN = (el) => {
	const view =
		el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : globalThis;
	const style = view.getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden") return true;
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return true;
	return el.getAttribute("aria-hidden") === "true";
};

async function writeTargetFrameIsHidden(page, element) {
	let frame = await element.ownerFrame().catch((failure) => {
		noteIgnoredFailure("resolving a write target's frame", failure);
		return null;
	});
	for (; frame !== null && frame !== page.mainFrame(); frame = frame.parentFrame()) {
		const frameElement = await frame.frameElement().catch((failure) => {
			noteIgnoredFailure("resolving a write target's frame element", failure);
			return null;
		});
		if (frameElement === null || (await frameElement.evaluate(WRITE_TARGET_IS_HIDDEN_FN))) {
			return true;
		}
	}
	return false;
}

async function writeTargetHandle(page, ref) {
	const element = await editableHandle(await refHandle(page, ref));
	if (
		(await element.evaluate(WRITE_TARGET_IS_HIDDEN_FN)) ||
		(await writeTargetFrameIsHidden(page, element))
	) {
		throw new Error(
			"Hidden target " +
				JSON.stringify(ref) +
				": the control is not painted (display:none, visibility:hidden, zero size, or aria-hidden), so it is a hidden duplicate or decoy of the field the user sees and was not written. Take a fresh browser_snapshot and use the ref of the visible control.",
		);
	}
	return element;
}

const FILL_COMMIT_STATE_FN = (el, value) => {
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag !== "input" && tag !== "textarea") return "unverifiable";
	const significant = (text) =>
		String(text ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
	if (significant(value).length === 0) return "unverifiable";
	return significant(el.value).length === 0 ? "swallowed" : "committed";
};

async function fillCommitState(element, value) {
	return element.evaluate(FILL_COMMIT_STATE_FN, value);
}

async function typeFillValuePerKey(page, element, value, secret) {
	if (secret !== true) {
		await page.keyboard.type(value, { delay: 20 });
		return;
	}
	if (!(await element.evaluate(TOP_WINDOW_REACHABLE_FN))) {
		throw new Error(
			"The target sits in a cross-origin frame, where the host cannot watch keyboard focus across the frame boundary while a secret types, so the per-key fill was refused and the field was left unfilled. Hand the user the screen for this field.",
		);
	}
	noteSkippedDocuments(
		"arming the secret-fill focus sentinel on every reachable document",
		await element.evaluate(ARM_SECRET_FILL_FOCUS_SENTINEL_FN),
	);
	try {
		for (const char of value) {
			if (!(await element.evaluate(SECRET_FILL_FOCUS_IN_SCOPE_FN))) {
				throw new Error(
					"The page moved keyboard focus away from the target while a secret was being typed, so the fill was stopped. Hand the user the screen if this recurs.",
				);
			}
			await page.keyboard.type(char);
			await sleep(20);
		}
	} finally {
		await element
			.evaluate(DISARM_SECRET_FILL_FOCUS_SENTINEL_FN)
			.then((kept) => noteSkippedDocuments("disarming the secret-fill focus sentinel", kept))
			.catch((failure) => noteIgnoredFailure("disarming the secret-fill focus sentinel", failure));
	}
}

const SPLIT_CHAR_GROUP_FN = (el) => {
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag !== "input" || el.getAttribute("maxlength") !== "1") return 0;
	let container = el.parentElement;
	for (let depth = 0; container !== null && depth < 3; depth++) {
		const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
		if (boxes.length >= 2 && boxes.includes(el)) return boxes.length;
		container = container.parentElement;
	}
	return 0;
};

const SPLIT_CHAR_COMMIT_FN = (el, value) => {
	let group = [];
	let container = el.parentElement;
	for (let depth = 0; container !== null && depth < 3; depth++) {
		const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
		if (boxes.length >= 2 && boxes.includes(el)) {
			group = boxes;
			break;
		}
		container = container.parentElement;
	}
	if (group.length < 2) return "swallowed";
	const significant = (text) =>
		String(text ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
	const held = significant(group.map((box) => box.value).join(""));
	return held === significant(value) && held.length > 0 ? "committed" : "swallowed";
};

const SECRET_FILL_FOCUS_IN_SCOPE_FN = (el) => {
	const doc = el.ownerDocument;
	let active = doc.activeElement;
	for (let hops = 0; active && hops < 10; hops++) {
		const shadow = active.shadowRoot ?? active.__sandShadowRoot ?? null;
		if (!shadow || !shadow.activeElement) break;
		active = shadow.activeElement;
	}
	if (active === null || active === undefined) return false;
	if (active === el || (typeof el.contains === "function" && el.contains(active))) return true;
	// Scope is the group's BOXES, never the whole container: a page can nest
	// a non-box thief control inside the container, and container.contains
	// would let it collect keystrokes unguarded.
	if (el.getAttribute("maxlength") === "1") {
		let container = el.parentElement;
		for (let depth = 0; container !== null && depth < 3; depth++) {
			const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
			if (boxes.length >= 2 && boxes.includes(el)) return boxes.includes(active);
			container = container.parentElement;
		}
	}
	return false;
};

const ARM_SECRET_FILL_FOCUS_SENTINEL_FN = (el) => {
	const doc = el.ownerDocument;
	const win = doc.defaultView ?? globalThis;
	let topWin = win;
	try {
		if (win.top && win.top.document) topWin = win.top;
	} catch {
		topWin = win;
	}
	const inScope = (node) => {
		if (node === el || (typeof el.contains === "function" && el.contains(node))) return true;
		if (el.getAttribute("maxlength") === "1") {
			let container = el.parentElement;
			for (let depth = 0; container !== null && depth < 3; depth++) {
				const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
				if (boxes.length >= 2 && boxes.includes(el)) return boxes.includes(node);
				container = container.parentElement;
			}
		}
		return false;
	};
	const deepFocusTarget = (node) => {
		let current = node;
		for (let hops = 0; current && hops < 10; hops++) {
			let framed;
			try {
				if (
					current.tagName &&
					/^(iframe|frame)$/i.test(current.tagName) &&
					current.contentDocument &&
					current.contentDocument.activeElement
				) {
					framed = current.contentDocument.activeElement;
				}
			} catch {
				framed = null;
			}
			if (framed) {
				current = framed;
				continue;
			}
			const shadow = current.shadowRoot ?? current.__sandShadowRoot ?? null;
			if (shadow && shadow.activeElement) {
				current = shadow.activeElement;
				continue;
			}
			break;
		}
		return current;
	};
	const docs = [];
	let skipped = 0;
	const collectDocs = (rootDoc) => {
		docs.push(rootDoc);
		for (const frame of rootDoc.querySelectorAll("iframe, frame")) {
			try {
				if (frame.contentDocument && docs.length < 20 && !docs.includes(frame.contentDocument)) {
					collectDocs(frame.contentDocument);
				}
			} catch {
				skipped += 1;
			}
		}
	};
	try {
		collectDocs(topWin.document);
	} catch {
		skipped += 1;
	}
	if (!docs.includes(doc)) docs.push(doc);
	const previousDisarm = topWin.__sandSecretFillFocusSentinel;
	if (typeof previousDisarm === "function") previousDisarm();
	const listener = (event) => {
		const target = deepFocusTarget(event.target);
		if (target && typeof target.setAttribute === "function" && !inScope(target)) {
			target.setAttribute("data-sand-secret-filled", "");
		}
	};
	for (const d of docs) {
		try {
			d.addEventListener("focusin", listener, true);
		} catch {
			skipped += 1;
		}
	}
	let timer;
	const disarm = () => {
		let kept = 0;
		for (const d of docs) {
			try {
				d.removeEventListener("focusin", listener, true);
			} catch {
				kept += 1;
			}
		}
		topWin.clearTimeout(timer);
		if (topWin.__sandSecretFillFocusSentinel === disarm) {
			topWin.__sandSecretFillFocusSentinel = undefined;
		}
		return kept;
	};
	timer = topWin.setTimeout(disarm, 30000);
	topWin.__sandSecretFillFocusSentinel = disarm;
	return skipped;
};

const DISARM_SECRET_FILL_FOCUS_SENTINEL_FN = (el) => {
	const doc = el.ownerDocument;
	const win = doc.defaultView ?? globalThis;
	let topWin = win;
	try {
		if (win.top && win.top.document) topWin = win.top;
	} catch {
		topWin = win;
	}
	const disarm = topWin.__sandSecretFillFocusSentinel;
	return typeof disarm === "function" ? disarm() : 0;
};

const TOP_WINDOW_REACHABLE_FN = (el) => {
	try {
		return Boolean(el.ownerDocument.defaultView.top.document);
	} catch {
		return false;
	}
};

const MARK_SECRET_FILL_FN = (el, value) => {
	const win = el.ownerDocument.defaultView ?? globalThis;
	// Register on the element's own window AND the top window: a focus-steal's
	// keystrokes land in whatever frame holds focus, and snapshots consult the
	// top set (secretFillSetsFor). An unreachable top receives no bookkeeping.
	let topReached = true;
	const registerValue = (registered) => {
		if (!(win.__sandSecretFillValues instanceof Set)) win.__sandSecretFillValues = new Set();
		win.__sandSecretFillValues.add(registered);
		try {
			if (win.top && win.top !== win) {
				if (!(win.top.__sandSecretFillValues instanceof Set))
					win.top.__sandSecretFillValues = new Set();
				win.top.__sandSecretFillValues.add(registered);
			}
		} catch {
			topReached = false;
		}
	};
	registerValue(value);
	el.setAttribute("data-sand-secret-filled", "");
	// A split-character group carries the secret across sibling boxes, so
	// every box gets the element mark; single-character box values stay out
	// of the value set (redacting every lone "1" on the page would
	// over-redact wildly), the marks and the group concatenation cover them.
	if (el.getAttribute("maxlength") === "1") {
		let container = el.parentElement;
		for (let depth = 0; container !== null && depth < 3; depth++) {
			const boxes = [...container.querySelectorAll('input[maxlength="1"]')];
			if (boxes.length >= 2 && boxes.includes(el)) {
				for (const box of boxes) box.setAttribute("data-sand-secret-filled", "");
				const held = boxes.map((box) => box.value).join("");
				if (held.length > 1) registerValue(held);
				break;
			}
			container = container.parentElement;
		}
	}
	if (typeof el.value === "string" && el.value.length > 1) registerValue(el.value);
	return topReached;
};

const referenceFill = async ({ request, page, element: suppliedElement = undefined }: any) => {
		const viewId = "";
		const element = suppliedElement ?? await writeTargetHandle(page, request.ref);
		// What the LIVE control says it is, read from the exact element the write
		// goes to — not from the card's model-authored type/secret. The host's
		// vault refuses to save a value whose real destination was secret-shaped
		// (password type, credential/OTP/payment autocomplete, a split-character
		// code widget, or site-authored name/id/aria/placeholder text that sniffs
		// credential- or payment-like), and it fails closed when this capture is
		// missing, so a capture error only skips a convenience save.
		const controlBase = await element
			.evaluate((el) => {
				const attr = (name) => String(el.getAttribute(name) ?? "");
				// Case is preserved on purpose: the vault's credential/payment sniffs
				// are case-insensitive but split camelCase on uppercase humps, so
				// lowercasing here would glue ids like "verificationCode" into one
				// unmatchable token.
				const descriptor = [
					attr("name"),
					String(el.id ?? ""),
					attr("aria-label"),
					attr("placeholder"),
				]
					.filter((part) => part.length > 0)
					.join(" ");
				return {
					type: String(el.type ?? el.tagName ?? "").toLowerCase(),
					autoComplete: attr("autocomplete").toLowerCase(),
					...(descriptor.length > 0 ? { descriptor } : {}),
				};
			})
			.catch((error) => {
				console.error("control capture failed (vault save gate fails closed): " + String(error));
				return undefined;
			});
		let summary = "Filled " + (request.element ?? request.ref);
		// The group-membership probe runs unconditionally so the control report
		// marks a split-code box even for a single-character write; the per-key
		// FILL path keeps its original multi-character trigger.
		const splitGroupSize = await element.evaluate(SPLIT_CHAR_GROUP_FN).catch(() => 0);
		const control =
			controlBase !== undefined && splitGroupSize >= 2
				? { ...controlBase, splitCharGroup: true }
				: controlBase;
		const splitBoxCount =
			typeof request.value === "string" && request.value.length > 1 ? splitGroupSize : 0;
		try {
			if (splitBoxCount >= 2) {
				// Split OTP path: type per key so the widget's focus auto-advance
				// distributes the characters, then judge the GROUP's concatenation —
				// a bulk insert would clamp to the first box and read as a
				// committed-looking single character.
				await element.click({ timeout: ACTION_TIMEOUT_MS });
				await typeFillValuePerKey(page, element, request.value, request.secret);
				if ((await element.evaluate(SPLIT_CHAR_COMMIT_FN, request.value)) === "swallowed") {
					throw new Error(
						"The target is a split-character code widget and the typed characters did not distribute across its boxes, so the code was left unfilled. Hand the user the screen if this recurs.",
					);
				}
				summary += " (distributed per key across the split-character code widget)";
			} else {
				await element.fill(request.value);
				// Masked controls can cancel the single bulk insertText that element.fill
				// performs (their beforeinput handlers only accept one key at a time), so
				// an ok from fill alone would report a field the page still shows empty.
				// When the control swallowed the write, retry as real per-key typing —
				// the event stream mask libraries are built for — then blur so the
				// control commits and fires its change; a control that swallows both
				// paths fails the op instead of pretending, with no value in the error.
				if ((await fillCommitState(element, request.value)) === "swallowed") {
					await element.click({ timeout: ACTION_TIMEOUT_MS });
					await element
						.fill("")
						.catch((failure) =>
							noteIgnoredFailure("clearing the masked control before per-key typing", failure),
						);
					await typeFillValuePerKey(page, element, request.value, request.secret);
					if ((await fillCommitState(element, request.value)) === "swallowed") {
						throw new Error(
							"The control did not keep the inserted text: an input mask on the page rejected both the set-value insert and per-key typing, so the field was left unfilled.",
						);
					}
					// Blur commits the mask's state, and the change dispatch stands in for
					// the native blur-change: a mask that cancels beforeinput and writes
					// the value itself never sets the browser's dirty flag, so the native
					// event cannot be counted on.
					await element.evaluate((el) => {
						el.blur();
						el.dispatchEvent(new Event("change", { bubbles: true }));
					});
					// The commit itself can swallow the write: a mask that clears an
					// incomplete value when it loses focus leaves the control empty
					// AFTER the pre-blur check passed, and reporting ok there would
					// fake a filled field — the exact lie this commit pipeline exists
					// to stop. Re-judge and fail honestly, with no value in the error.
					if ((await fillCommitState(element, request.value)) === "swallowed") {
						throw new Error(
							"The control cleared the typed text when it committed on blur: the page's input mask discarded the value, so the field was left unfilled.",
						);
					}
					summary += " (per-key typing; the control's input mask swallowed the set-value insert)";
				}
			}
		} catch (error) {
			// A failed or swallowed secret fill can still have typed fragments
			// into the DOM (a partial split-OTP distribution, mask remnants), so
			// the redaction marks must land BEFORE the failure surfaces — a later
			// snapshot would otherwise serialize those fragments to the model.
			// Best-effort: the op already reports the fill failure, and a page torn
			// down mid-op has no DOM left to leak.
			if (request.secret === true) {
				await markSecretFill(element, request.value).catch((failure) =>
					noteIgnoredFailure("marking the failed secret fill for redaction", failure),
				);
			}
			throw error;
		}
		// A host fill of a write-only secret leaves two redaction signals for
		// SNAPSHOT_FN, because the target can be an ordinary text control (OTP,
		// card fields, or a mis-resolved ref) whose value would otherwise be
		// serialized back to the model: the element mark survives the site
		// reformatting the value, the page-scoped value set survives a re-render
		// replacing the marked element. Both live inside the page, which already
		// holds the value in its own DOM, so neither adds exposure — and a failed
		// mark fails the op, so the fill only counts when the redaction
		// guarantee landed with it.
		if (request.secret === true) {
			await markSecretFill(element, request.value);
		}
		return { page, viewId, summary, ...(control === undefined ? {} : { control }) };
	};

const referenceType = async ({ request, page }) => {
		const viewId = "";
		const element = await writeTargetHandle(page, request.ref);
		await element.click({ timeout: ACTION_TIMEOUT_MS });
		if (request.clear === true) {
			await element
				.fill("")
				.catch((failure) => noteIgnoredFailure("clearing the control before typing", failure));
		}
		await page.keyboard.type(request.text, { delay: request.slowly === true ? 40 : 0 });
		if (request.submit === true) {
			await page.keyboard.press("Enter");
			await settleAfter(page, "the submit", 5000);
		}
		return { page, viewId, summary: "Typed into " + (request.element ?? request.ref) };
	};

export { snapshotAcrossFrames, refHandle, frameRefsByPage, referenceFill, referenceType, editableHandle, writeTargetFrameIsHidden, WRITE_TARGET_IS_HIDDEN_FN, gotoWithRecovery, navigationNote, recoverErrorPage, settleIntoErrorPage, isChromeErrorPage, markSecretFill, SPLIT_CHAR_GROUP_FN };
