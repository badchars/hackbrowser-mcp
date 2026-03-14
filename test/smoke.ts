/**
 * Smoke test: Launch Firefox, navigate, take screenshot, capture network.
 */

import { launchFirefox, closeFirefox } from "../src/browser/launcher.js";
import { BrowserInteraction } from "../src/browser/interaction.js";
import { NetworkInterceptor } from "../src/capture/network-interceptor.js";
import { buildHar } from "../src/capture/har-builder.js";
import { saveHar } from "../src/capture/har-storage.js";

async function main() {
  console.log("=== HackBrowser Smoke Test ===\n");

  // 1. Launch Firefox
  console.log("1. Launching Firefox...");
  const result = await launchFirefox({ port: 9222 });
  console.log(`   ✓ Connected via ${result.client.type}, PID: ${result.pid}`);

  const client = result.client;
  const interaction = new BrowserInteraction(client);
  const interceptor = new NetworkInterceptor(client);

  try {
    // 2. Create a browsing context
    console.log("\n2. Creating browsing context...");
    const ctxId = await client.createContext();
    console.log(`   ✓ Context: ${ctxId}`);

    // 3. Enable network interception
    console.log("\n3. Enabling network interception...");
    interceptor.mapContextToContainer(ctxId, "test-container");
    await interceptor.enableForContext(ctxId);
    console.log("   ✓ Network interception enabled");

    // 4. Navigate to a page
    console.log("\n4. Navigating to example.com...");
    const url = await client.navigate(ctxId, "https://example.com", "complete");
    console.log(`   ✓ Navigated to: ${url}`);

    // Wait a moment for network events
    await new Promise((r) => setTimeout(r, 2000));

    // 5. Get page title
    console.log("\n5. Evaluating JS...");
    const title = await client.evaluate(ctxId, "document.title");
    console.log(`   ✓ Page title: ${title}`);

    // 6. Take screenshot
    console.log("\n6. Taking screenshot...");
    const screenshot = await client.captureScreenshot(ctxId);
    const screenshotSize = Buffer.from(screenshot, "base64").byteLength;
    console.log(`   ✓ Screenshot: ${(screenshotSize / 1024).toFixed(1)} KB`);

    // Save screenshot
    await Bun.write("test/screenshot.png", Buffer.from(screenshot, "base64"));
    console.log("   ✓ Saved to test/screenshot.png");

    // 7. Get DOM tree
    console.log("\n7. Getting DOM tree...");
    const tree = await interaction.getDomTree(ctxId);
    console.log(`   ✓ DOM tree: ${tree.length} chars`);
    console.log("   Preview:", tree.slice(0, 200));

    // 8. Check captured requests
    console.log("\n8. Captured requests...");
    const requests = interceptor.getRequests();
    console.log(`   ✓ ${requests.length} requests captured`);
    for (const req of requests.slice(0, 5)) {
      console.log(`     ${req.method} ${req.url} → ${req.status}`);
    }

    // 9. Build and save HAR
    if (requests.length > 0) {
      console.log("\n9. Building HAR...");
      const har = buildHar(requests, "Firefox 137.0");
      await saveHar(har, "test/capture.har");
      console.log(`   ✓ HAR saved with ${har.log.entries.length} entries`);
    }

    // 10. Test user contexts (containers)
    console.log("\n10. Testing user contexts (containers)...");
    try {
      const ucId = await client.createUserContext();
      console.log(`   ✓ Created user context: ${ucId}`);
      const contexts = await client.getUserContexts();
      console.log(`   ✓ User contexts: ${JSON.stringify(contexts)}`);
      await client.removeUserContext(ucId);
      console.log("   ✓ Removed user context");
    } catch (err) {
      console.log(`   ✗ User contexts not supported: ${(err as Error).message}`);
    }

    // 11. Navigate to a second page
    console.log("\n11. Navigating to httpbin.org...");
    try {
      await client.navigate(ctxId, "https://httpbin.org/headers", "complete");
      await new Promise((r) => setTimeout(r, 2000));
      const headersJson = await client.evaluate(ctxId, "document.body.innerText");
      console.log(`   ✓ httpbin response (first 200 chars): ${String(headersJson).slice(0, 200)}`);
    } catch (err) {
      console.log(`   ✗ httpbin navigation failed: ${(err as Error).message}`);
    }

    // Final request count
    const finalRequests = interceptor.getRequests();
    console.log(`\n   Total captured: ${finalRequests.length} requests`);

    console.log("\n=== All tests passed! ===");
  } catch (err) {
    console.error("\n✗ Test failed:", (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    interceptor.destroy();
    await closeFirefox(result);
    console.log("Done.");
  }
}

main();
