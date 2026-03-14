/**
 * Interactive demo — launches Firefox, navigates, keeps browser open for 60 seconds.
 */
import { launchFirefox, closeFirefox } from "../src/browser/launcher.js";
import { BrowserInteraction } from "../src/browser/interaction.js";

async function main() {
  console.log("Launching Firefox...");
  const result = await launchFirefox({ port: 9222 });
  console.log(`Connected via ${result.client.type}`);

  const client = result.client;
  const interaction = new BrowserInteraction(client);

  // Create a tab and navigate
  const ctxId = await client.createContext();
  console.log("Navigating to example.com...");
  await client.navigate(ctxId, "https://example.com", "complete");

  const title = await client.evaluate(ctxId, "document.title");
  console.log(`Page title: ${title}`);

  console.log("\n🔥 Firefox is open! You should see the browser window.");
  console.log("Keeping browser open for 60 seconds...\n");

  // Navigate to a more interesting page after 5 seconds
  await new Promise((r) => setTimeout(r, 5000));
  console.log("Navigating to httpbin.org/html...");
  await client.navigate(ctxId, "https://httpbin.org/html", "complete");

  // Wait 55 more seconds so user can see
  await new Promise((r) => setTimeout(r, 55000));

  console.log("Closing Firefox...");
  await closeFirefox(result);
  console.log("Done!");
}

main().catch(console.error);
