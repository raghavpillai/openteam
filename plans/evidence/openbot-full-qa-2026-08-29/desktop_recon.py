from pathlib import Path

from playwright.sync_api import sync_playwright


ARTIFACTS = Path(__file__).parent


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 960}, device_scale_factor=1)
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[str] = []
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
    page.screenshot(path=ARTIFACTS / "desktop-live-light.png", full_page=True)

    print(f"TITLE={page.title()}")
    print(f"URL={page.url}")
    print(f"CONSOLE_ERRORS={console_errors}")
    print(f"PAGE_ERRORS={page_errors}")
    print(f"FAILED_REQUESTS={failed_requests}")
    page.get_by_role("button", name="Search", exact=True).click()
    page.wait_for_timeout(250)
    print(
        "SEARCH_INPUTS="
        + str(page.locator("input, textarea, [contenteditable=true]").evaluate_all(
            "nodes => nodes.map(node => node.outerHTML)"
        ))
    )
    print("SEARCH_BODY=" + page.locator("body").inner_text()[-800:])
    page.get_by_role("dialog").press("Escape")
    page.wait_for_timeout(150)
    print(f"DIALOG_AFTER_ESCAPE={page.get_by_role('dialog').count()}")
    if page.get_by_role("dialog").count():
        print(f"DIALOG_VISIBLE_AFTER_ESCAPE={page.get_by_role('dialog').is_visible()}")
        print(
            "DIALOG_HTML_AFTER_ESCAPE="
            + page.get_by_role("dialog").evaluate("node => node.outerHTML.slice(0, 500)")
        )
    browser.close()
