import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 720}
        )
        page = await context.new_page()

        try:
            # Navigate to the website
            await page.goto('http://localhost:8000', wait_until='domcontentloaded')

            # Handle the age gate
            await page.wait_for_selector('#age-gate-modal', state='visible', timeout=10000)
            await page.click('#age-gate-enter')
            await page.wait_for_selector('#age-gate-modal', state='hidden')

            # Navigate to the account page where the modal should appear
            await page.goto('http://localhost:8000/#/account?tab=orders', wait_until='domcontentloaded')

            # Wait for a generous amount of time for the app to initialize
            await asyncio.sleep(5)

            # Manually trigger the success modal for verification
            await page.evaluate('() => { window.app.showPurchaseSuccessModal(); }')

            # Wait for the modal to be visible and take a screenshot
            await page.wait_for_selector('#purchase-success-modal', state='visible')
            await page.screenshot(path='purchase_success_modal.png')
            print("Screenshot of the purchase success modal has been taken.")

        except Exception as e:
            print(f"An error occurred: {e}")

        finally:
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
