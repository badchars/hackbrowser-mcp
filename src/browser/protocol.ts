/**
 * Abstract browser protocol interface.
 * BiDi (primary) and CDP (fallback) both implement this.
 */

import type { CapturedRequest, Header } from "../types/index.js";

export type ProtocolType = "bidi" | "cdp";

/** Element reference returned by queries */
export interface ElementRef {
  sharedId?: string; // BiDi
  objectId?: string; // CDP
  backendNodeId?: number; // CDP
  selector: string;
}

/** Bounding box for element position */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Network event emitted by interceptor */
export interface NetworkEvent {
  type: "request" | "response" | "error";
  requestId: string;
  contextId: string;
  url: string;
  method: string;
  timestamp: number;
  // Request data
  requestHeaders?: Header[];
  requestBody?: string;
  // Response data (only for "response" type)
  status?: number;
  statusText?: string;
  responseHeaders?: Header[];
  mimeType?: string;
  responseBodySize?: number;
  // Error data (only for "error" type)
  errorText?: string;
}

/** Callback for network events */
export type NetworkEventHandler = (event: NetworkEvent) => void;

/**
 * Abstract protocol client interface.
 * Both BiDi and CDP clients implement this.
 */
export interface IProtocolClient {
  readonly type: ProtocolType;
  readonly connected: boolean;

  // ─── Connection ───
  connect(wsUrl: string): Promise<void>;
  disconnect(): Promise<void>;

  // ─── Browsing Context ───
  createContext(userContextId?: string): Promise<string>; // returns context ID
  closeContext(contextId: string): Promise<void>;
  getContexts(): Promise<{ id: string; url: string; userContext?: string }[]>;

  // ─── Navigation ───
  navigate(contextId: string, url: string, wait?: "none" | "interactive" | "complete"): Promise<string>;
  goBack(contextId: string): Promise<void>;
  goForward(contextId: string): Promise<void>;
  getCurrentUrl(contextId: string): Promise<string>;

  // ─── Script ───
  evaluate(contextId: string, expression: string): Promise<unknown>;
  callFunction(contextId: string, fn: string, args?: unknown[]): Promise<unknown>;

  // ─── DOM ───
  querySelector(contextId: string, selector: string): Promise<ElementRef | null>;
  querySelectorAll(contextId: string, selector: string): Promise<ElementRef[]>;
  getElementBounds(contextId: string, element: ElementRef): Promise<BoundingBox | null>;
  getElementText(contextId: string, element: ElementRef): Promise<string>;

  // ─── Input ───
  click(contextId: string, x: number, y: number): Promise<void>;
  typeText(contextId: string, text: string): Promise<void>;
  pressKey(contextId: string, key: string): Promise<void>;

  // ─── Screenshot ───
  captureScreenshot(contextId: string): Promise<string>; // base64 PNG

  // ─── Network ───
  enableNetworkInterception(contextId: string): Promise<void>;
  onNetworkEvent(handler: NetworkEventHandler): void;
  offNetworkEvent(handler: NetworkEventHandler): void;
  getResponseBody(contextId: string, requestId: string): Promise<string>;
  getRequestBody(contextId: string, requestId: string): Promise<string>;

  // ─── User Contexts (Containers) ───
  createUserContext(): Promise<string>; // returns user context ID
  removeUserContext(userContextId: string): Promise<void>;
  getUserContexts(): Promise<string[]>;

  // ─── Preload Scripts ───
  /**
   * Add a preload script that runs on every page load in the specified contexts.
   * Returns a script ID for later removal.
   */
  addPreloadScript(script: string, contexts?: string[]): Promise<string>;

  /** Remove a previously added preload script. */
  removePreloadScript(scriptId: string): Promise<void>;

  // ─── Network Interception (header injection) ───
  /**
   * Add a network intercept that pauses requests in beforeRequestSent phase.
   * Returns an intercept ID that can be used to remove it later.
   */
  addNetworkIntercept(params: {
    phases: ("beforeRequestSent" | "responseStarted" | "authRequired")[];
    urlPatterns?: { type: "string"; pattern: string }[];
    contexts?: string[];
  }): Promise<string>;

  /** Remove a previously added network intercept. */
  removeNetworkIntercept(interceptId: string): Promise<void>;

  /**
   * Continue an intercepted request, optionally modifying headers.
   * Called in response to a blocked network.beforeRequestSent event.
   */
  continueRequest(requestId: string, options?: {
    url?: string;
    method?: string;
    headers?: { name: string; value: { type: "string"; value: string } }[];
    body?: { type: "string"; value: string };
  }): Promise<void>;

  /**
   * Continue an intercepted response, optionally modifying it.
   */
  continueResponse(requestId: string, options?: {
    statusCode?: number;
    headers?: { name: string; value: { type: "string"; value: string } }[];
  }): Promise<void>;

  // ─── Cookies ───
  setCookie(params: {
    name: string;
    value: string;
    domain: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    userContext?: string;
  }): Promise<void>;
  getCookies(userContext?: string): Promise<{ name: string; value: string; domain: string }[]>;
  deleteCookies(params: { name?: string; domain?: string; userContext?: string }): Promise<void>;
}

/**
 * Create the best available protocol client.
 * Tries BiDi first, falls back to CDP.
 */
export async function createProtocolClient(wsUrl: string): Promise<IProtocolClient> {
  let bidiErr: string | undefined;

  // Try BiDi first (primary)
  try {
    const { BiDiClient } = await import("./bidi-client.js");
    const bidi = new BiDiClient();
    await bidi.connect(wsUrl);
    console.error(`[protocol] Connected via WebDriver BiDi`);
    return bidi;
  } catch (err) {
    bidiErr = (err as Error).message;
    console.error(`[protocol] BiDi failed: ${bidiErr}, trying CDP...`);
  }

  // Fallback to CDP
  try {
    const { CdpClient } = await import("./cdp-client.js");
    const cdp = new CdpClient();
    await cdp.connect(wsUrl);
    console.error(`[protocol] Connected via CDP (fallback)`);
    return cdp;
  } catch (err) {
    throw new Error(
      `Failed to connect via both protocols.\nBiDi: ${bidiErr}\nCDP: ${(err as Error).message}`
    );
  }
}
