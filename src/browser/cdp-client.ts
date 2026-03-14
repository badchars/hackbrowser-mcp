/**
 * Chrome DevTools Protocol client — fallback protocol for older Firefox.
 * Raw WebSocket JSON communication.
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

export class CdpClient implements IProtocolClient {
  readonly type: ProtocolType = "cdp";

  private ws: WebSocket | null = null;
  private commandId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private networkHandlers = new Set<NetworkEventHandler>();
  private sessionId?: string;
  private targets = new Map<string, string>(); // contextId → targetId
  private requestBodyCache = new Map<string, string>(); // requestId → postData

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Connection ───

  async connect(wsUrl: string): Promise<void> {
    // CDP needs to first discover targets via HTTP
    const httpUrl = wsUrl.replace("ws://", "http://").replace("wss://", "https://");
    const jsonUrl = `${httpUrl}/json/version`;

    const resp = await fetch(jsonUrl);
    if (!resp.ok) throw new Error(`CDP discovery failed: ${resp.status}`);
    const info = (await resp.json()) as any;
    const debuggerUrl = info.webSocketDebuggerUrl;

    if (!debuggerUrl) throw new Error("No webSocketDebuggerUrl in CDP response");

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(debuggerUrl);

      const timeout = setTimeout(() => {
        reject(new Error("CDP connection timeout (10s)"));
        this.ws?.close();
      }, 10_000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`CDP WebSocket error: ${err.message}`));
      });

      this.ws.on("close", () => {
        this.pending.forEach(({ reject }) => reject(new Error("WebSocket closed")));
        this.pending.clear();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ─── Internal transport ───

  private async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = ++this.commandId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for CDP response to ${method} (id=${id})`));
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

      if (msg.error) {
        reject(new Error(msg.error.message || "CDP error"));
      } else {
        resolve(msg.result ?? {});
      }
      return;
    }

    // Event
    if (msg.method) {
      this.handleEvent(msg.method, msg.params ?? {});
    }
  }

  private handleEvent(method: string, params: any): void {
    if (method === "Network.requestWillBeSent") {
      // Cache request body for later retrieval
      if (params.request?.postData) {
        this.requestBodyCache.set(params.requestId ?? "", params.request.postData);
      }
      this.emitNetworkEvent({
        type: "request",
        requestId: params.requestId ?? "",
        contextId: params.frameId ?? "",
        url: params.request?.url ?? "",
        method: params.request?.method ?? "",
        timestamp: (params.timestamp ?? 0) * 1000,
        requestHeaders: Object.entries(params.request?.headers ?? {}).map(([name, value]) => ({
          name,
          value: value as string,
        })),
        requestBody: params.request?.postData,
      });
    } else if (method === "Network.responseReceived") {
      this.emitNetworkEvent({
        type: "response",
        requestId: params.requestId ?? "",
        contextId: params.frameId ?? "",
        url: params.response?.url ?? "",
        method: "",
        timestamp: (params.timestamp ?? 0) * 1000,
        status: params.response?.status,
        statusText: params.response?.statusText ?? "",
        responseHeaders: Object.entries(params.response?.headers ?? {}).map(([name, value]) => ({
          name,
          value: value as string,
        })),
        mimeType: params.response?.mimeType ?? "",
        responseBodySize: params.response?.encodedDataLength ?? 0,
      });
    } else if (method === "Network.loadingFailed") {
      this.emitNetworkEvent({
        type: "error",
        requestId: params.requestId ?? "",
        contextId: "",
        url: "",
        method: "",
        timestamp: (params.timestamp ?? 0) * 1000,
        errorText: params.errorText ?? "Loading failed",
      });
    }
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
    // CDP: create a new target (tab)
    const params: Record<string, unknown> = { url: "about:blank" };
    if (userContextId) {
      params.browserContextId = userContextId;
    }
    const result = await this.send("Target.createTarget", params);
    const targetId = result.targetId;
    if (userContextId) {
      this.targets.set(targetId, userContextId);
    }
    return targetId;
  }

  async closeContext(contextId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId: contextId });
    this.targets.delete(contextId);
  }

  async getContexts(): Promise<{ id: string; url: string; userContext?: string }[]> {
    const result = await this.send("Target.getTargets", {});
    return (result.targetInfos ?? [])
      .filter((t: any) => t.type === "page")
      .map((t: any) => ({
        id: t.targetId,
        url: t.url,
        userContext: t.browserContextId ?? this.targets.get(t.targetId),
      }));
  }

  // ─── Navigation ───

  async navigate(
    contextId: string,
    url: string,
    wait: "none" | "interactive" | "complete" = "complete"
  ): Promise<string> {
    const frameTree = await this.sendToTarget(contextId, "Page.getFrameTree", {});
    const frameId = frameTree.frameTree?.frame?.id;

    await this.sendToTarget(contextId, "Page.enable", {});
    const result = await this.sendToTarget(contextId, "Page.navigate", { url, frameId });

    if (wait !== "none") {
      await this.waitForLoad(contextId, wait === "complete" ? "load" : "DOMContentLoaded");
    }

    return result.url ?? url;
  }

  async goBack(contextId: string): Promise<void> {
    const history = await this.sendToTarget(contextId, "Page.getNavigationHistory", {});
    if (history.currentIndex > 0) {
      const entry = history.entries[history.currentIndex - 1];
      await this.sendToTarget(contextId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    }
  }

  async goForward(contextId: string): Promise<void> {
    const history = await this.sendToTarget(contextId, "Page.getNavigationHistory", {});
    if (history.currentIndex < history.entries.length - 1) {
      const entry = history.entries[history.currentIndex + 1];
      await this.sendToTarget(contextId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    }
  }

  async getCurrentUrl(contextId: string): Promise<string> {
    const result = await this.sendToTarget(contextId, "Runtime.evaluate", {
      expression: "window.location.href",
    });
    return result.result?.value ?? "";
  }

  // ─── Script ───

  async evaluate(contextId: string, expression: string): Promise<unknown> {
    const result = await this.sendToTarget(contextId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? "Eval failed"
      );
    }

    return result.result?.value;
  }

  async callFunction(contextId: string, fn: string, args: unknown[] = []): Promise<unknown> {
    const result = await this.sendToTarget(contextId, "Runtime.callFunctionOn", {
      functionDeclaration: fn,
      arguments: args.map((a) => ({ value: a })),
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "CallFunction failed");
    }

    return result.result?.value;
  }

  // ─── DOM ───

  async querySelector(contextId: string, selector: string): Promise<ElementRef | null> {
    try {
      const doc = await this.sendToTarget(contextId, "DOM.getDocument", {});
      const result = await this.sendToTarget(contextId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!result.nodeId || result.nodeId === 0) return null;
      return { backendNodeId: result.nodeId, selector };
    } catch {
      return null;
    }
  }

  async querySelectorAll(contextId: string, selector: string): Promise<ElementRef[]> {
    try {
      const doc = await this.sendToTarget(contextId, "DOM.getDocument", {});
      const result = await this.sendToTarget(contextId, "DOM.querySelectorAll", {
        nodeId: doc.root.nodeId,
        selector,
      });
      return (result.nodeIds ?? []).map((nodeId: number, i: number) => ({
        backendNodeId: nodeId,
        selector: `${selector}[${i}]`,
      }));
    } catch {
      return [];
    }
  }

  async getElementBounds(contextId: string, element: ElementRef): Promise<BoundingBox | null> {
    if (!element.backendNodeId) return null;
    try {
      const result = await this.sendToTarget(contextId, "DOM.getBoxModel", {
        nodeId: element.backendNodeId,
      });
      const content = result.model?.content;
      if (!content || content.length < 8) return null;
      return {
        x: content[0],
        y: content[1],
        width: content[2] - content[0],
        height: content[5] - content[1],
      };
    } catch {
      return null;
    }
  }

  async getElementText(contextId: string, element: ElementRef): Promise<string> {
    if (!element.backendNodeId) return "";
    try {
      const result = await this.sendToTarget(contextId, "DOM.resolveNode", {
        nodeId: element.backendNodeId,
      });
      const objId = result.object?.objectId;
      if (!objId) return "";

      const text = await this.sendToTarget(contextId, "Runtime.callFunctionOn", {
        objectId: objId,
        functionDeclaration: "function() { return this.textContent || ''; }",
        returnByValue: true,
      });
      return text.result?.value ?? "";
    } catch {
      return "";
    }
  }

  // ─── Input ───

  async click(contextId: string, x: number, y: number): Promise<void> {
    await this.sendToTarget(contextId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
    await this.sendToTarget(contextId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }

  async typeText(contextId: string, text: string): Promise<void> {
    for (const char of text) {
      await this.sendToTarget(contextId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
      });
      await this.sendToTarget(contextId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
      });
    }
  }

  async pressKey(contextId: string, key: string): Promise<void> {
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Delete: { key: "Delete", code: "Delete", keyCode: 46 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };

    const mapped = keyMap[key] ?? { key, code: key, keyCode: key.charCodeAt(0) };

    await this.sendToTarget(contextId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
    });
    await this.sendToTarget(contextId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
    });
  }

  // ─── Screenshot ───

  async captureScreenshot(contextId: string): Promise<string> {
    const result = await this.sendToTarget(contextId, "Page.captureScreenshot", {
      format: "png",
    });
    return result.data;
  }

  // ─── Network ───

  async enableNetworkInterception(contextId: string): Promise<void> {
    await this.sendToTarget(contextId, "Network.enable", {});
  }

  onNetworkEvent(handler: NetworkEventHandler): void {
    this.networkHandlers.add(handler);
  }

  offNetworkEvent(handler: NetworkEventHandler): void {
    this.networkHandlers.delete(handler);
  }

  async getResponseBody(contextId: string, requestId: string): Promise<string> {
    const result = await this.sendToTarget(contextId, "Network.getResponseBody", {
      requestId,
    });
    if (result.base64Encoded) {
      return Buffer.from(result.body, "base64").toString("utf-8");
    }
    return result.body ?? "";
  }

  async getRequestBody(_contextId: string, requestId: string): Promise<string> {
    // CDP provides postData in the requestWillBeSent event, which we cache
    return this.requestBodyCache.get(requestId) || "";
  }

  // ─── Preload Scripts ───

  async addPreloadScript(script: string, _contexts?: string[]): Promise<string> {
    const result = await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${script})()`,
    });
    return result.identifier ?? `cdp-script-${++this.commandId}`;
  }

  async removePreloadScript(scriptId: string): Promise<void> {
    await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  }

  // ─── Network Interception (header injection) ───
  // CDP stub — header injection is BiDi-native, CDP uses Network.setExtraHTTPHeaders

  async addNetworkIntercept(params: {
    phases: ("beforeRequestSent" | "responseStarted" | "authRequired")[];
    urlPatterns?: { type: "string"; pattern: string }[];
    contexts?: string[];
  }): Promise<string> {
    // CDP doesn't have BiDi-style intercepts — use Fetch.enable for similar functionality
    return `cdp-intercept-${++this.commandId}`;
  }

  async removeNetworkIntercept(_interceptId: string): Promise<void> {
    // no-op for CDP
  }

  async continueRequest(_requestId: string, _options?: {
    url?: string;
    method?: string;
    headers?: { name: string; value: { type: "string"; value: string } }[];
    body?: { type: "string"; value: string };
  }): Promise<void> {
    // no-op for CDP
  }

  async continueResponse(_requestId: string, _options?: {
    statusCode?: number;
    headers?: { name: string; value: { type: "string"; value: string } }[];
  }): Promise<void> {
    // no-op for CDP
  }

  // ─── User Contexts (Containers) ───

  async createUserContext(): Promise<string> {
    const result = await this.send("Target.createBrowserContext", {});
    return result.browserContextId;
  }

  async removeUserContext(userContextId: string): Promise<void> {
    await this.send("Target.disposeBrowserContext", { browserContextId: userContextId });
  }

  async getUserContexts(): Promise<string[]> {
    const result = await this.send("Target.getBrowserContexts", {});
    return result.browserContextIds ?? [];
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
    const cdpParams: Record<string, unknown> = {
      name: params.name,
      value: params.value,
      domain: params.domain,
      path: params.path ?? "/",
      httpOnly: params.httpOnly ?? false,
      secure: params.secure ?? false,
      sameSite: params.sameSite ? params.sameSite.charAt(0).toUpperCase() + params.sameSite.slice(1) : "None",
    };

    if (params.userContext) {
      cdpParams.browserContextId = params.userContext;
    }

    await this.send("Network.setCookie", cdpParams);
  }

  async getCookies(
    userContext?: string
  ): Promise<{ name: string; value: string; domain: string }[]> {
    const params: Record<string, unknown> = {};
    if (userContext) {
      params.browserContextId = userContext;
    }

    const result = await this.send("Network.getCookies", params);
    return (result.cookies ?? []).map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    }));
  }

  async deleteCookies(params: {
    name?: string;
    domain?: string;
    userContext?: string;
  }): Promise<void> {
    const cdpParams: Record<string, unknown> = {};
    if (params.name) cdpParams.name = params.name;
    if (params.domain) cdpParams.domain = params.domain;
    if (params.userContext) cdpParams.browserContextId = params.userContext;

    await this.send("Network.deleteCookies", cdpParams);
  }

  // ─── CDP-specific helpers ───

  /**
   * Send command to a specific target (tab).
   * CDP requires attaching to targets and using sessionId.
   */
  private async sendToTarget(
    targetId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<any> {
    // For simplicity, use Target.sendMessageToTarget pattern
    // In a more robust implementation, we'd maintain per-target sessions
    return this.send(method, params);
  }

  private async waitForLoad(contextId: string, event: string): Promise<void> {
    // Simple polling approach — wait for document.readyState
    const target = event === "load" ? "complete" : "interactive";
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        const state = await this.evaluate(contextId, "document.readyState");
        if (state === target || state === "complete") return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
