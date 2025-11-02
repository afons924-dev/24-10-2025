
import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # Listen for all console events and print them
        page.on("console", lambda msg: print(f"Browser console: {msg.text}"))

        try:
            await page.goto("http://localhost:8000")

            # Click the age gate confirmation
            await page.click("#age-gate-enter")

            # 1. Verify Search Icon Functionality
            print("Verifying Search Icon...")

            # Check initial state: overlay is hidden
            search_overlay = page.locator("#search-overlay")
            await expect(search_overlay).to_be_hidden()

            # Click the search icon
            await page.click("#search-icon")

            # Check for visibility and focus
            await expect(search_overlay).to_be_visible()
            await expect(page.locator("#search-input")).to_be_focused()
            print("Search overlay opened and input is focused.")

            # Type into search and check suggestions
            await page.fill("#search-input", "Vibrador")
            await page.wait_for_selector("#search-suggestions .search-suggestion-item")
            suggestions = page.locator("#search-suggestions")
            await expect(suggestions).to_be_visible()
            await expect(suggestions.locator("a")).to_have_count(6)
            print("Search suggestions appeared correctly.")

            # Click close button
            await page.click("#close-search-btn")
            await expect(search_overlay).to_be_hidden()
            print("Search overlay closed successfully.")

            # 2. Verify Post-Purchase Redirect (Simulated)
            # This is a simplified simulation. A full test would require a mock Stripe checkout.
            print("\nVerifying Post-Purchase Redirect...")

            # We will navigate to a simulated success URL and check the final destination
            # The app logic in handlePostPayment should redirect to /account?tab=orders
            await page.goto("http://localhost:8000/#/checkout?payment_intent_client_secret=test_secret_succeeded")

            # Wait for the navigation to the account page
            await page.wait_for_url("**/#/account?tab=orders", timeout=10000)

            # Verify the final URL and content
            final_url = page.url
            print(f"Redirected to: {final_url}")
            assert "#/account?tab=orders" in final_url

            await expect(page.locator("#order-history-list")).to_be_visible()
            print("Successfully redirected to the orders tab in the account page.")

            print("\n✅ All verifications passed!")

        except Exception as e:
            print(f"❌ Verification failed: {e}")
            await page.screenshot(path="verification_failure.png")
            print("Screenshot saved to verification_failure.png")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
