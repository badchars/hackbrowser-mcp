/**
 * MCP Tool Definitions — 39 tools across 11 categories.
 *
 * Each tool is defined with Zod schema and an executor function.
 */

import { z } from "zod";
import type { IProtocolClient } from "../browser/protocol.js";
import { BrowserInteraction } from "../browser/interaction.js";
import type { ContainerManager } from "../browser/container-manager.js";
import { NetworkInterceptor } from "../capture/network-interceptor.js";
import { buildHar } from "../capture/har-builder.js";
import { saveHar, loadHar, mergeHar, harEntriesToRequests } from "../capture/har-storage.js";
import { extractEndpoints } from "../analysis/endpoint-extractor.js";
import { compareAccess } from "../analysis/container-differ.js";
import {
  generateAccessMatrix,
  formatAccessMatrix,
  findAccessDifferences,
} from "../analysis/access-matrix.js";
import { findInjectionPoints } from "../analysis/injection-mapper.js";
import type { Crawler } from "../browser/crawler.js";
import type { AuthDetector } from "../browser/auth-detector.js";
import { testInjection, testCsrf, testRateLimit } from "../analysis/active-tester.js";
import { generateReport } from "../analysis/report-generator.js";
import type { BrowserState, Container } from "../types/index.js";

/** Tool definition for registration */
export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  getState: () => BrowserState;
  getClient: () => IProtocolClient;
  getInteraction: () => BrowserInteraction;
  getContainerManager: () => ContainerManager;
  getInterceptor: () => NetworkInterceptor;
  getCrawler: () => Crawler;
  getAuthDetector: () => AuthDetector;
  startBrowser: (options?: { port?: number; headless?: boolean }) => Promise<BrowserState>;
  stopBrowser: () => Promise<void>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[] | { type: "image"; data: string; mimeType: string }[];
}

function text(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }] };
}

function json(data: unknown): ToolResult {
  return text(JSON.stringify(data, null, 2));
}

function image(base64: string): ToolResult {
  return { content: [{ type: "image" as const, data: base64, mimeType: "image/png" }] };
}

// ─── Tool Definitions ───

export const allTools: ToolDef[] = [
  // ═══ Browser (3) ═══
  {
    name: "browser_launch",
    description: "Launch Firefox with managed profile and container support. Must be called before other tools.",
    schema: {
      port: z.number().optional().describe("Remote debugging port (default: 9222)"),
      headless: z.boolean().optional().describe("Run in headless mode (default: false)"),
    },
    execute: async (args, ctx) => {
      const state = await ctx.startBrowser({
        port: args.port,
        headless: args.headless,
      });
      return json({ status: "launched", ...state });
    },
  },
  {
    name: "browser_close",
    description: "Close the browser and auto-export HAR to disk.",
    schema: {
      harPath: z.string().optional().describe("Path to save HAR file (default: ./capture.har)"),
    },
    execute: async (args, ctx) => {
      try {
        const interceptor = ctx.getInterceptor();

        // If explicit path requested, export there too
        if (args.harPath) {
          const containers = ctx.getContainerManager().listContainers();
          const roleMap = new Map(containers.map((c) => [c.id, c.role]));
          const har = buildHar(interceptor.getRequests(), "Firefox", roleMap);
          await saveHar(har, args.harPath);
        }

        // Final save happens automatically in stopBrowser → interceptor.finalSave()
        const savedPath = await interceptor.finalSave();
        const count = interceptor.count;

        await ctx.stopBrowser();
        return json({
          status: "closed",
          harExported: args.harPath || savedPath,
          entries: count,
        });
      } catch {
        await ctx.stopBrowser();
        return json({ status: "closed" });
      }
    },
  },
  {
    name: "browser_status",
    description: "Get current browser status: protocol, containers, tabs, captured requests.",
    schema: {},
    execute: async (_args, ctx) => {
      const state = ctx.getState();
      const interceptor = ctx.getInterceptor();
      return json({
        ...state,
        capturedRequestCount: interceptor.count,
        requestsByContainer: interceptor.getCountByContainer(),
      });
    },
  },

  // ═══ Container (3) ═══
  {
    name: "container_setup",
    description:
      "Create and configure containers with roles and credentials. Max 4 containers. Each container has isolated cookies, storage, and sessions.",
    schema: {
      containers: z
        .array(
          z.object({
            name: z.string().describe("Display name (e.g., 'Admin User')"),
            role: z.string().describe("Role identifier (e.g., 'admin', 'user', 'guest')"),
            color: z.enum(["blue", "green", "orange", "red"]).optional(),
            credentials: z
              .object({
                type: z.enum(["cookies", "headers", "login", "manual"]),
                cookies: z
                  .array(
                    z.object({
                      name: z.string(),
                      value: z.string(),
                      domain: z.string(),
                      path: z.string().optional(),
                      httpOnly: z.boolean().optional(),
                      secure: z.boolean().optional(),
                    })
                  )
                  .optional(),
                headers: z.record(z.string()).optional(),
                loginUrl: z.string().optional(),
                fields: z
                  .array(z.object({ selector: z.string(), value: z.string(), type: z.enum(["text", "password", "submit"]) }))
                  .optional(),
              })
              .optional(),
          })
        )
        .min(1)
        .max(4)
        .describe("Container configurations"),
    },
    execute: async (args, ctx) => {
      const mgr = ctx.getContainerManager();
      const created = await mgr.createContainers(args.containers);

      // Apply credentials
      for (let i = 0; i < created.length; i++) {
        const cred = args.containers[i].credentials;
        if (!cred) continue;

        const container = created[i];
        await mgr.applyCredentials(container.id, cred as import("../types/index.js").Credential);
      }

      return json({ containers: created });
    },
  },
  {
    name: "container_login",
    description:
      "Perform login for a container. Either programmatic (fill form + submit) or manual (opens login page, waits for user).",
    schema: {
      containerId: z.string().describe("Container ID or cookieStoreId"),
      loginUrl: z.string().describe("URL of the login page"),
      fields: z
        .array(
          z.object({
            selector: z.string().describe("CSS selector for the input"),
            value: z.string().describe("Value to type"),
            type: z.enum(["text", "password", "submit"]).describe("Field type"),
          })
        )
        .optional()
        .describe("Form fields to fill (omit for manual login)"),
      waitForUrl: z.string().optional().describe("URL pattern to wait for after login"),
      timeout: z.number().optional().describe("Timeout in ms (default: 60000)"),
    },
    execute: async (args, ctx) => {
      const mgr = ctx.getContainerManager();
      const interaction = ctx.getInteraction();

      const container = mgr.getContainer(args.containerId);
      if (!container) return text(`Container not found: ${args.containerId}`);

      // Create tab in container and navigate to login URL
      const ctxId = await mgr.createTab(container.id, args.loginUrl);

      // Enable network interception + header injection
      const interceptor = ctx.getInterceptor();
      interceptor.mapContextToContainer(ctxId, container.id);
      await interceptor.enableForContext(ctxId);
      await mgr.enableHeaderInjection(ctxId);

      if (args.fields && args.fields.length > 0) {
        // Programmatic login
        await interaction.waitFor(ctxId, { type: "selector", value: args.fields[0].selector, timeout: 10_000 });

        for (const field of args.fields) {
          if (field.type === "submit") {
            await interaction.clickElement(ctxId, field.selector);
          } else {
            await interaction.typeInto(ctxId, field.selector, field.value, { clear: true });
          }
        }

        if (args.waitForUrl) {
          await interaction.waitFor(ctxId, {
            type: "url",
            value: args.waitForUrl,
            timeout: args.timeout || 60_000,
          });
        }

        mgr.setAuthenticated(container.id, true);
        return json({ status: "logged_in", containerId: container.id, role: container.role });
      } else {
        // Manual login — user does it
        return json({
          status: "waiting_for_manual_login",
          containerId: container.id,
          role: container.role,
          message: `Navigate to ${args.loginUrl} in the "${container.name}" container tab and complete login manually. The container has a ${container.color} indicator.`,
        });
      }
    },
  },
  {
    name: "container_list",
    description: "List all containers with their roles, auth status, and tab count.",
    schema: {},
    execute: async (_args, ctx) => {
      const containers = ctx.getContainerManager().listContainers();
      return json(containers);
    },
  },

  // ═══ Navigation (4) ═══
  {
    name: "navigate",
    description: "Navigate to a URL in a specific container's tab.",
    schema: {
      containerId: z.string().describe("Container ID or cookieStoreId"),
      url: z.string().describe("URL to navigate to"),
      wait: z.enum(["none", "interactive", "complete"]).optional().describe("Wait condition (default: complete)"),
    },
    execute: async (args, ctx) => {
      const mgr = ctx.getContainerManager();
      const client = ctx.getClient();
      const interceptor = ctx.getInterceptor();

      // Get or create a tab in the container
      const ctxId = await mgr.getOrCreateTab(args.containerId);

      // Enable interception + header injection for this tab
      const container = mgr.getContainer(args.containerId);
      if (container) {
        interceptor.mapContextToContainer(ctxId, container.id);
        await interceptor.enableForContext(ctxId);
        await mgr.enableHeaderInjection(ctxId);
      }

      const resultUrl = await client.navigate(ctxId, args.url, args.wait || "complete");
      return json({ navigated: resultUrl, containerId: container?.id });
    },
  },
  {
    name: "go_back",
    description: "Navigate back in the specified container's tab.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getClient().goBack(ctxId);
      return text("Navigated back");
    },
  },
  {
    name: "go_forward",
    description: "Navigate forward in the specified container's tab.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getClient().goForward(ctxId);
      return text("Navigated forward");
    },
  },
  {
    name: "wait_for",
    description: "Wait for a condition in a container's tab.",
    schema: {
      containerId: z.string().describe("Container ID"),
      type: z.enum(["selector", "url", "network_idle", "js"]).describe("Condition type"),
      value: z.string().describe("Selector, URL pattern, idle ms, or JS expression"),
      timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().waitFor(ctxId, {
        type: args.type,
        value: args.value,
        timeout: args.timeout,
      });
      return text(`Condition met: ${args.type} = ${args.value}`);
    },
  },

  // ═══ Interaction (7) ═══
  {
    name: "click",
    description: "Click an element by CSS selector or text content.",
    schema: {
      containerId: z.string().describe("Container ID"),
      target: z.string().describe("CSS selector or text to find"),
      byText: z.boolean().optional().describe("Find by text content instead of selector"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().clickElement(ctxId, args.target, { byText: args.byText });
      return text(`Clicked: ${args.target}`);
    },
  },
  {
    name: "type_text",
    description: "Type text into an input element.",
    schema: {
      containerId: z.string().describe("Container ID"),
      selector: z.string().describe("CSS selector for the input"),
      text: z.string().describe("Text to type"),
      clear: z.boolean().optional().describe("Clear existing content first"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().typeInto(ctxId, args.selector, args.text, { clear: args.clear });
      return text(`Typed into ${args.selector}`);
    },
  },
  {
    name: "select_option",
    description: "Select a dropdown option.",
    schema: {
      containerId: z.string().describe("Container ID"),
      selector: z.string().describe("CSS selector for the select element"),
      value: z.string().describe("Option value to select"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().selectOption(ctxId, args.selector, args.value);
      return text(`Selected ${args.value} in ${args.selector}`);
    },
  },
  {
    name: "submit_form",
    description: "Submit a form element.",
    schema: {
      containerId: z.string().describe("Container ID"),
      selector: z.string().describe("CSS selector for the form or an element within it"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().submitForm(ctxId, args.selector);
      return text(`Submitted form: ${args.selector}`);
    },
  },
  {
    name: "scroll",
    description: "Scroll the page or an element.",
    schema: {
      containerId: z.string().describe("Container ID"),
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
      amount: z.number().optional().describe("Scroll amount in pixels (default: 500)"),
      selector: z.string().optional().describe("Scroll within this element"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().scroll(ctxId, args);
      return text(`Scrolled ${args.direction || "down"}`);
    },
  },
  {
    name: "hover",
    description: "Hover over an element.",
    schema: {
      containerId: z.string().describe("Container ID"),
      selector: z.string().describe("CSS selector"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getInteraction().hoverElement(ctxId, args.selector);
      return text(`Hovered: ${args.selector}`);
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key (Enter, Tab, Escape, etc.).",
    schema: {
      containerId: z.string().describe("Container ID"),
      key: z.string().describe("Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, F1-F12, or a character"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      await ctx.getClient().pressKey(ctxId, args.key);
      return text(`Pressed: ${args.key}`);
    },
  },

  // ═══ Page (4) ═══
  {
    name: "screenshot",
    description: "Capture a screenshot of the current page.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      const data = await ctx.getClient().captureScreenshot(ctxId);
      return image(data);
    },
  },
  {
    name: "get_page_source",
    description: "Get the HTML source of the current page.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      const html = await ctx.getInteraction().getPageSource(ctxId);
      // Truncate if too large
      return text(html.length > 50_000 ? html.slice(0, 50_000) + "\n[...truncated]" : html);
    },
  },
  {
    name: "get_dom_tree",
    description: "Get a simplified, LLM-friendly DOM tree of the current page. Shows important elements with attributes.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      const tree = await ctx.getInteraction().getDomTree(ctxId);
      return text(tree.length > 30_000 ? tree.slice(0, 30_000) + "\n[...truncated]" : tree);
    },
  },
  {
    name: "evaluate_js",
    description: "Execute JavaScript in the page and return the result.",
    schema: {
      containerId: z.string().describe("Container ID"),
      expression: z.string().describe("JavaScript expression to evaluate"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      const result = await ctx.getClient().evaluate(ctxId, args.expression);
      return json(result);
    },
  },

  // ═══ Network & HAR (5) ═══
  {
    name: "get_requests",
    description: "List captured HTTP requests. Supports filtering by container, URL, method, status.",
    schema: {
      containerId: z.string().optional().describe("Filter by container"),
      urlPattern: z.string().optional().describe("Regex pattern to match URLs"),
      method: z.string().optional().describe("HTTP method filter (GET, POST, etc.)"),
      statusMin: z.number().optional().describe("Minimum status code"),
      statusMax: z.number().optional().describe("Maximum status code"),
      mimeType: z.string().optional().describe("MIME type filter (e.g., 'json', 'html')"),
      limit: z.number().optional().describe("Max results (default: 100)"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests(args);
      const limited = requests.slice(0, args.limit || 100);
      return json(
        limited.map((r) => ({
          id: r.id,
          containerId: r.containerId,
          method: r.method,
          url: r.url,
          status: r.status,
          mimeType: r.mimeType,
          requestBodySize: r.requestBodySize,
          responseBodySize: r.responseBodySize,
          timestamp: r.timestamp,
        }))
      );
    },
  },
  {
    name: "get_response",
    description: "Get full response details (headers + body) for a captured request by ID.",
    schema: {
      requestId: z.string().describe("Request ID from get_requests"),
    },
    execute: async (args, ctx) => {
      const req = ctx.getInterceptor().getRequest(args.requestId);
      if (!req) return text(`Request not found: ${args.requestId}`);

      return json({
        id: req.id,
        url: req.url,
        method: req.method,
        status: req.status,
        statusText: req.statusText,
        requestHeaders: req.requestHeaders,
        requestBody: req.requestBody,
        responseHeaders: req.responseHeaders,
        responseBody: req.responseBody?.slice(0, 100_000),
        mimeType: req.mimeType,
      });
    },
  },
  {
    name: "get_endpoints",
    description: "List discovered API endpoints with URL templates, methods, parameters, and example values.",
    schema: {
      limit: z.number().optional().describe("Max results (default: 50)"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests();
      const endpoints = extractEndpoints(requests);
      return json(endpoints.slice(0, args.limit || 50));
    },
  },
  {
    name: "export_har",
    description: "Export captured network data as HAR file.",
    schema: {
      path: z.string().describe("File path to save HAR"),
      containerId: z.string().optional().describe("Export only this container's data"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests(
        args.containerId ? { containerId: args.containerId } : undefined
      );
      const containers = ctx.getContainerManager().listContainers();
      const roleMap = new Map(containers.map((c) => [c.id, c.role]));
      const har = buildHar(requests, "Firefox", roleMap);
      await saveHar(har, args.path);
      return json({ exported: args.path, entries: har.log.entries.length });
    },
  },
  {
    name: "import_har",
    description: "Import a HAR file to resume from previous capture. Merges with existing data.",
    schema: {
      path: z.string().describe("Path to HAR file"),
    },
    execute: async (args, ctx) => {
      const har = await loadHar(args.path);
      const requests = harEntriesToRequests(har.log.entries);
      ctx.getInterceptor().importRequests(requests);
      return json({ imported: args.path, entries: requests.length });
    },
  },

  // ═══ Analysis (4) ═══
  {
    name: "compare_access",
    description:
      "Compare access between containers. Finds endpoints where different roles get different responses — IDOR, missing authorization, privilege escalation.",
    schema: {
      container1: z.string().optional().describe("First container ID (default: compare all)"),
      container2: z.string().optional().describe("Second container ID"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests();
      const containers = ctx.getContainerManager().listContainers();
      const findings = compareAccess(requests, containers);
      return json({
        totalFindings: findings.length,
        bySeverity: {
          critical: findings.filter((f) => f.severity === "critical").length,
          high: findings.filter((f) => f.severity === "high").length,
          medium: findings.filter((f) => f.severity === "medium").length,
          low: findings.filter((f) => f.severity === "low").length,
          info: findings.filter((f) => f.severity === "info").length,
        },
        findings,
      });
    },
  },
  {
    name: "access_matrix",
    description: "Generate a role × endpoint access matrix. Shows which role can access which endpoint.",
    schema: {
      format: z.enum(["json", "table"]).optional().describe("Output format (default: json)"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests();
      const containers = ctx.getContainerManager().listContainers();
      const matrix = generateAccessMatrix(requests, containers);

      if (args.format === "table") {
        const table = formatAccessMatrix(matrix, containers);
        return text(table);
      }

      const diffs = findAccessDifferences(matrix);
      return json({
        totalEndpoints: matrix.length,
        endpointsWithDifferences: diffs.length,
        matrix: matrix.slice(0, 100),
      });
    },
  },
  {
    name: "find_injection_points",
    description:
      "Analyze captured requests for potential injection targets: SQL injection, XSS, SSRF, SSTI, command injection, LFI, open redirect, mass assignment, IDOR.",
    schema: {
      types: z
        .array(z.enum(["sqli", "xss", "ssrf", "ssti", "cmdi", "lfi", "open_redirect", "mass_assignment", "idor"]))
        .optional()
        .describe("Filter by injection types"),
      limit: z.number().optional().describe("Max results (default: 50)"),
    },
    execute: async (args, ctx) => {
      const requests = ctx.getInterceptor().getRequests();
      let points = findInjectionPoints(requests);

      if (args.types && args.types.length > 0) {
        points = points.filter((p) => p.types.some((t) => args.types!.includes(t)));
      }

      return json({
        totalPoints: points.length,
        byType: groupByType(points),
        points: points.slice(0, args.limit || 50),
      });
    },
  },
  {
    name: "replay_request",
    description: "Replay a captured request with modifications. Change method, headers, params, body, or target container.",
    schema: {
      requestId: z.string().describe("Original request ID to replay"),
      modifications: z
        .object({
          method: z.string().optional().describe("Override HTTP method"),
          url: z.string().optional().describe("Override URL"),
          headers: z.record(z.string()).optional().describe("Override/add headers"),
          body: z.string().optional().describe("Override request body"),
          containerId: z.string().optional().describe("Replay in different container"),
        })
        .optional(),
    },
    execute: async (args, ctx) => {
      const original = ctx.getInterceptor().getRequest(args.requestId);
      if (!original) return text(`Request not found: ${args.requestId}`);

      const mods = args.modifications || {};
      const method = mods.method || original.method;
      const url = mods.url || original.url;

      // Build headers
      const headers: Record<string, string> = {};
      for (const h of original.requestHeaders) {
        headers[h.name] = h.value;
      }
      if (mods.headers) {
        Object.assign(headers, mods.headers);
      }

      const body = mods.body ?? original.requestBody;

      // Use fetch to replay
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const fetchOptions: RequestInit = {
          method,
          headers,
          redirect: "follow",
          signal: controller.signal,
        };
        if (body && !["GET", "HEAD"].includes(method)) {
          fetchOptions.body = body;
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timer);
        const responseBody = await response.text();

        return json({
          original: { method: original.method, url: original.url, status: original.status },
          replayed: {
            method,
            url,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            bodySize: responseBody.length,
            body: responseBody.slice(0, 10_000),
          },
          diff: {
            statusChanged: original.status !== response.status,
            originalStatus: original.status,
            replayedStatus: response.status,
          },
        });
      } catch (err) {
        return json({ error: (err as Error).message });
      }
    },
  },

  // ═══ Discovery (2) ═══
  {
    name: "crawl",
    description:
      "Spider a website from a starting URL. BFS crawl within scope, discovering pages, forms, and API endpoints from JS source and XHR traffic.",
    schema: {
      containerId: z.string().describe("Container ID to crawl in"),
      url: z.string().describe("Starting URL"),
      maxDepth: z.number().optional().describe("Max link depth (default: 3)"),
      maxPages: z.number().optional().describe("Max pages to visit (default: 100)"),
      scope: z.string().optional().describe("Regex scope pattern (default: same origin)"),
      fillForms: z.boolean().optional().describe("Auto-fill forms (default: false)"),
      exclude: z.array(z.string()).optional().describe("URL patterns to exclude (e.g., 'logout', 'delete')"),
    },
    execute: async (args, ctx) => {
      const crawler = ctx.getCrawler();
      const result = await crawler.crawl({
        startUrl: args.url,
        containerId: args.containerId,
        maxDepth: args.maxDepth ?? 3,
        maxPages: args.maxPages ?? 100,
        scopePattern: args.scope,
        fillForms: args.fillForms ?? false,
        followRedirects: true,
        excludePatterns: args.exclude || [],
      });
      return json({
        pagesVisited: result.pagesVisited,
        urlsDiscovered: result.urlsDiscovered.length,
        formsFound: result.formsFound.length,
        apiEndpoints: result.apiEndpoints.length,
        errors: result.errors.length,
        duration: `${(result.duration / 1000).toFixed(1)}s`,
        urls: result.urlsDiscovered.slice(0, 50),
        forms: result.formsFound.slice(0, 20),
        apis: result.apiEndpoints.slice(0, 30),
      });
    },
  },
  {
    name: "get_sitemap",
    description: "Return discovered URLs, forms, and API endpoints from the last crawl.",
    schema: {},
    execute: async (_args, ctx) => {
      const crawler = ctx.getCrawler();
      const result = crawler.result;
      if (!result) return text("No crawl results yet. Run `crawl` first.");
      return json(result);
    },
  },

  // ═══ Active Testing (3) ═══
  {
    name: "test_injection",
    description:
      "Test an injection point with type-specific payloads (SQLi, XSS, SSRF, SSTI, CMDi, LFI, HTML Injection). 8-9 payloads per type with technique classification. Supports error-based, time-based blind, boolean-based blind SQLi, reflected XSS, template evaluation, cloud metadata SSRF, and more.",
    schema: {
      requestId: z.string().describe("Request ID containing the injection point"),
      param: z.string().describe("Parameter name to test"),
      location: z.enum(["query", "body", "header", "path"]).describe("Parameter location"),
      types: z
        .array(z.enum(["sqli", "xss", "ssrf", "ssti", "cmdi", "lfi", "html_injection"]))
        .optional()
        .describe("Injection types to test (default: all applicable)"),
      maxPayloads: z.number().optional().describe("Max payloads per type (default: 3)"),
    },
    execute: async (args, ctx) => {
      const req = ctx.getInterceptor().getRequest(args.requestId);
      if (!req) return text(`Request not found: ${args.requestId}`);

      const point = {
        url: req.url,
        method: req.method,
        param: args.param,
        location: args.location as "query" | "body" | "header" | "path",
        types: args.types || ["sqli", "xss", "ssrf", "ssti", "cmdi", "lfi", "html_injection"],
        evidence: "manual test",
        requestId: args.requestId,
      };

      const results = await testInjection(point, req, args.types, args.maxPayloads);
      const vulns = results.filter((r) => r.vulnerable);

      return json({
        tested: results.length,
        vulnerabilities: vulns.length,
        results: results.map((r) => ({
          type: r.type,
          vulnerable: r.vulnerable,
          confidence: r.confidence,
          technique: r.technique,
          evidence: r.evidence,
          payload: r.payload,
          status: r.response?.status,
        })),
      });
    },
  },
  {
    name: "test_csrf",
    description:
      "Test CSRF protection by replaying a POST/PUT/DELETE request without CSRF tokens. Checks if action succeeds without protection.",
    schema: {
      requestId: z.string().describe("Request ID (must be POST/PUT/DELETE)"),
    },
    execute: async (args, ctx) => {
      const req = ctx.getInterceptor().getRequest(args.requestId);
      if (!req) return text(`Request not found: ${args.requestId}`);

      const result = await testCsrf(req);
      return json({
        vulnerable: result.vulnerable,
        confidence: result.confidence,
        evidence: result.evidence,
        status: result.response?.status,
      });
    },
  },
  {
    name: "test_rate_limit",
    description:
      "Test rate limiting by sending rapid identical requests. Checks for 429 responses or blocking.",
    schema: {
      requestId: z.string().describe("Request ID to replay"),
      count: z.number().optional().describe("Number of requests to send (default: 20)"),
      delayMs: z.number().optional().describe("Delay between requests in ms (default: 0)"),
    },
    execute: async (args, ctx) => {
      const req = ctx.getInterceptor().getRequest(args.requestId);
      if (!req) return text(`Request not found: ${args.requestId}`);

      const result = await testRateLimit(req, args.count, args.delayMs);
      return json({
        vulnerable: result.vulnerable,
        confidence: result.confidence,
        evidence: result.evidence,
        statuses: result.response?.bodySnippet,
      });
    },
  },

  // ═══ Auth (3) ═══
  {
    name: "detect_auth",
    description:
      "Check if a container has a valid authenticated session. Inspects cookies, auth headers, and container flags.",
    schema: {
      containerId: z.string().describe("Container ID to check"),
    },
    execute: async (args, ctx) => {
      const detector = ctx.getAuthDetector();
      const status = await detector.detectAuth(args.containerId);
      return json(status);
    },
  },
  {
    name: "detect_login_form",
    description:
      "Detect a login form on the current page. Finds username, password fields, submit button, and CSRF tokens.",
    schema: {
      containerId: z.string().describe("Container ID"),
    },
    execute: async (args, ctx) => {
      const ctxId = await resolveContextId(args.containerId, ctx);
      const detector = ctx.getAuthDetector();
      const form = await detector.detectLoginForm(ctxId);
      if (!form) return text("No login form detected on this page.");
      return json(form);
    },
  },
  {
    name: "auto_login",
    description:
      "Auto-detect login form, fill credentials, and submit. Detects auth status after login.",
    schema: {
      containerId: z.string().describe("Container ID"),
      username: z.string().describe("Username or email"),
      password: z.string().describe("Password"),
      loginUrl: z.string().optional().describe("URL of login page (uses current page if omitted)"),
    },
    execute: async (args, ctx) => {
      const detector = ctx.getAuthDetector();
      const interaction = ctx.getInteraction();
      const result = await detector.autoLogin(
        args.containerId,
        args.username,
        args.password,
        interaction,
        args.loginUrl,
      );

      if (result.success) {
        ctx.getContainerManager().setAuthenticated(args.containerId, true);
      }

      return json(result);
    },
  },

  // ═══ Report (1) ═══
  {
    name: "generate_report",
    description:
      "Generate a security assessment report from all findings, test results, and discovered endpoints. Supports markdown and HTML output.",
    schema: {
      title: z.string().describe("Report title"),
      target: z.string().describe("Target domain or application"),
      format: z.enum(["markdown", "html"]).optional().describe("Output format (default: markdown)"),
      includeEvidence: z.boolean().optional().describe("Include request/response evidence (default: true)"),
      includeMatrix: z.boolean().optional().describe("Include access control matrix (default: true)"),
      severityFilter: z.array(z.string()).optional().describe("Only include these severities"),
      outputPath: z.string().optional().describe("File path to save report"),
    },
    execute: async (args, ctx) => {
      const interceptor = ctx.getInterceptor();
      const containers = ctx.getContainerManager().listContainers();
      const requests = interceptor.getRequests();
      const endpoints = extractEndpoints(requests);
      const findings = compareAccess(requests, containers);
      const injectionPoints = findInjectionPoints(requests);
      const matrix = generateAccessMatrix(requests, containers);
      const crawler = ctx.getCrawler();
      const detector = ctx.getAuthDetector();

      // Gather auth statuses
      const authStatuses = await Promise.all(
        containers.map((c) => detector.detectAuth(c.id))
      );

      const reportData = {
        accessFindings: findings,
        injectionPoints,
        testResults: [], // Test results aren't persisted globally — agent runs tests inline
        endpoints,
        accessMatrix: matrix,
        containers,
        crawlResult: crawler.result || undefined,
        authStatuses,
        requestCount: interceptor.count,
      };

      const options = {
        title: args.title,
        target: args.target,
        format: (args.format || "markdown") as "markdown" | "html",
        includeEvidence: args.includeEvidence ?? true,
        includeMatrix: args.includeMatrix ?? true,
        severityFilter: args.severityFilter,
      };

      const report = generateReport(reportData, options);

      if (args.outputPath) {
        await Bun.write(args.outputPath, report);
        return json({ saved: args.outputPath, length: report.length, format: options.format });
      }

      return text(report);
    },
  },
];

// ─── Helpers ───

async function resolveContextId(containerId: string, ctx: ToolContext): Promise<string> {
  const mgr = ctx.getContainerManager();
  const interceptor = ctx.getInterceptor();

  const ctxId = await mgr.resolveContextId(containerId);

  const container = mgr.getContainer(containerId);
  if (container) {
    interceptor.mapContextToContainer(ctxId, container.id);
  }

  return ctxId;
}

function groupByType(points: { types: string[] }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of points) {
    for (const t of p.types) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}
