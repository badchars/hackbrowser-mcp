/**
 * Demo: Container credential injection — browser stays open for inspection.
 *
 * Creates 2 containers:
 *   - Admin: cookie=admin-token, Authorization=Bearer admin-jwt
 *   - User:  cookie=user-token, Authorization=Bearer user-jwt
 *
 * Opens 2 tabs showing headers (to verify isolation).
 * Browser stays open for 5 minutes.
 */
import { launchFirefox, closeFirefox } from "../src/browser/launcher.js";
import { ContainerManager } from "../src/browser/container-manager.js";
import { NetworkInterceptor } from "../src/capture/network-interceptor.js";

async function main() {
  console.log("=== Credential Injection Demo ===\n");

  const result = await launchFirefox({ port: 9222 });
  console.log(`✓ Firefox running (PID: ${result.pid})\n`);

  const client = result.client;
  const mgr = new ContainerManager(client, 9221);
  await mgr.startExtensionServer();
  const interceptor = new NetworkInterceptor(client);

  // Give extension time to connect
  console.log("Waiting for extension to connect...");
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`Extension: ${mgr.extensionConnected ? "✓ connected" : "✗ not connected (containers still work via BiDi)"}\n`);

  try {
    // Create containers
    const [admin, user] = await mgr.createContainers([
      { name: "Admin", role: "admin", color: "blue" },
      { name: "User", role: "user", color: "green" },
    ]);

    // Set cookies
    await mgr.setCookies(admin.id, [
      { name: "session", value: "admin-token-12345", domain: "httpbin.org" },
    ]);
    await mgr.setCookies(user.id, [
      { name: "session", value: "user-token-67890", domain: "httpbin.org" },
    ]);

    // Set custom headers
    await mgr.setHeaderOverrides(admin.id, {
      Authorization: "Bearer admin-jwt-AAAA",
      "X-Role": "administrator",
    });
    await mgr.setHeaderOverrides(user.id, {
      Authorization: "Bearer user-jwt-BBBB",
      "X-Role": "regular-user",
    });

    // Create tabs with interception + header injection
    const tab1 = await mgr.createTab(admin.id);
    const tab2 = await mgr.createTab(user.id);

    interceptor.mapContextToContainer(tab1, admin.id);
    interceptor.mapContextToContainer(tab2, user.id);
    await interceptor.enableForContext(tab1);
    await interceptor.enableForContext(tab2);
    await mgr.enableHeaderInjection(tab1);
    await mgr.enableHeaderInjection(tab2);

    // Navigate both to headers endpoint
    await client.navigate(tab1, "https://httpbin.org/headers", "complete");
    await client.navigate(tab2, "https://httpbin.org/headers", "complete");

    console.log("✓ 2 containers created with isolated credentials");
    console.log("✓ Tab 1 (Admin): httpbin.org/headers — check Authorization header");
    console.log("✓ Tab 2 (User):  httpbin.org/headers — check Authorization header\n");
    console.log("Browser is open — check the two tabs!\n");
    console.log("Press Ctrl+C to close.\n");

    // Stay open until Ctrl+C
    await new Promise((resolve) => {
      process.on("SIGINT", resolve);
      // Also timeout after 5 minutes
      setTimeout(resolve, 5 * 60 * 1000);
    });

    await mgr.removeContainers();
  } catch (err) {
    console.error("✗ Error:", (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    interceptor.destroy();
    await closeFirefox(result);
    console.log("\nClosed.");
  }
}

main();
