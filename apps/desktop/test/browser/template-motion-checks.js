(() => {
  const checks = [];
  let memoryIndex = 0;
  const wait = async (ms = 260) => {
    await new Promise((r) => setTimeout(r, ms));
    if (ms < 200) return; // Short waits deliberately interrupt navigation.
    await Promise.all(
      [
        ...document.querySelectorAll(
          ".template-details, .template-header, .template-mark, .template-page"
        ),
      ]
        .flatMap((node) => node.getAnimations())
        .map((animation) => animation.finished.catch(() => {}))
    );
    await new Promise(requestAnimationFrame);
  };
  const assert = (value, label) => {
    checks.push({ label, passed: !!value });
    if (!value) throw new Error(label);
  };
  const get = (sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error("Missing " + sel);
    return node;
  };
  const button = (label) => {
    const node = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label
    );
    if (!node) throw new Error("Missing button " + label);
    return node;
  };
  const click = async (sel) => {
    get(sel).click();
    await wait();
  };
  const rect = (sel) => {
    const r = get(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const state = () => ({
    page: get(".template-page:not(.outgoing)").dataset.page,
    dialog: rect(".template-details"),
    navigation: rect(".template-navigation"),
    card: document.querySelector(".template-card") ? rect(".template-card") : null,
    header: rect(".template-header"),
    title: get(".template-header h2").textContent,
    scroll: {
      height: get("[data-radix-scroll-area-viewport]").clientHeight,
      scrollHeight: get("[data-radix-scroll-area-viewport]").scrollHeight,
      top: get("[data-radix-scroll-area-viewport]").scrollTop,
    },
    headerTransform: getComputedStyle(get(".template-header")).transform,
    publish: {
      fontSize: getComputedStyle(get(".template-publish")).fontSize,
      fontWeight: getComputedStyle(get(".template-publish")).fontWeight,
      background: getComputedStyle(get(".template-publish")).backgroundColor,
    },
    focused:
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.dataset.templateTarget,
  });
  window.templateAudit = {
    checks,
    state,
    async open(theme = "light") {
      if (document.documentElement.dataset.theme !== theme) {
        button("Theme: " + document.documentElement.dataset.theme).click();
        await wait(30);
      }
      button("Open reference template").click();
      await wait();
      const s = state();
      if (matchMedia("(prefers-reduced-motion: reduce)").matches)
        assert(
          get(".template-details").getAnimations().length === 0 &&
            get(".template-overlay").getAnimations().length === 0,
          "reduced motion omits modal and overlay animations"
        );
      assert(s.dialog.width === 400 && s.dialog.height === 540, "400 × 540 " + theme + " dialog");
      // Chromium rounds a 0.5px border up to a device pixel on a 1× display.
      const border = Math.max(0.5, 1 / devicePixelRatio);
      assert(s.card.width === 400 - 2 * border - 32, "full card width " + theme);
      assert(s.headerTransform.includes("-52"), "overview header is translated out " + theme);
      assert(
        get(".template-mark").closest(".template-page") === null,
        "avatar has its own scroll block " + theme
      );
      return s;
    },
    async context() {
      get("[data-template-target=context]").click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const outgoing = document.querySelector(".template-page.outgoing");
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      assert(
        reduced ? !outgoing : outgoing?.inert,
        "outgoing page inert or omitted for reduced motion"
      );
      const header = getComputedStyle(get(".template-header"));
      assert(
        reduced ? header.transitionProperty === "none" : header.transitionDuration === "0.2s",
        "header honors motion preference: " +
          header.transitionProperty +
          " " +
          header.transitionDuration
      );
      await wait();
      const s = state();
      assert(s.page === "context", "Context entered");
      assert(s.focused === "Back to template", "push focus reaches Back");
      assert(s.scroll.scrollHeight > s.scroll.height, "long Context can scroll");
      const second = get("[data-template-target=memory-1]");
      const divider = getComputedStyle(second, "::before");
      assert(
        divider.left === "8px" && divider.height === "0.5px",
        "memory divider is inset and hairline"
      );
      return s;
    },
    async fact(index = 0) {
      memoryIndex = index;
      const memoryTitle = get("[data-template-target=memory-" + index + "]").textContent;
      const viewport = get("[data-radix-scroll-area-viewport]");
      viewport.scrollTop = 35;
      await click("[data-template-target=memory-" + index + "]");
      const s = state();
      assert(s.page === "content", "memory detail entered");
      assert(
        s.scroll.top === 0 && s.scroll.scrollHeight <= s.scroll.height + 1,
        "detail resets scroll with no stale scrollbar"
      );
      assert(s.focused === "Back to context", "memory detail focus reaches Back");
      assert(s.title === memoryTitle, "full memory title retained for accessibility");
      return s;
    },
    async back() {
      await click('[aria-label="Back to context"]');
      assert(
        document.activeElement?.dataset.templateTarget === "memory-" + memoryIndex,
        "back restores source memory focus"
      );
      await click('[aria-label="Back to template"]');
      assert(
        document.activeElement?.dataset.templateTarget === "context",
        "back restores Context focus"
      );
      return state();
    },
    async rapid() {
      get("[data-template-target=context]").click();
      await wait(25);
      get("[data-template-target=memory-0]").click();
      await wait(25);
      get('[aria-label="Back to context"]').click();
      await wait(25);
      get('[aria-label="Back to template"]').click();
      await wait(320);
      assert(
        document.querySelectorAll(".template-page").length === 1,
        "interrupted transitions clean up outgoing panes"
      );
      assert(
        document.activeElement?.dataset.templateTarget === "context" &&
          !document.activeElement?.closest("[inert]"),
        "interrupted transitions restore active focus"
      );
      return state();
    },
    async close() {
      await click('[aria-label="Close template details"]');
      assert(!document.querySelector(".template-details"), "dialog closes");
    },
    async rich() {
      button("Open rich template").click();
      await wait();
      await click("[data-template-target=context]");
      assert(
        !!document.querySelector("[data-template-target=skill-0]"),
        "skills belong to Context"
      );
      await click("[data-template-target=skill-0]");
      assert(
        get(".template-page:not(.outgoing)").textContent.includes(
          "A fictional skill description."
        ) && get(".template-page:not(.outgoing)").textContent.includes("Always start"),
        "skill includes description and content"
      );
      await this.close();
      button("Open rich template").click();
      await wait();
      await click("[data-template-target=routines]");
      await click("[data-template-target=routine-0]");
      assert(
        get(".template-page:not(.outgoing)").textContent.includes("Summarize pending tasks."),
        "routine content retained"
      );
      await this.close();
      button("Open rich template").click();
      await wait();
      await click("[data-template-target=integrations]");
      assert(
        get(".template-page:not(.outgoing)").textContent.includes(
          "No credentials or external connection."
        ) && !document.querySelector("[data-template-target=plugin-0]"),
        "integrations remain informational"
      );
      await this.close();
    },
    async empty() {
      button("Open empty template").click();
      await wait();
      assert(!document.querySelector(".template-row"), "empty snapshot omits empty sections");
      return state();
    },
    async pending() {
      button("Pending action: off").click();
      button("Open reference template").click();
      await wait();
      assert(
        get(".template-publish").disabled && get(".template-publish").textContent === "Working…",
        "busy template action is disabled"
      );
      return state();
    },
    async narrow() {
      button("Open reference template").click();
      await wait();
      const s = state();
      assert(
        s.dialog.width <= innerWidth - 32 && s.dialog.height <= innerHeight - 40,
        "dialog fits narrow viewport"
      );
      return s;
    },
    motion() {
      return JSON.parse(get("[data-motion-traces]").textContent);
    },
  };
})();
