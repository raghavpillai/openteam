import re
from pathlib import Path

from playwright.sync_api import sync_playwright


ARTIFACTS = Path(__file__).parent
UPLOAD_FIXTURE = Path("plans/evidence/openbot-ios/live-computer-light.png").resolve()


def check(condition: bool, label: str, results: list[dict[str, str]]) -> None:
    if not condition:
        raise AssertionError(label)
    results.append({"check": label, "status": "pass"})


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 960}, device_scale_factor=1)
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[str] = []
    results: list[dict[str, str]] = []

    page.on(
        "console",
        lambda message: console_errors.append(message.text) if message.type == "error" else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "requestfailed",
        lambda request: failed_requests.append(
            f"{request.method} {request.url}: {request.failure}"
        ),
    )

    page.goto("http://127.0.0.1:5173")
    page.wait_for_load_state("networkidle")
    check(page.title() == "OpenBot", "desktop shell loads", results)
    check("Connecting to OpenBot" not in page.locator("body").inner_text(), "no connection gate", results)
    check(page.get_by_role("button", name="Search", exact=True).is_visible(), "search is visible", results)

    page.get_by_role("button", name="Search", exact=True).click()
    search = page.get_by_role("combobox", name="Search")
    search.fill("probe 2330")
    page.wait_for_timeout(450)
    check(page.get_by_text("A2A UI Probe 2330", exact=True).count() > 0, "search finds conversations", results)
    search.fill("zzzz-no-openbot-result")
    page.wait_for_timeout(450)
    check(page.get_by_text(re.compile("No results", re.IGNORECASE)).count() > 0, "search empty state", results)
    page.screenshot(path=ARTIFACTS / "desktop-search-empty.png", full_page=True)
    page.get_by_role("dialog").press("Escape")
    page.get_by_role("dialog").wait_for(state="detached")
    check(page.get_by_role("dialog").count() == 0, "search closes with Escape", results)

    page.locator("[data-channel-id]").filter(has_text="iOS QA smoke").get_by_role(
        "button"
    ).click()
    page.wait_for_timeout(350)
    latest_agent_copy = "iOS QA smoke from the screenshot"
    row = page.locator("[data-message-id]:visible").filter(has_text=latest_agent_copy).last
    check(row.count() == 1, "live direct conversation renders", results)
    row.hover()
    check(row.get_by_role("button", name="React to message").is_visible(), "hover reaction action", results)
    check(row.get_by_role("button", name="Reply").is_visible(), "hover reply action", results)
    check(row.get_by_role("button", name="More message actions").is_visible(), "hover overflow action", results)
    page.screenshot(path=ARTIFACTS / "desktop-message-hover.png", full_page=True)

    row.get_by_role("button", name="Reply").click()
    check(page.get_by_role("button", name="Cancel reply").is_visible(), "reply tray opens", results)
    page.screenshot(path=ARTIFACTS / "desktop-reply-open.png", full_page=True)
    page.get_by_role("button", name="Cancel reply").click()
    check(page.get_by_role("button", name="Cancel reply").count() == 0, "reply tray closes", results)

    row.click(button="right")
    check(page.get_by_role("menuitem", name="Reply").is_visible(), "context menu reply", results)
    check(page.get_by_role("menuitem", name="Copy", exact=True).is_visible(), "context menu copy", results)
    check(
        page.locator('[aria-label="Open emoji picker"]:visible').is_visible(),
        "context menu emoji expansion",
        results,
    )
    page.screenshot(path=ARTIFACTS / "desktop-context-menu.png", full_page=True)
    page.keyboard.press("Escape")

    row.hover()
    row.get_by_role("button", name="React to message").click()
    check(page.get_by_role("button", name="Open emoji picker").is_visible(), "quick reaction menu", results)
    page.get_by_role("button", name="Open emoji picker").click()
    emoji_search = page.get_by_role("textbox", name="Search emoji")
    emoji_search.fill("celebrate")
    page.wait_for_timeout(150)
    check(page.get_by_role("button", name=re.compile("React with")).count() > 0, "emoji search returns results", results)
    page.screenshot(path=ARTIFACTS / "desktop-emoji-search.png", full_page=True)
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")

    add_attachment = page.get_by_role("button", name="Add attachment")
    add_attachment.click()
    with page.expect_file_chooser() as chooser_info:
        page.get_by_role("menuitem", name="Attach files").click()
    chooser_info.value.set_files(str(UPLOAD_FIXTURE))
    remove_upload = page.get_by_role("button", name=re.compile(r"^Remove "))
    remove_upload.wait_for(state="visible")
    check(remove_upload.is_visible(), "attachment preview renders", results)
    page.screenshot(path=ARTIFACTS / "desktop-attachment-preview.png", full_page=True)
    remove_upload.click()
    check(page.get_by_role("button", name=re.compile(r"^Remove ")).count() == 0, "attachment removal", results)

    page.emulate_media(color_scheme="dark")
    page.reload()
    page.wait_for_load_state("networkidle")
    dark_applied = page.evaluate(
        """() => ({
          media: matchMedia('(prefers-color-scheme: dark)').matches,
          background: getComputedStyle(document.body).backgroundColor,
          foreground: getComputedStyle(document.body).color,
        })"""
    )
    check(
        bool(dark_applied["media"])
        and dark_applied["background"] == "rgb(7, 7, 7)"
        and dark_applied["foreground"] == "rgb(252, 252, 252)",
        "desktop dark mode follows the system",
        results,
    )
    page.screenshot(path=ARTIFACTS / "desktop-live-dark.png", full_page=True)

    check(not console_errors, "no browser console errors", results)
    check(not page_errors, "no uncaught browser exceptions", results)
    check(not failed_requests, "no failed browser requests", results)

    for result in results:
        print(f"PASS {result['check']}")
    print(f"CONSOLE_ERRORS={console_errors}")
    print(f"PAGE_ERRORS={page_errors}")
    print(f"FAILED_REQUESTS={failed_requests}")
    browser.close()
