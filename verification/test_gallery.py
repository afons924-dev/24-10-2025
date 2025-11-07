
from playwright.sync_api import sync_playwright
import time

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    try:
        # Add a short delay to allow the server to start
        time.sleep(2)

        page.goto("http://localhost:8000")

        # Click the age gate enter button
        page.locator("#age-gate-enter").click()

        # Click the cookie accept button
        page.locator("#cookie-accept-btn").click()

        # Wait for the loading overlay to disappear
        page.wait_for_selector("#loading-overlay", state="hidden")

        # Click the first product card to navigate to the detail page
        page.locator('.product-card a').first.click()

        page.wait_for_url("**/#/product-detail?id=**")

        # Check that the main image is visible
        main_image = page.locator("#main-product-image")
        assert main_image.is_visible(), "Main product image is not visible"

        # Check that the thumbnails are visible
        thumbnails = page.locator("#product-thumbnails img")
        assert thumbnails.count() > 0, "Product thumbnails are not visible"

        print("Test passed: Product gallery is visible and functioning correctly.")

    except Exception as e:
        print(f"Test failed: {e}")
        page.screenshot(path="verification/error.png")

    finally:
        browser.close()

with sync_playwright() as playwright:
    run(playwright)
