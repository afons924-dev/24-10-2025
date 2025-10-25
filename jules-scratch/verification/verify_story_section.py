from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch()
    page = browser.new_page()
    page.goto("http://localhost:8000")
    page.wait_for_selector("#age-gate-enter", state="visible")
    page.click("#age-gate-enter")
    page.locator("text=A Nossa História").scroll_into_view_if_needed()
    page.screenshot(path="jules-scratch/verification/story_section.png")
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
