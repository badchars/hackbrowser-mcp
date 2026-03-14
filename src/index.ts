/**
 * HackBrowser MCP — Multi-container Firefox browser for security testing.
 *
 * Entry point: parse args → launch browser → start MCP/A2A servers.
 */

// ─── Public API exports ───

export { BrowserInteraction } from "./browser/interaction.js";
export { ContainerManager } from "./browser/container-manager.js";
export { NetworkInterceptor } from "./capture/network-interceptor.js";
export { Crawler } from "./browser/crawler.js";
export { AuthDetector } from "./browser/auth-detector.js";
export { buildHar } from "./capture/har-builder.js";
export { saveHar, loadHar, mergeHar, harEntriesToRequests } from "./capture/har-storage.js";
export { extractEndpoints } from "./analysis/endpoint-extractor.js";
export { findInjectionPoints } from "./analysis/injection-mapper.js";
export { testInjection, testCsrf, testRateLimit } from "./analysis/active-tester.js";
export { compareAccess } from "./analysis/container-differ.js";
export { generateAccessMatrix, formatAccessMatrix, findAccessDifferences } from "./analysis/access-matrix.js";
export { generateReport } from "./analysis/report-generator.js";
export { launchFirefox, closeFirefox, findFirefoxBinary } from "./browser/launcher.js";
export { createMcpServer, startMcpStdio } from "./protocol/mcp-server.js";
export { allTools } from "./protocol/tools.js";
export type { ToolDef, ToolContext, ToolResult } from "./protocol/tools.js";
export type { TestResult } from "./analysis/active-tester.js";
export type {
  Container, CapturedRequest, Header, Endpoint, EndpointParam,
  InjectionPoint, InjectionType, AccessEntry, AccessResult,
  AccessFinding, BrowserState, Credential,
} from "./types/index.js";

// ─── CLI entry point ───

import { existsSync } from "fs";
import { launchFirefox, closeFirefox, findFirefoxBinary } from "./browser/launcher.js";
import type { LaunchResult } from "./browser/launcher.js";
import { BrowserInteraction } from "./browser/interaction.js";
import { ContainerManager } from "./browser/container-manager.js";
import { NetworkInterceptor } from "./capture/network-interceptor.js";
import { Crawler } from "./browser/crawler.js";
import { AuthDetector } from "./browser/auth-detector.js";
import { loadHar, harEntriesToRequests } from "./capture/har-storage.js";
import { startMcpStdio } from "./protocol/mcp-server.js";
import type { ToolContext } from "./protocol/tools.js";
import type { BrowserState } from "./types/index.js";

// ─── Global state ───

let browserResult: LaunchResult | null = null;
let interaction: BrowserInteraction | null = null;
let containerManager: ContainerManager | null = null;
let interceptor: NetworkInterceptor | null = null;
let crawler: Crawler | null = null;
let authDetector: AuthDetector | null = null;

/** Get the current browser state. */
function getBrowserState(): BrowserState {
  if (!browserResult) {
    return {
      running: false,
      protocol: "none",
      containers: containerManager?.listContainers() || [],
      tabCount: 0,
      capturedRequestCount: interceptor?.count || 0,
    };
  }

  return {
    running: true,
    protocol: browserResult.client.type,
    firefoxPid: browserResult.pid,
    containers: containerManager?.listContainers() || [],
    tabCount: 0,
    capturedRequestCount: interceptor?.count || 0,
    profilePath: browserResult.profilePath,
  };
}

/** Launch the browser. */
async function startBrowser(options: {
  port?: number;
  headless?: boolean;
} = {}): Promise<BrowserState> {
  if (browserResult) {
    throw new Error("Browser already running");
  }

  // Launch Firefox
  browserResult = await launchFirefox({
    port: options.port,
    headless: options.headless,
  });

  // Set up container manager with the protocol client + extension WS server
  containerManager = new ContainerManager(browserResult.client, 9221);
  await containerManager.startExtensionServer();

  // Set up interaction + interception
  interaction = new BrowserInteraction(browserResult.client);
  interceptor = new NetworkInterceptor(browserResult.client);

  // Set up crawler + auth detector
  crawler = new Crawler(browserResult.client, containerManager, interceptor);
  authDetector = new AuthDetector(browserResult.client, containerManager);

  // Resume from previous capture if exists
  const capturePath = `${browserResult.profilePath}/hackbrowser-capture.har`;
  if (existsSync(capturePath)) {
    try {
      const har = await loadHar(capturePath);
      const requests = harEntriesToRequests(har.log.entries);
      interceptor.importRequests(requests);
      console.error(`[hackbrowser] Resumed ${requests.length} requests from previous capture`);
    } catch (err) {
      console.error(`[hackbrowser] Failed to resume capture: ${(err as Error).message}`);
    }
  }

  // Start auto-saving captured data every 60 seconds
  interceptor.startAutoSave(capturePath);

  return getBrowserState();
}

/** Stop the browser. */
async function stopBrowser(): Promise<void> {
  if (interceptor) {
    const savedPath = await interceptor.finalSave();
    if (savedPath) console.error(`[hackbrowser] Capture saved to ${savedPath}`);
    await interceptor.destroy();
    interceptor = null;
  }
  if (containerManager) {
    await containerManager.destroy();
    containerManager = null;
  }
  if (browserResult) {
    await closeFirefox(browserResult);
    browserResult = null;
    interaction = null;
    crawler = null;
    authDetector = null;
  }
}

/** Build the ToolContext that tools use to access everything. */
function buildToolContext(): ToolContext {
  return {
    getState: getBrowserState,
    getClient: () => {
      if (!browserResult) throw new Error("Browser not running. Call browser_launch first.");
      return browserResult.client;
    },
    getInteraction: () => {
      if (!interaction) throw new Error("Browser not running. Call browser_launch first.");
      return interaction;
    },
    getContainerManager: () => {
      if (!containerManager) throw new Error("Browser not running. Call browser_launch first.");
      return containerManager;
    },
    getInterceptor: () => {
      if (!interceptor) throw new Error("Browser not running. Call browser_launch first.");
      return interceptor;
    },
    getCrawler: () => {
      if (!crawler) throw new Error("Browser not running. Call browser_launch first.");
      return crawler;
    },
    getAuthDetector: () => {
      if (!authDetector) throw new Error("Browser not running. Call browser_launch first.");
      return authDetector;
    },
    startBrowser,
    stopBrowser,
  };
}

// ─── CLI entry point ───

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
hackbrowser-mcp — Multi-container Firefox browser for security testing

Usage:
  bun run src/index.ts [options]

Options:
  --port <n>      Remote debugging port (default: 9222)
  --headless      Run in headless mode
  --mcp           Start MCP server (stdio)
  --a2a           Start A2A server (HTTP)
  --launch        Launch browser immediately
  --help, -h      Show this help

Examples:
  bun run src/index.ts --launch           # Launch browser only
  bun run src/index.ts --mcp              # Start as MCP server
  bun run src/index.ts --mcp --a2a        # Start both protocols
`);
    return;
  }

  const port = parseInt(args[args.indexOf("--port") + 1]) || 9222;
  const headless = args.includes("--headless");
  const launchBrowser = args.includes("--launch");
  const wantMcp = args.includes("--mcp");
  const wantA2a = args.includes("--a2a");

  const ctx = buildToolContext();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.error(`\n[hackbrowser] Shutting down...`);
    await stopBrowser();
    process.exit(0);
  });

  if (wantMcp) {
    // MCP mode — start server, browser launched on-demand via browser_launch tool
    console.error(`[hackbrowser] Starting MCP server (stdio)...`);
    await startMcpStdio(ctx);
    console.error(`[hackbrowser] MCP server ready. Waiting for commands.`);

    // Keep process alive
    await new Promise(() => {});
  } else if (launchBrowser) {
    // Direct launch mode — just launch the browser
    try {
      console.error(`[hackbrowser] Finding Firefox...`);
      const binary = findFirefoxBinary();
      console.error(`[hackbrowser] Firefox: ${binary}`);

      console.error(`[hackbrowser] Launching browser...`);
      const state = await startBrowser({ port, headless });
      console.error(`[hackbrowser] Browser running (${state.protocol}, PID: ${state.firefoxPid})`);

      if (wantA2a) {
        // TODO: Start A2A server (Phase 7)
        console.error(`[hackbrowser] A2A server not yet implemented`);
      }

      console.error(`[hackbrowser] Browser launched. Press Ctrl+C to close.`);
      await new Promise(() => {});
    } catch (err) {
      console.error(`[hackbrowser] Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error(
      `[hackbrowser] No action specified. Use --launch, --mcp, or --help.`
    );
    process.exit(0);
  }
}

main();
