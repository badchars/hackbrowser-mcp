/**
 * WebDriver BiDi protocol types (subset used by HackBrowser).
 * Spec: https://w3c.github.io/webdriver-bidi/
 */

// ─── Transport ───

export interface BiDiCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BiDiResult {
  id: number;
  type: "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
  stacktrace?: string;
}

export interface BiDiEvent {
  type: "event";
  method: string;
  params: Record<string, unknown>;
}

export type BiDiMessage = BiDiResult | BiDiEvent;

// ─── Session ───

export interface SessionCapabilities {
  browserName?: string;
  browserVersion?: string;
  platformName?: string;
  acceptInsecureCerts?: boolean;
  proxy?: Record<string, unknown>;
}

export interface SessionNew {
  capabilities: SessionCapabilities;
}

// ─── Browsing Context ───

export interface BrowsingContextInfo {
  context: string;
  url: string;
  children: BrowsingContextInfo[];
  parent?: string;
  userContext?: string; // container ID
  originalOpener?: string;
}

export interface NavigateResult {
  navigation: string | null;
  url: string;
}

export type ReadinessState = "none" | "interactive" | "complete";

// ─── Script ───

export interface ScriptEvaluateResult {
  type: "success" | "exception";
  result?: RemoteValue;
  exceptionDetails?: ExceptionDetails;
}

export interface RemoteValue {
  type: string;
  value?: unknown;
  handle?: string;
}

export interface ExceptionDetails {
  columnNumber: number;
  exception: RemoteValue;
  lineNumber: number;
  stackTrace: StackTrace;
  text: string;
}

export interface StackTrace {
  callFrames: StackFrame[];
}

export interface StackFrame {
  columnNumber: number;
  functionName: string;
  lineNumber: number;
  url: string;
}

// ─── Network ───

export interface NetworkRequestData {
  request: string; // request ID
  url: string;
  method: string;
  headers: NetworkHeader[];
  cookies: NetworkCookie[];
  headersSize: number;
  bodySize: number;
  timings: NetworkTimings;
}

export interface NetworkResponseData {
  url: string;
  protocol: string;
  status: number;
  statusText: string;
  fromCache: boolean;
  headers: NetworkHeader[];
  mimeType: string;
  bytesReceived: number;
  headersSize: number;
  bodySize: number;
  content: NetworkResponseContent;
}

export interface NetworkResponseContent {
  size: number;
}

export interface NetworkHeader {
  name: string;
  value: {
    type: "string";
    value: string;
  };
}

export interface NetworkCookie {
  name: string;
  value: {
    type: "string";
    value: string;
  };
  domain: string;
  path: string;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
}

export interface NetworkTimings {
  timeOrigin: number;
  requestTime: number;
  redirectStart: number;
  redirectEnd: number;
  fetchStart: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  tlsStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

// ─── Network Events ───

export interface NetworkBeforeRequestSent {
  context: string | null; // browsing context
  isBlocked: boolean;
  navigation: string | null;
  redirectCount: number;
  request: NetworkRequestData;
  timestamp: number;
  intercepts?: string[];
}

export interface NetworkResponseCompleted {
  context: string | null;
  isBlocked: boolean;
  navigation: string | null;
  redirectCount: number;
  request: NetworkRequestData;
  response: NetworkResponseData;
  timestamp: number;
}

export interface NetworkFetchError {
  context: string | null;
  errorText: string;
  request: NetworkRequestData;
  timestamp: number;
}

// ─── Input ───

export type InputAction = PointerAction | KeyAction;

export interface PointerAction {
  type: "pointer";
  id: string;
  parameters?: { pointerType: "mouse" | "pen" | "touch" };
  actions: PointerActionItem[];
}

export interface PointerActionItem {
  type: "pointerMove" | "pointerDown" | "pointerUp" | "pause";
  x?: number;
  y?: number;
  button?: number;
  duration?: number;
  origin?: "viewport" | "pointer" | { type: "element"; element: { sharedId: string } };
}

export interface KeyAction {
  type: "key";
  id: string;
  actions: KeyActionItem[];
}

export interface KeyActionItem {
  type: "keyDown" | "keyUp" | "pause";
  value?: string;
  duration?: number;
}

// ─── Screenshot ───

export interface CaptureScreenshotResult {
  data: string; // base64 encoded PNG
}

// ─── User Context (Containers) ───

export interface UserContextInfo {
  userContext: string;
}
