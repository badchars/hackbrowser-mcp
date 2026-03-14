/**
 * WebDriver BiDi client — primary protocol.
 * Raw WebSocket JSON-RPC communication with Firefox.
 */

import WebSocket from "ws";
import type {
  IProtocolClient,
  ProtocolType,
  ElementRef,
  BoundingBox,
  NetworkEvent,
  NetworkEventHandler,
} from "./protocol.js";

export class BiDiClient implements IProtocolClient {
  readonly type: ProtocolType = "bidi";

  private ws: WebSocket | null = null;
  private commandId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private networkHandlers = new Set<NetworkEventHandler>();
  private contextToUserContext = new Map<string, string>(); // contextId → userContextId

  // Header injection: userContextId → headers to inject
  private headerOverrides = new Map<string, Record<string, string>>();
  // Intercept IDs per user context for cleanup
  private interceptIds = new Map<string, string>(); // userContextId → interceptId

  // Response body capture: requestId → { url, method, isDocument }
  private requestMeta = new Map<string, { url: string; method: string; isDocument: boolean }>();
  private bodyPreloadScriptId: string | null = null;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Connection ───

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // BiDi endpoint
      const url = wsUrl.endsWith("/session") ? wsUrl : `${wsUrl}/session`;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error("BiDi connection timeout (10s)"));
        this.ws?.close();
      }, 10_000);

      this.ws.on("open", async () => {
        clearTimeout(timeout);
        try {
          // Create BiDi session
          await this.send("session.new", {
            capabilities: {
              alwaysMatch: {
                acceptInsecureCerts: true,
              },
            },
          });

          // Install body capture preload script
          await this.installBodyCaptureScript();

          // Install stealth preload script
          await this.installStealthScript();

          // Subscribe to network events globally (all contexts)
          await this.send("session.subscribe", {
            events: [
              "network.beforeRequestSent",
              "network.responseCompleted",
              "network.fetchError",
            ],
          });
          console.error("[bidi] Global network capture enabled");

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`BiDi WebSocket error: ${err.message}`));
      });

      this.ws.on("close", () => {
        this.pending.forEach(({ reject }) => reject(new Error("WebSocket closed")));
        this.pending.clear();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        await this.send("session.end", {});
      } catch {}
      this.ws.close();
      this.ws = null;
    }
  }

  // ─── Internal transport ───

  private async send(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = ++this.commandId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.ws!.send(message);
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Command response
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);

      if (msg.type === "error" || msg.error) {
        reject(new Error(msg.message || msg.error || "Unknown BiDi error"));
      } else {
        resolve(msg.result ?? msg);
      }
      return;
    }

    // Event
    if (msg.type === "event" && msg.method) {
      this.handleEvent(msg.method, msg.params);
    }
  }

  private handleEvent(method: string, params: any): void {
    // Network events
    if (method === "network.beforeRequestSent") {
      const requestId = params.request?.request ?? "";
      const contextId = params.context ?? "";
      const isBlocked = params.isBlocked === true;

      // Store request metadata for later body retrieval
      if (requestId) {
        this.requestMeta.set(requestId, {
          url: params.request?.url ?? "",
          method: (params.request?.method ?? "GET").toUpperCase(),
          isDocument: params.navigation != null,
        });
      }

      // Emit the network event for capture (regardless of blocked state)
      this.emitNetworkEvent({
        type: "request",
        requestId,
        contextId,
        url: params.request?.url ?? "",
        method: params.request?.method ?? "",
        timestamp: params.timestamp ?? Date.now(),
        requestHeaders: (params.request?.headers ?? []).map((h: any) => ({
          name: h.name,
          value: h.value?.value ?? h.value ?? "",
        })),
      });

      // If request is blocked (intercepted), inject headers and continue
      if (isBlocked && requestId) {
        this.handleBlockedRequest(requestId, contextId, params).catch((err) => {
          console.error(`[bidi] Failed to continue blocked request: ${err.message}`);
        });
      }
    } else if (method === "network.responseCompleted") {
      this.emitNetworkEvent({
        type: "response",
        requestId: params.request?.request ?? "",
        contextId: params.context ?? "",
        url: params.request?.url ?? "",
        method: params.request?.method ?? "",
        timestamp: params.timestamp ?? Date.now(),
        status: params.response?.status,
        statusText: params.response?.statusText ?? "",
        responseHeaders: (params.response?.headers ?? []).map((h: any) => ({
          name: h.name,
          value: h.value?.value ?? h.value ?? "",
        })),
        mimeType: params.response?.mimeType ?? "",
        responseBodySize: params.response?.bodySize ?? params.response?.bytesReceived ?? 0,
      });
    } else if (method === "network.fetchError") {
      this.emitNetworkEvent({
        type: "error",
        requestId: params.request?.request ?? "",
        contextId: params.context ?? "",
        url: params.request?.url ?? "",
        method: params.request?.method ?? "",
        timestamp: params.timestamp ?? Date.now(),
        errorText: params.errorText ?? "Unknown network error",
      });
    }
  }

  /** Stealth user-agent for all requests. */
  private static readonly STEALTH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:137.0) Gecko/20100101 Firefox/137.0";

  /**
   * Handle a blocked (intercepted) request — inject custom headers + stealth UA.
   */
  private async handleBlockedRequest(
    requestId: string,
    contextId: string,
    params: any
  ): Promise<void> {
    // Find the user context for this browsing context
    const userContextId = this.contextToUserContext.get(contextId);
    const overrides = userContextId ? this.headerOverrides.get(userContextId) : undefined;

    // Always modify headers — at minimum override User-Agent for stealth
    const originalHeaders: { name: string; value: { type: "string"; value: string } }[] =
      (params.request?.headers ?? []).map((h: any) => ({
        name: h.name,
        value: { type: "string" as const, value: h.value?.value ?? h.value ?? "" },
      }));

    // Build combined override set: stealth UA + user overrides
    const allOverrides: Record<string, string> = {
      "User-Agent": BiDiClient.STEALTH_UA,
      ...(overrides || {}),
    };

    const overrideNames = new Set(Object.keys(allOverrides).map((n) => n.toLowerCase()));
    const filtered = originalHeaders.filter(
      (h) => !overrideNames.has(h.name.toLowerCase())
    );

    for (const [name, value] of Object.entries(allOverrides)) {
      filtered.push({ name, value: { type: "string", value } });
    }

    await this.continueRequest(requestId, { headers: filtered });
  }

  private emitNetworkEvent(event: NetworkEvent): void {
    for (const handler of this.networkHandlers) {
      try {
        handler(event);
      } catch {}
    }
  }

  // ─── Browsing Context ───

  async createContext(userContextId?: string): Promise<string> {
    const params: Record<string, unknown> = { type: "tab" };
    if (userContextId) {
      params.userContext = userContextId;
    }
    const result = await this.send("browsingContext.create", params);
    const contextId = result.context;
    if (userContextId) {
      this.contextToUserContext.set(contextId, userContextId);
    }
    return contextId;
  }

  async closeContext(contextId: string): Promise<void> {
    await this.send("browsingContext.close", { context: contextId });
    this.contextToUserContext.delete(contextId);
  }

  async getContexts(): Promise<{ id: string; url: string; userContext?: string }[]> {
    const result = await this.send("browsingContext.getTree", {});
    return (result.contexts ?? []).map((ctx: any) => ({
      id: ctx.context,
      url: ctx.url,
      userContext: ctx.userContext ?? this.contextToUserContext.get(ctx.context),
    }));
  }

  // ─── Navigation ───

  async navigate(
    contextId: string,
    url: string,
    wait: "none" | "interactive" | "complete" = "complete"
  ): Promise<string> {
    const result = await this.send("browsingContext.navigate", {
      context: contextId,
      url,
      wait,
    });
    return result.url ?? url;
  }

  async goBack(contextId: string): Promise<void> {
    await this.send("browsingContext.traverseHistory", {
      context: contextId,
      delta: -1,
    });
  }

  async goForward(contextId: string): Promise<void> {
    await this.send("browsingContext.traverseHistory", {
      context: contextId,
      delta: 1,
    });
  }

  async getCurrentUrl(contextId: string): Promise<string> {
    const contexts = await this.getContexts();
    const ctx = contexts.find((c) => c.id === contextId);
    return ctx?.url ?? "";
  }

  // ─── Script ───

  async evaluate(contextId: string, expression: string): Promise<unknown> {
    const result = await this.send("script.evaluate", {
      expression,
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: "none",
    });

    if (result.type === "exception") {
      throw new Error(result.exceptionDetails?.text ?? "Script evaluation failed");
    }

    return this.deserializeValue(result.result);
  }

  async callFunction(contextId: string, fn: string, args: unknown[] = []): Promise<unknown> {
    const result = await this.send("script.callFunction", {
      functionDeclaration: fn,
      target: { context: contextId },
      arguments: args.map((a) => this.serializeValue(a)),
      awaitPromise: true,
      resultOwnership: "none",
    });

    if (result.type === "exception") {
      throw new Error(result.exceptionDetails?.text ?? "Function call failed");
    }

    return this.deserializeValue(result.result);
  }

  // ─── DOM ───

  async querySelector(contextId: string, selector: string): Promise<ElementRef | null> {
    try {
      const result = await this.send("script.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        target: { context: contextId },
        awaitPromise: false,
        resultOwnership: "root",
      });

      if (result.result?.type === "null" || !result.result?.sharedId) {
        return null;
      }

      return {
        sharedId: result.result.sharedId,
        selector,
      };
    } catch {
      return null;
    }
  }

  async querySelectorAll(contextId: string, selector: string): Promise<ElementRef[]> {
    try {
      const result = await this.send("script.evaluate", {
        expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
        target: { context: contextId },
        awaitPromise: false,
        resultOwnership: "root",
      });

      if (result.result?.type !== "array" || !Array.isArray(result.result?.value)) {
        return [];
      }

      return result.result.value
        .filter((v: any) => v.sharedId)
        .map((v: any, i: number) => ({
          sharedId: v.sharedId,
          selector: `${selector}:nth-match(${i})`,
        }));
    } catch {
      return [];
    }
  }

  async getElementBounds(contextId: string, element: ElementRef): Promise<BoundingBox | null> {
    if (!element.sharedId) return null;

    try {
      const result = await this.send("script.callFunction", {
        functionDeclaration: `function(el) {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
        target: { context: contextId },
        arguments: [{ sharedId: element.sharedId }],
        awaitPromise: false,
        resultOwnership: "none",
      });

      return this.deserializeValue(result.result) as BoundingBox;
    } catch {
      return null;
    }
  }

  async getElementText(contextId: string, element: ElementRef): Promise<string> {
    if (!element.sharedId) return "";

    try {
      const result = await this.send("script.callFunction", {
        functionDeclaration: `function(el) { return el.textContent || ''; }`,
        target: { context: contextId },
        arguments: [{ sharedId: element.sharedId }],
        awaitPromise: false,
        resultOwnership: "none",
      });

      return (this.deserializeValue(result.result) as string) ?? "";
    } catch {
      return "";
    }
  }

  // ─── Input ───

  async click(contextId: string, x: number, y: number): Promise<void> {
    await this.send("input.performActions", {
      context: contextId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x: Math.round(x), y: Math.round(y) },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async typeText(contextId: string, text: string): Promise<void> {
    const actions: any[] = [];
    for (const char of text) {
      actions.push({ type: "keyDown", value: char });
      actions.push({ type: "keyUp", value: char });
    }

    await this.send("input.performActions", {
      context: contextId,
      actions: [{ type: "key", id: "keyboard", actions }],
    });
  }

  async pressKey(contextId: string, key: string): Promise<void> {
    // Map common key names to Unicode values
    const keyMap: Record<string, string> = {
      Enter: "\uE006",
      Tab: "\uE004",
      Escape: "\uE00C",
      Backspace: "\uE003",
      Delete: "\uE017",
      ArrowUp: "\uE013",
      ArrowDown: "\uE015",
      ArrowLeft: "\uE012",
      ArrowRight: "\uE014",
      Home: "\uE011",
      End: "\uE010",
      PageUp: "\uE00E",
      PageDown: "\uE00F",
      F1: "\uE031",
      F5: "\uE035",
      F12: "\uE03C",
    };

    const value = keyMap[key] ?? key;

    await this.send("input.performActions", {
      context: contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ],
        },
      ],
    });
  }

  // ─── Screenshot ───

  async captureScreenshot(contextId: string): Promise<string> {
    const result = await this.send("browsingContext.captureScreenshot", {
      context: contextId,
    });
    return result.data;
  }

  // ─── Network ───

  async enableNetworkInterception(contextId: string): Promise<void> {
    await this.send("session.subscribe", {
      events: [
        "network.beforeRequestSent",
        "network.responseCompleted",
        "network.fetchError",
      ],
      contexts: [contextId],
    });
  }

  onNetworkEvent(handler: NetworkEventHandler): void {
    this.networkHandlers.add(handler);
  }

  offNetworkEvent(handler: NetworkEventHandler): void {
    this.networkHandlers.delete(handler);
  }

  async getResponseBody(contextId: string, requestId: string): Promise<string> {
    // BiDi protocol has no getResponseBody command.
    // We use a preload script that patches fetch/XHR to cache response bodies.
    const meta = this.requestMeta.get(requestId);
    if (!meta) return "";

    const key = `${meta.method}:${meta.url}`;

    // Try preload script cache first (captures fetch/XHR responses)
    try {
      const result = await this.evaluate(contextId,
        `window.__hb_bodies?.get(${JSON.stringify(key)}) || null`
      );
      if (typeof result === "string") {
        // Clean up from cache to free memory
        this.evaluate(contextId,
          `window.__hb_bodies?.delete(${JSON.stringify(key)})`
        ).catch(() => {});
        return result;
      }
    } catch {}

    // Fallback for document loads: read the page HTML
    if (meta.isDocument) {
      try {
        const html = await this.evaluate(contextId, "document.documentElement.outerHTML");
        if (typeof html === "string") return html;
      } catch {}
    }

    return "";
  }

  async getRequestBody(contextId: string, requestId: string): Promise<string> {
    const meta = this.requestMeta.get(requestId);
    if (!meta) return "";
    const key = `${meta.method}:${meta.url}`;
    try {
      const result = await this.evaluate(contextId,
        `window.__hb_req_bodies?.get(${JSON.stringify(key)}) || null`
      );
      if (typeof result === "string") return result;
    } catch {}
    return "";
  }

  /**
   * Install the body capture preload script.
   * Patches fetch() and XMLHttpRequest to cache both request and response bodies.
   */
  private async installBodyCaptureScript(): Promise<void> {
    try {
      this.bodyPreloadScriptId = await this.addPreloadScript(`function() {
  if (window.__hb_bodies) return;
  var MAX_SIZE = 1048576;
  var MAX_ENTRIES = 200;
  var bodies = new Map();
  var reqBodies = new Map();

  function storeRes(url, method, body) {
    if (typeof body !== 'string' || body.length > MAX_SIZE) return;
    bodies.set(method + ':' + url, body);
    if (bodies.size > MAX_ENTRIES) bodies.delete(bodies.keys().next().value);
  }

  function storeReq(url, method, body) {
    if (typeof body !== 'string' || body.length > MAX_SIZE) return;
    reqBodies.set(method + ':' + url, body);
    if (reqBodies.size > MAX_ENTRIES) reqBodies.delete(reqBodies.keys().next().value);
  }

  // Patch fetch — capture both request body and response body
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var method = ((init && init.method) || 'GET').toUpperCase();
      // Capture request body
      if (init && init.body) {
        if (typeof init.body === 'string') {
          storeReq(url, method, init.body);
        } else if (init.body instanceof URLSearchParams) {
          storeReq(url, method, init.body.toString());
        }
      }
    } catch(e) {}
    return origFetch.apply(this, arguments).then(function(response) {
      try {
        var url2 = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var method2 = ((init && init.method) || 'GET').toUpperCase();
        var ct = response.headers.get('content-type') || '';
        if (/text|json|xml|javascript|html/.test(ct)) {
          var clone = response.clone();
          clone.text().then(function(t) { storeRes(url2, method2, t); }).catch(function(){});
        }
      } catch(e) {}
      return response;
    });
  };

  // Patch XHR — capture both request body (send) and response body (load)
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__hb_m = method;
    this.__hb_u = url;
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    // Capture request body
    try {
      if (body && typeof body === 'string') {
        storeReq(xhr.__hb_u, (xhr.__hb_m || 'POST').toUpperCase(), body);
      }
    } catch(e) {}
    // Capture response body
    xhr.addEventListener('load', function() {
      try {
        var ct = xhr.getResponseHeader('content-type') || '';
        if (/text|json|xml|javascript|html/.test(ct)) {
          storeRes(xhr.__hb_u, (xhr.__hb_m || 'GET').toUpperCase(), xhr.responseText);
        }
      } catch(e) {}
    });
    return origSend.apply(this, arguments);
  };

  Object.defineProperty(window, '__hb_bodies', { value: bodies, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(window, '__hb_req_bodies', { value: reqBodies, writable: true, enumerable: false, configurable: true });
}`);
      console.error("[bidi] Body capture preload script installed");
    } catch (err) {
      console.error("[bidi] Failed to install body capture script:", (err as Error).message);
    }
  }

  /**
   * Install the stealth preload script.
   * Hides automation indicators: navigator.webdriver, user-agent, plugins, etc.
   */
  private async installStealthScript(): Promise<void> {
    try {
      await this.addPreloadScript(`function() {
  if (window.__hb_stealth) return;
  window.__hb_stealth = true;

  // ── Hide navigator.webdriver — must survive both value check AND 'in' operator ──
  // Strategy: wrap navigator in a Proxy that hides 'webdriver' from 'in' / hasOwnProperty
  try {
    // First try to delete from prototype chain
    var proto = Object.getPrototypeOf(navigator);
    var desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
    if (desc && desc.configurable) {
      delete proto.webdriver;
    } else if (desc) {
      // Not configurable — override with undefined getter at instance level
      Object.defineProperty(navigator, 'webdriver', {
        get: function() { return undefined; },
        configurable: true,
        enumerable: false
      });
    }
  } catch(e) {}
  // Also override on navigator instance itself
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: function() { return undefined; },
      configurable: true,
      enumerable: false
    });
  } catch(e) {}

  // ── Spoof user-agent to stable Firefox ──
  var STEALTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:137.0) Gecko/20100101 Firefox/137.0';
  try {
    Object.defineProperty(navigator, 'userAgent', { get: function() { return STEALTH_UA; } });
    Object.defineProperty(navigator, 'appVersion', { get: function() { return '5.0 (Macintosh)'; } });
    Object.defineProperty(navigator, 'platform', { get: function() { return 'MacIntel'; } });
  } catch(e) {}

  // ── navigator.plugins — don't override if already has real plugins (non-automated Firefox) ──
  // Only override if empty (automation strips plugins)
  try {
    if (navigator.plugins.length === 0) {
      // Use real PluginArray prototype for instanceof checks
      var realPlugins = navigator.plugins;
      var fakePlugins = Object.create(Object.getPrototypeOf(realPlugins));
      var pluginData = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '', length: 1 },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '', length: 1 },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '', length: 1 },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '', length: 1 },
      ];
      for (var pi = 0; pi < pluginData.length; pi++) {
        Object.defineProperty(fakePlugins, pi, { value: pluginData[pi], enumerable: true });
      }
      Object.defineProperty(fakePlugins, 'length', { value: 5, enumerable: true });
      fakePlugins.item = function(i) { return this[i] || null; };
      fakePlugins.namedItem = function(n) {
        for (var i = 0; i < this.length; i++) { if (this[i].name === n) return this[i]; }
        return null;
      };
      fakePlugins.refresh = function() {};
      fakePlugins[Symbol.iterator] = function*() { for (var i = 0; i < 5; i++) yield this[i]; };
      Object.defineProperty(navigator, 'plugins', {
        get: function() { return fakePlugins; }
      });
    }
    Object.defineProperty(navigator, 'mimeTypes', {
      get: function() {
        return {
          length: 2,
          0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          item: function(i) { return this[i] || null; },
          namedItem: function(n) {
            for (var i = 0; i < this.length; i++) { if (this[i].type === n) return this[i]; }
            return null;
          },
          [Symbol.iterator]: function*() { for (var i = 0; i < 2; i++) yield this[i]; }
        };
      }
    });
  } catch(e) {}

  // ── navigator.languages ──
  try {
    Object.defineProperty(navigator, 'languages', {
      get: function() { return ['en-US', 'en']; },
      configurable: true
    });
  } catch(e) {}

  // ── Permissions API — normalize responses ──
  try {
    if (navigator.permissions) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(desc) {
        if (desc.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return origQuery(desc);
      };
    }
  } catch(e) {}

  // ── Hide stealth flag ──
  Object.defineProperty(window, '__hb_stealth', { enumerable: false });
}`);
      console.error("[bidi] Stealth preload script installed");
    } catch (err) {
      console.error("[bidi] Failed to install stealth script:", (err as Error).message);
    }
  }

  // ─── Preload Scripts ───

  async addPreloadScript(script: string, contexts?: string[]): Promise<string> {
    const params: Record<string, unknown> = {
      functionDeclaration: script,
    };
    if (contexts && contexts.length > 0) {
      params.contexts = contexts;
    }
    const result = await this.send("script.addPreloadScript", params);
    return result.script;
  }

  async removePreloadScript(scriptId: string): Promise<void> {
    await this.send("script.removePreloadScript", { script: scriptId });
  }

  // ─── Network Interception (header injection) ───

  async addNetworkIntercept(params: {
    phases: ("beforeRequestSent" | "responseStarted" | "authRequired")[];
    urlPatterns?: { type: "string"; pattern: string }[];
    contexts?: string[];
  }): Promise<string> {
    const result = await this.send("network.addIntercept", {
      phases: params.phases,
      urlPatterns: params.urlPatterns,
      contexts: params.contexts,
    });
    return result.intercept;
  }

  async removeNetworkIntercept(interceptId: string): Promise<void> {
    await this.send("network.removeIntercept", { intercept: interceptId });
  }

  async continueRequest(requestId: string, options?: {
    url?: string;
    method?: string;
    headers?: { name: string; value: { type: "string"; value: string } }[];
    body?: { type: "string"; value: string };
  }): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };
    if (options?.url) params.url = options.url;
    if (options?.method) params.method = options.method;
    if (options?.headers) params.headers = options.headers;
    if (options?.body) params.body = options.body;
    await this.send("network.continueRequest", params);
  }

  async continueResponse(requestId: string, options?: {
    statusCode?: number;
    headers?: { name: string; value: { type: "string"; value: string } }[];
  }): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };
    if (options?.statusCode) params.statusCode = options.statusCode;
    if (options?.headers) params.headers = options.headers;
    await this.send("network.continueResponse", params);
  }

  /**
   * Set header overrides for a user context.
   * All requests from this context will have these headers injected.
   */
  setHeaderOverridesForContext(userContextId: string, headers: Record<string, string>): void {
    if (Object.keys(headers).length === 0) {
      this.headerOverrides.delete(userContextId);
    } else {
      this.headerOverrides.set(userContextId, headers);
    }
  }

  /** Get current header overrides for a user context. */
  getHeaderOverridesForContext(userContextId: string): Record<string, string> | undefined {
    return this.headerOverrides.get(userContextId);
  }

  /**
   * Enable header injection intercept for a browsing context.
   * Registers a beforeRequestSent intercept that adds custom headers.
   */
  async enableHeaderInjection(contextId: string): Promise<void> {
    const interceptId = await this.addNetworkIntercept({
      phases: ["beforeRequestSent"],
      contexts: [contextId],
    });

    const userContextId = this.contextToUserContext.get(contextId);
    if (userContextId) {
      this.interceptIds.set(userContextId, interceptId);
    }
  }

  // ─── User Contexts (Containers) ───

  async createUserContext(): Promise<string> {
    const result = await this.send("browser.createUserContext", {});
    return result.userContext;
  }

  async removeUserContext(userContextId: string): Promise<void> {
    await this.send("browser.removeUserContext", { userContext: userContextId });
  }

  async getUserContexts(): Promise<string[]> {
    const result = await this.send("browser.getUserContexts", {});
    return (result.userContexts ?? [])
      .map((uc: any) => uc.userContext)
      .filter((id: string) => id !== "default");
  }

  // ─── Cookies ───

  async setCookie(params: {
    name: string;
    value: string;
    domain: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    userContext?: string;
  }): Promise<void> {
    // SameSite=None requires secure=true
    const sameSite = params.sameSite ?? "none";
    const secure = sameSite === "none" ? true : (params.secure ?? false);

    const cookie: Record<string, unknown> = {
      name: params.name,
      value: { type: "string", value: params.value },
      domain: params.domain,
      path: params.path ?? "/",
      httpOnly: params.httpOnly ?? false,
      secure,
      sameSite,
    };

    const storageParams: Record<string, unknown> = { cookie };
    if (params.userContext) {
      storageParams.partition = { type: "storageKey", userContext: params.userContext };
    }

    await this.send("storage.setCookie", storageParams);
  }

  async getCookies(
    userContext?: string
  ): Promise<{ name: string; value: string; domain: string }[]> {
    const params: Record<string, unknown> = {};
    if (userContext) {
      params.partition = { type: "storageKey", userContext };
    }

    const result = await this.send("storage.getCookies", params);
    return (result.cookies ?? []).map((c: any) => ({
      name: c.name,
      value: c.value?.value ?? c.value ?? "",
      domain: c.domain ?? "",
    }));
  }

  async deleteCookies(params: {
    name?: string;
    domain?: string;
    userContext?: string;
  }): Promise<void> {
    const filter: Record<string, unknown> = {};
    if (params.name) filter.name = params.name;
    if (params.domain) filter.domain = params.domain;

    const storageParams: Record<string, unknown> = { filter };
    if (params.userContext) {
      storageParams.partition = { type: "storageKey", userContext: params.userContext };
    }

    await this.send("storage.deleteCookies", storageParams);
  }

  // ─── Value serialization helpers ───

  private serializeValue(value: unknown): any {
    if (value === null) return { type: "null" };
    if (value === undefined) return { type: "undefined" };
    if (typeof value === "string") return { type: "string", value };
    if (typeof value === "number") return { type: "number", value };
    if (typeof value === "boolean") return { type: "boolean", value };
    if (Array.isArray(value))
      return { type: "array", value: value.map((v) => this.serializeValue(v)) };
    if (typeof value === "object") {
      return {
        type: "object",
        value: Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.serializeValue(v),
        ]),
      };
    }
    return { type: "string", value: String(value) };
  }

  private deserializeValue(remote: any): unknown {
    if (!remote) return undefined;
    switch (remote.type) {
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "string":
        return remote.value;
      case "number":
        return remote.value;
      case "boolean":
        return remote.value;
      case "bigint":
        return BigInt(remote.value);
      case "array":
        return (remote.value ?? []).map((v: any) => this.deserializeValue(v));
      case "object":
        return Object.fromEntries(
          (remote.value ?? []).map(([k, v]: [string, any]) => [k, this.deserializeValue(v)])
        );
      case "node":
        return remote.sharedId ?? remote.value;
      default:
        return remote.value;
    }
  }
}
