/**
 * Network Interceptor — captures all HTTP traffic per container.
 *
 * Subscribes to protocol network events and stores structured request/response data.
 * Links each request to its container via context → userContext mapping.
 */

import type { IProtocolClient, NetworkEvent, NetworkEventHandler } from "../browser/protocol.js";
import type { CapturedRequest, Header, RequestTiming } from "../types/index.js";

/** Mime types for which we auto-fetch response bodies. */
const TEXT_MIME_RE = /text\/|json|xml|javascript|html|css|svg/i;

const DEFAULT_MAX_ENTRIES = 10_000;

export class NetworkInterceptor {
  private client: IProtocolClient;
  private store = new Map<string, CapturedRequest>(); // requestId → CapturedRequest
  private contextToContainer = new Map<string, string>(); // contextId → containerId
  private handler: NetworkEventHandler;
  private requestCounter = 0;
  private maxEntries: number;

  // Auto-save state
  private autoSavePath: string | null = null;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private lastSaveCount = 0;

  constructor(client: IProtocolClient, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.client = client;
    this.maxEntries = maxEntries;
    this.handler = (event) => this.handleEvent(event);
    this.client.onNetworkEvent(this.handler);
  }

  /** Map a browsing context to a container ID. */
  mapContextToContainer(contextId: string, containerId: string): void {
    this.contextToContainer.set(contextId, containerId);
  }

  /** Enable network interception for a context. */
  async enableForContext(contextId: string): Promise<void> {
    await this.client.enableNetworkInterception(contextId);
  }

  /** Get all captured requests (optionally filtered). */
  getRequests(filter?: {
    containerId?: string;
    urlPattern?: string;
    method?: string;
    statusMin?: number;
    statusMax?: number;
    mimeType?: string;
  }): CapturedRequest[] {
    let requests = Array.from(this.store.values());

    if (filter) {
      if (filter.containerId) {
        requests = requests.filter((r) => r.containerId === filter.containerId);
      }
      if (filter.urlPattern) {
        const regex = new RegExp(filter.urlPattern, "i");
        requests = requests.filter((r) => regex.test(r.url));
      }
      if (filter.method) {
        const m = filter.method.toUpperCase();
        requests = requests.filter((r) => r.method === m);
      }
      if (filter.statusMin !== undefined) {
        requests = requests.filter((r) => r.status >= filter.statusMin!);
      }
      if (filter.statusMax !== undefined) {
        requests = requests.filter((r) => r.status <= filter.statusMax!);
      }
      if (filter.mimeType) {
        requests = requests.filter((r) => r.mimeType.includes(filter.mimeType!));
      }
    }

    return requests.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get a single request by ID. */
  getRequest(requestId: string): CapturedRequest | undefined {
    return this.store.get(requestId);
  }

  /** Get total count of captured requests. */
  get count(): number {
    return this.store.size;
  }

  /** Get count per container. */
  getCountByContainer(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const req of this.store.values()) {
      counts[req.containerId] = (counts[req.containerId] || 0) + 1;
    }
    return counts;
  }

  /** Clear all captured data. */
  clear(): void {
    this.store.clear();
    this.requestCounter = 0;
  }

  /** Clear captured data for a specific container. */
  clearContainer(containerId: string): void {
    for (const [id, req] of this.store) {
      if (req.containerId === containerId) {
        this.store.delete(id);
      }
    }
  }

  /** Import requests (e.g., from HAR). */
  importRequests(requests: CapturedRequest[]): void {
    for (const req of requests) {
      this.store.set(req.id, req);
    }
  }

  /** Stop listening and do final save. */
  async destroy(): Promise<void> {
    this.client.offNetworkEvent(this.handler);
    this.stopAutoSave();
    await this.doAutoSave(); // final save
  }

  // ─── Auto-save (HAR disk persistence) ───

  /** Enable periodic auto-save to HAR file. */
  startAutoSave(filePath: string, intervalMs: number = 60_000): void {
    this.autoSavePath = filePath;
    this.autoSaveTimer = setInterval(() => this.doAutoSave(), intervalMs);
    console.error(`[interceptor] Auto-save enabled: ${filePath} (every ${intervalMs / 1000}s)`);
  }

  /** Stop auto-save timer. */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /** Perform an auto-save (incremental — only if new data). */
  private async doAutoSave(): Promise<void> {
    if (!this.autoSavePath || this.store.size === 0 || this.store.size === this.lastSaveCount) return;
    try {
      const { buildHar } = await import("./har-builder.js");
      const { saveHar } = await import("./har-storage.js");
      const requests = Array.from(this.store.values());
      const har = buildHar(requests);
      await saveHar(har, this.autoSavePath);
      this.lastSaveCount = this.store.size;
    } catch (err) {
      console.error("[interceptor] Auto-save failed:", (err as Error).message);
    }
  }

  /** Final save — call on browser close. Returns the saved path or null. */
  async finalSave(): Promise<string | null> {
    if (!this.autoSavePath) return null;
    await this.doAutoSave();
    return this.autoSavePath;
  }

  // ─── Event handling ───

  private handleEvent(event: NetworkEvent): void {
    const containerId = this.contextToContainer.get(event.contextId) || "unknown";

    switch (event.type) {
      case "request":
        this.handleRequest(event, containerId);
        break;
      case "response":
        this.handleResponse(event, containerId);
        break;
      case "error":
        this.handleError(event, containerId);
        break;
    }
  }

  private handleRequest(event: NetworkEvent, containerId: string): void {
    const id = event.requestId || `req-${++this.requestCounter}`;

    const request: CapturedRequest = {
      id,
      containerId,
      timestamp: event.timestamp,
      url: event.url,
      method: event.method,
      requestHeaders: event.requestHeaders || [],
      requestBody: event.requestBody,
      requestBodySize: event.requestBody?.length || 0,
      status: 0,
      statusText: "",
      responseHeaders: [],
      responseBody: undefined,
      responseBodySize: 0,
      mimeType: "",
      timing: emptyTiming(),
      isWebSocket: event.url.startsWith("ws://") || event.url.startsWith("wss://"),
    };

    this.store.set(id, request);
    this.evictIfNeeded();

    // Auto-fetch request body for POST/PUT/PATCH (BiDi doesn't include it in events)
    if (["POST", "PUT", "PATCH"].includes(event.method) && !event.requestBody && event.contextId) {
      this.fetchRequestBody(event.requestId, event.contextId, id).catch(() => {});
    }
  }

  /** Fetch request body from the protocol client (preload script cache). */
  private async fetchRequestBody(requestId: string, contextId: string, storeId: string): Promise<void> {
    try {
      const body = await this.client.getRequestBody(contextId, requestId);
      const req = this.store.get(storeId);
      if (req && body) {
        req.requestBody = body;
        req.requestBodySize = body.length;
      }
    } catch {}
  }

  private handleResponse(event: NetworkEvent, containerId: string): void {
    const existing = this.store.get(event.requestId);

    if (existing) {
      // Update with response data
      existing.status = event.status || 0;
      existing.statusText = event.statusText || "";
      existing.responseHeaders = event.responseHeaders || [];
      existing.mimeType = event.mimeType || "";
      existing.responseBodySize = event.responseBodySize || 0;
    } else {
      // Create a new entry (missed the request event)
      const request: CapturedRequest = {
        id: event.requestId || `req-${++this.requestCounter}`,
        containerId,
        timestamp: event.timestamp,
        url: event.url,
        method: event.method,
        requestHeaders: [],
        requestBodySize: 0,
        status: event.status || 0,
        statusText: event.statusText || "",
        responseHeaders: event.responseHeaders || [],
        responseBody: undefined,
        responseBodySize: event.responseBodySize || 0,
        mimeType: event.mimeType || "",
        timing: emptyTiming(),
        isWebSocket: false,
      };
      this.store.set(request.id, request);
    }

    // Auto-fetch body for text-based responses
    if (TEXT_MIME_RE.test(event.mimeType || "") && event.contextId) {
      this.fetchResponseBody(event.requestId, event.contextId).catch(() => {});
    }
  }

  /** Fetch response body from the protocol client and store it. */
  private async fetchResponseBody(requestId: string, contextId: string): Promise<void> {
    try {
      const body = await this.client.getResponseBody(contextId, requestId);
      const req = this.store.get(requestId);
      if (req && body) {
        req.responseBody = body;
        req.responseBodySize = body.length;
      }
    } catch {
      // Body capture failed — not critical, continue without it
    }
  }

  /** Evict oldest entries when store exceeds maxEntries. */
  private evictIfNeeded(): void {
    if (this.store.size <= this.maxEntries) return;
    const overflow = this.store.size - this.maxEntries;
    const keys = this.store.keys();
    for (let i = 0; i < overflow; i++) {
      const { value, done } = keys.next();
      if (done) break;
      this.store.delete(value);
    }
  }

  private handleError(event: NetworkEvent, containerId: string): void {
    const existing = this.store.get(event.requestId);
    if (existing) {
      existing.status = 0;
      existing.statusText = event.errorText || "Network error";
    }
  }
}

function emptyTiming(): RequestTiming {
  return {
    blocked: -1,
    dns: -1,
    connect: -1,
    ssl: -1,
    send: 0,
    wait: 0,
    receive: 0,
  };
}
