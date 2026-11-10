const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.PANEL_TEST_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1040,
    height: 760,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (fn) => win.webContents.executeJavaScript("(" + fn.toString() + ")()");
  try {
    await win.loadURL(process.env.PANEL_TEST_URL + "?fail=1");
    await run(async () => {
      const check = (value, message) => {
        if (!value) throw new Error(message);
      };
      const waitFor = async (fn, message) => {
        const deadline = performance.now() + 5000;
        while (!fn() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 30));
        check(fn(), message);
      };
      const button = (name) =>
        [...document.querySelectorAll("button")].find(
          (e) => e.ariaLabel === name || e.textContent.trim() === name
        );
      const input = () => document.querySelector('input[aria-label="Search"]');
      const dialog = () => document.querySelector('[role="dialog"]');
      const state = () => JSON.parse(document.querySelector("#fixture-state").textContent);
      const key = (el, value, metaKey = false) =>
        el.dispatchEvent(new KeyboardEvent("keydown", { key: value, metaKey, bubbles: true }));
      const fill = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await waitFor(() => button("Search"), "Sidebar mounts");
      const draft = document.querySelector('[aria-label="Message draft"]');
      draft.focus();
      button("Search").click();
      await waitFor(
        () => document.querySelectorAll('[role="option"]').length === 4,
        "Default results load"
      );
      check(
        dialog().getBoundingClientRect().width === 642 &&
          dialog().getBoundingClientRect().height === 562,
        "Search matches the reference dimensions"
      );
      check(
        getComputedStyle(input()).fontSize === "22px",
        "Search input matches 22px reference type"
      );
      check(
        [...document.querySelectorAll("[data-search-section]")].map((e) => e.textContent).join() ===
          "Bots,Chats",
        "Search groups Bots and existing Chats"
      );
      check(
        document.querySelector('[role="option"]').getBoundingClientRect().height === 56,
        "Search rows are 56px tall"
      );
      check(
        input().getBoundingClientRect().left === 258 &&
          input().getBoundingClientRect().width === 572 &&
          getComputedStyle(input()).fontWeight === "425" &&
          getComputedStyle(input()).letterSpacing === "0.22px",
        "Search input inset and typography match the measured reference"
      );
      check(
        getComputedStyle(document.querySelector('[role="option"]')).backgroundColor ===
          "rgba(28, 28, 28, 0.08)",
        "Selected search rows use the reference's 8% fill"
      );
      key(input(), "ArrowUp");
      await waitFor(
        () => input().getAttribute("aria-activedescendant") === "search-result-0",
        "Up stays at the first result without selecting headings"
      );
      key(input(), "Enter");
      await waitFor(() => !dialog(), "Selecting a Chat closes search");
      check(state().selected === "channel-0", "Grouped keyboard selection opens the correct Bot");
      button("Search").click();
      await waitFor(input, "Search reopens");
      check(input().value === "", "Reopening resets the query");
      fill(input(), "settings");
      await waitFor(
        () => document.querySelector('[data-search-section="Settings"]'),
        "Settings group loads"
      );
      key(input(), "2", true);
      await waitFor(() => !dialog(), "Command+number selects a result");
      check(Boolean(state().action), "A settings action runs");
      draft.focus();
      button("Search").click();
      await waitFor(input, "Search opens for dismissal");
      key(input(), "Escape");
      await waitFor(() => !dialog(), "Escape closes search");
      check(document.activeElement === draft, "Escape restores caller focus");
      button("New Bot").click();
      await waitFor(
        () => document.querySelector('input[aria-label="Bot name"]'),
        "Plus opens Create New Bot"
      );
      const name = () => document.querySelector('input[aria-label="Bot name"]');
      check(
        dialog().getBoundingClientRect().width === 440,
        "Create dialog matches reference width"
      );
      check(
        dialog().getBoundingClientRect().height === 582,
        "Create dialog matches reference height"
      );
      const preview = dialog().querySelector('[aria-label="Bot preview"]');
      const previewBox = preview.getBoundingClientRect();
      const glyphBox = preview.querySelector("svg").getBoundingClientRect();
      check(
        previewBox.height === 96 &&
          Math.abs(glyphBox.top + glyphBox.height / 2 - previewBox.top - 48) < 0.1,
        "Preview artwork stays centered in the reference's 96px slot"
      );
      check(
        name().getBoundingClientRect().top === 273 &&
          getComputedStyle(name()).marginTop === "4px" &&
          getComputedStyle(name()).marginBottom === "4px" &&
          getComputedStyle(name()).lineHeight === "18px" &&
          getComputedStyle(name()).fontWeight === "425",
        "Name field spacing and type match the reference without preview overlap"
      );
      check(
        dialog().querySelector('[aria-label="Character shape"]').getBoundingClientRect().top ===
          325 &&
          dialog().querySelector('[aria-label="Character color"]').getBoundingClientRect().top ===
            509 &&
          dialog().querySelector('[aria-label="Character shape"] svg').getBoundingClientRect()
            .width === 46,
        "Picker groups and visible artwork retain the measured scale and padding"
      );
      check(
        draft === document.querySelector('[aria-label="Message draft"]'),
        "Opening creation preserves the current chat tree"
      );
      check(
        !dialog().textContent.includes("group") &&
          !document.querySelector('[aria-label="Chat recipients"]'),
        "No manual group creation flow"
      );
      check(button("Create").disabled, "Empty Bot names cannot be submitted");
      fill(name(), "   ");
      await new Promise((r) => setTimeout(r, 30));
      check(button("Create").disabled, "Whitespace names cannot be submitted");
      fill(name(), "  Release helper  ");
      button("Pod character shape").click();
      button("blue character color").click();
      const form = dialog().querySelector("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(
        () => document.querySelector('[role="alert"]'),
        "Creation errors stay in the dialog"
      );
      check(state().attempts.length === 1, "Duplicate submissions make one request");
      check(name().value.trim() === "Release helper", "Failure retains the name");
      check(
        button("Pod character shape").getAttribute("aria-pressed") === "true",
        "Failure retains the shape"
      );
      button("Create").click();
      await waitFor(() => !dialog(), "Successful retry closes creation");
      check(
        state().attempts.length === 2 &&
          state().attempts[0].clientRequestId === state().attempts[1].clientRequestId,
        "Retry preserves the idempotency key"
      );
      check(
        state().created.name === "Release helper" &&
          state().created.icon === "pod" &&
          state().created.color === "#1e86fc",
        "Chosen name, shape, and color reach creation"
      );
      check(
        draft.textContent === "An unfinished draft stays here.",
        "Creation preserves the current draft"
      );
      button("New Bot").click();
      await waitFor(name, "Creation reopens");
      check(name().value === "" && button("Create").disabled, "A new dialog starts fresh");
      button("Cancel").click();
      await waitFor(() => !dialog(), "Cancel dismisses creation");
    });
    // Both panels remain usable at narrow sizes and in the dark theme.
    win.setContentSize(360, 420);
    await run(async () => {
      document.documentElement.dataset.theme = "dark";
      const wait = () => new Promise((r) => setTimeout(r, 250));
      document.querySelector('button[aria-label="New Bot"]').click();
      await wait();
      const dialog = document.querySelector('[role="dialog"]');
      const bounds = dialog.getBoundingClientRect();
      if (
        getComputedStyle(dialog).backgroundColor !== "rgb(31, 31, 31)" ||
        getComputedStyle(dialog).color !== "rgb(245, 245, 245)"
      )
        throw new Error("Dark panel colors match the reference");
      if (
        bounds.left < 15 ||
        bounds.right > innerWidth - 15 ||
        bounds.top < 15 ||
        bounds.bottom > innerHeight - 15
      )
        throw new Error("Creation fits a narrow window");
      const create = [...dialog.querySelectorAll("button")].find(
        (e) => e.textContent.trim() === "Create"
      );
      if (create.getBoundingClientRect().bottom > bounds.bottom)
        throw new Error("Creation footer stays reachable");
      [...dialog.querySelectorAll("button")].find((e) => e.textContent === "Cancel").click();
      await wait();
      document.querySelector('button[aria-label="Search"]').click();
      await wait();
      const search = document.querySelector('[role="dialog"]').getBoundingClientRect();
      if (
        search.left < 15 ||
        search.right > innerWidth - 15 ||
        search.top < 15 ||
        search.bottom > innerHeight - 15
      )
        throw new Error("Search fits a narrow window");
      document
        .querySelector('input[aria-label="Search"]')
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait();
    });
    fs.writeFileSync(
      path.join(process.env.PANEL_TEST_DIR, "results.json"),
      JSON.stringify({
        passed: true,
        scenarios: [
          "grouped search and keyboard navigation",
          "modal geometry",
          "creation validation, avatar selection, retry and duplicate protection",
          "draft preservation",
          "narrow dark panels",
        ],
      })
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(process.env.PANEL_TEST_DIR, "results.json"),
      JSON.stringify({ error: error.message, stack: error.stack })
    );
  } finally {
    app.quit();
  }
});
