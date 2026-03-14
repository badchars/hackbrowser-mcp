/**
 * Container credential injection test:
 * 1. Launch Firefox
 * 2. Create 2 containers (admin, user) via BiDi
 * 3. Set cookies per container
 * 4. Set custom Authorization headers per container
 * 5. Navigate both to httpbin.org/cookies and /headers
 * 6. Verify isolation (each sees only its own credentials)
 */
import { launchFirefox, closeFirefox } from "../src/browser/launcher.js";
import { ContainerManager } from "../src/browser/container-manager.js";
import { NetworkInterceptor } from "../src/capture/network-interceptor.js";

async function main() {
  console.log("=== Container Credential Injection Test ===\n");

  // 1. Launch Firefox
  console.log("1. Launching Firefox...");
  const result = await launchFirefox({ port: 9222 });
  console.log(`   ✓ Connected via ${result.client.type}, PID: ${result.pid}`);

  const client = result.client;
  const mgr = new ContainerManager(client);
  const interceptor = new NetworkInterceptor(client);

  try {
    // 2. Create containers
    console.log("\n2. Creating containers...");
    const [admin, user] = await mgr.createContainers([
      { name: "Admin", role: "admin", color: "blue" },
      { name: "Regular User", role: "user", color: "green" },
    ]);
    console.log(`   ✓ Admin: ${admin.cookieStoreId}`);
    console.log(`   ✓ User: ${user.cookieStoreId}`);

    // 3. Set cookies per container
    console.log("\n3. Setting cookies...");
    await mgr.setCookies(admin.id, [
      { name: "session", value: "admin-token-12345", domain: "httpbin.org" },
    ]);
    await mgr.setCookies(user.id, [
      { name: "session", value: "user-token-67890", domain: "httpbin.org" },
    ]);
    console.log("   ✓ Admin cookie: session=admin-token-12345");
    console.log("   ✓ User cookie: session=user-token-67890");

    // 4. Set Authorization headers per container
    console.log("\n4. Setting header overrides...");
    await mgr.setHeaderOverrides(admin.id, {
      Authorization: "Bearer admin-jwt-AAAA",
      "X-Custom-Role": "administrator",
    });
    await mgr.setHeaderOverrides(user.id, {
      Authorization: "Bearer user-jwt-BBBB",
      "X-Custom-Role": "regular-user",
    });
    console.log("   ✓ Admin: Authorization=Bearer admin-jwt-AAAA, X-Custom-Role=administrator");
    console.log("   ✓ User: Authorization=Bearer user-jwt-BBBB, X-Custom-Role=regular-user");

    // 5. Create tabs and enable interception + header injection
    console.log("\n5. Creating tabs with header injection...");
    const tab1 = await mgr.createTab(admin.id);
    const tab2 = await mgr.createTab(user.id);

    interceptor.mapContextToContainer(tab1, admin.id);
    interceptor.mapContextToContainer(tab2, user.id);
    await interceptor.enableForContext(tab1);
    await interceptor.enableForContext(tab2);
    await mgr.enableHeaderInjection(tab1);
    await mgr.enableHeaderInjection(tab2);
    console.log(`   ✓ Admin tab: ${tab1}`);
    console.log(`   ✓ User tab: ${tab2}`);

    // 6. Navigate to cookie endpoint
    console.log("\n6. Navigating to httpbin.org/cookies...");
    await client.navigate(tab1, "https://httpbin.org/cookies", "complete");
    await client.navigate(tab2, "https://httpbin.org/cookies", "complete");
    await new Promise((r) => setTimeout(r, 2000));

    // 7. Read cookie responses
    console.log("\n7. Cookie isolation check:");
    const cookieBody1 = String(await client.evaluate(tab1, "document.body.innerText"));
    const cookieBody2 = String(await client.evaluate(tab2, "document.body.innerText"));

    const adminHasAdmin = cookieBody1.includes("admin-token-12345");
    const adminHasUser = cookieBody1.includes("user-token-67890");
    const userHasUser = cookieBody2.includes("user-token-67890");
    const userHasAdmin = cookieBody2.includes("admin-token-12345");

    console.log(`   Admin sees admin cookie: ${adminHasAdmin ? "✓" : "✗"}`);
    console.log(`   User sees user cookie:   ${userHasUser ? "✓" : "✗"}`);
    console.log(`   Admin sees user cookie:  ${adminHasUser ? "✗ (LEAK!)" : "✓ (isolated)"}`);
    console.log(`   User sees admin cookie:  ${userHasAdmin ? "✗ (LEAK!)" : "✓ (isolated)"}`);

    // 8. Navigate to headers endpoint (to verify header injection)
    console.log("\n8. Navigating to httpbin.org/headers...");
    await client.navigate(tab1, "https://httpbin.org/headers", "complete");
    await client.navigate(tab2, "https://httpbin.org/headers", "complete");
    await new Promise((r) => setTimeout(r, 2000));

    // 9. Read header responses
    console.log("\n9. Header injection check:");
    const headerBody1 = String(await client.evaluate(tab1, "document.body.innerText"));
    const headerBody2 = String(await client.evaluate(tab2, "document.body.innerText"));

    const adminHasAdminJwt = headerBody1.includes("admin-jwt-AAAA");
    const adminHasAdminRole = headerBody1.includes("administrator");
    const userHasUserJwt = headerBody2.includes("user-jwt-BBBB");
    const userHasUserRole = headerBody2.includes("regular-user");
    const adminHasUserJwt = headerBody1.includes("user-jwt-BBBB");
    const userHasAdminJwt = headerBody2.includes("admin-jwt-AAAA");

    console.log(`   Admin has admin JWT:     ${adminHasAdminJwt ? "✓" : "✗"}`);
    console.log(`   Admin has admin role:    ${adminHasAdminRole ? "✓" : "✗"}`);
    console.log(`   User has user JWT:       ${userHasUserJwt ? "✓" : "✗"}`);
    console.log(`   User has user role:      ${userHasUserRole ? "✓" : "✗"}`);
    console.log(`   Admin has user JWT:      ${adminHasUserJwt ? "✗ (LEAK!)" : "✓ (isolated)"}`);
    console.log(`   User has admin JWT:      ${userHasAdminJwt ? "✗ (LEAK!)" : "✓ (isolated)"}`);

    // 10. Show raw headers for verification
    console.log("\n10. Admin headers response (first 300 chars):");
    console.log(`   ${headerBody1.slice(0, 300)}`);
    console.log("\n   User headers response (first 300 chars):");
    console.log(`   ${headerBody2.slice(0, 300)}`);

    // 11. Network capture
    console.log("\n11. Network capture:");
    const adminReqs = interceptor.getRequests({ containerId: admin.id });
    const userReqs = interceptor.getRequests({ containerId: user.id });
    console.log(`   Admin requests: ${adminReqs.length}`);
    console.log(`   User requests:  ${userReqs.length}`);

    // 12. Screenshots
    console.log("\n12. Screenshots...");
    const ss1 = await client.captureScreenshot(tab1);
    const ss2 = await client.captureScreenshot(tab2);
    await Bun.write("test/admin-headers.png", Buffer.from(ss1, "base64"));
    await Bun.write("test/user-headers.png", Buffer.from(ss2, "base64"));
    console.log("   ✓ Saved test/admin-headers.png and test/user-headers.png");

    // Summary
    console.log("\n═══ SUMMARY ═══");
    const cookieIsolation = adminHasAdmin && userHasUser && !adminHasUser && !userHasAdmin;
    const headerInjection = adminHasAdminJwt && userHasUserJwt;
    const headerIsolation = !adminHasUserJwt && !userHasAdminJwt;

    console.log(`   Cookie isolation: ${cookieIsolation ? "✓ PASS" : "✗ FAIL"}`);
    console.log(`   Header injection: ${headerInjection ? "✓ PASS" : "✗ FAIL"}`);
    console.log(`   Header isolation: ${headerIsolation ? "✓ PASS" : "✗ FAIL"}`);

    console.log("\n   Keeping browser open for 15 seconds...\n");
    await new Promise((r) => setTimeout(r, 15_000));

    // Cleanup
    await mgr.removeContainers();
    console.log("\n=== Test complete! ===");
  } catch (err) {
    console.error("\n✗ Error:", (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    interceptor.destroy();
    await closeFirefox(result);
    console.log("Cleaned up.");
  }
}

main();
