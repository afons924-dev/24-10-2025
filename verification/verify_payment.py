import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        try:
            # Go to the home page first
            await page.goto("http://localhost:8000")

            # Click the age gate
            await page.click("#age-gate-enter")

            # Now navigate to the account page
            await page.goto("http://localhost:8000/#/account")

            # Give it a moment to render
            await page.wait_for_timeout(2000)

            # Check for the success modal
            await page.wait_for_selector("#purchase-success-modal", state="visible")

            print("Verification successful: Success modal is visible.")
            await page.screenshot(path="verification/payment_success.png")

        except Exception as e:
            print(f"An error occurred: {e}")
            await page.screenshot(path="verification/payment_error.png")

        finally:
            await browser.close()

asyncio.run(main())
