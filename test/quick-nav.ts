/**
 * Quick navigation test — connect to running Firefox and open pages.
 */
import { createProtocolClient } from "../src/browser/protocol.js";

async function main() {
  console.log("Connecting to Firefox...");
  const client = await createProtocolClient("ws://127.0.0.1:9222");
  console.log(`Connected via ${client.type}`);

  // Navigate existing context or create new
  const contexts = await client.getContexts();
  console.log(`Found ${contexts.length} contexts`);

  let ctxId: string;
  if (contexts.length > 0) {
    ctxId = contexts[0].id;
  } else {
    ctxId = await client.createContext();
  }

  console.log("Navigating to example.com...");
  await client.navigate(ctxId, "https://example.com", "complete");
  console.log("Done! Check the Firefox window.");

  // Don't disconnect — leave browser running
}

main().catch(console.error);
