
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

            # Wait for search suggestions to be visible
            await expect(page.locator("#search-suggestions")).to_be_visible()

            # Take a screenshot of the search bar with suggestions
            await page.screenshot(path="verification/search_verification.png")

            print("Verification successful: Screenshot taken.")

        except Exception as e:
            print(f"Verification failed: {e}")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
