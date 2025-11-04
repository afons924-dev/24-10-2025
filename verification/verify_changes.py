
import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        try:
            await page.goto("http://localhost:8000")

            # Click the age gate confirmation
            await page.click("#age-gate-enter")

            # Open the search bar
            await page.click("#search-icon")

            # Fill the search input
            await page.fill("#search-input", "Vibrador")

            # Wait for search suggestions to be visible and click the first one
            await page.wait_for_selector(".search-suggestion-item")
            await page.click(".search-suggestion-item")

            # Check if the search overlay is hidden
            await expect(page.locator("#search-overlay")).to_be_hidden()

            print("Verification successful: Search overlay closes after item selection.")

        except Exception as e:
            print(f"Verification failed: {e}")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
