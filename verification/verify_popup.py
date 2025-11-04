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

            # Wait for app to be ready
            await page.wait_for_function("() => window.app")

            # Temporarily modify the initAccountPage to show the modal
            await page.evaluate("() => { window.app.original_initAccountPage = window.app.initAccountPage; window.app.initAccountPage = () => { window.app.showPurchaseSuccessModal(); }; }")

            # Now navigate to the account page
            await page.goto("http://localhost:8000/#/account")

            # Wait for the success modal to be visible
            await page.wait_for_selector("#purchase-success-modal", state="visible")

            print("Verification successful: Success modal is visible.")
            await page.screenshot(path="verification/popup_verification.png")

        except Exception as e:
            print(f"An error occurred: {e}")
            await page.screenshot(path="verification/popup_error.png")

        finally:
            # Restore the original function
            await page.evaluate("() => { if(window.app && window.app.original_initAccountPage) window.app.initAccountPage = window.app.original_initAccountPage; }")
            await browser.close()

asyncio.run(main())
