/** Container identity */
export interface Container {
  id: string;
  cookieStoreId: string;
  name: string;
  color: ContainerColor;
  role: string;
  credentials?: Credential;
  authenticated: boolean;
  tabIds: string[];
}

export type ContainerColor = "blue" | "green" | "orange" | "red";

/** Credential injection methods */
export type Credential =
  | { type: "cookies"; cookies: CookieEntry[] }
  | { type: "headers"; headers: Record<string, string> }
  | { type: "login"; loginUrl: string; fields: LoginField[] }
  | { type: "manual" };

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface LoginField {
  selector: string;
  value: string;
  type: "text" | "password" | "submit";
}

/** Captured HTTP request/response */
export interface CapturedRequest {
  id: string;
  containerId: string;
  timestamp: number;
  url: string;
  method: string;
  requestHeaders: Header[];
  requestBody?: string;
  requestBodySize: number;
  status: number;
  statusText: string;
  responseHeaders: Header[];
  responseBody?: string;
  responseBodySize: number;
  mimeType: string;
  timing: RequestTiming;
  redirectUrl?: string;
  initiator?: string;
  isWebSocket: boolean;
}

export interface Header {
  name: string;
  value: string;
}

export interface RequestTiming {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

/** Discovered API endpoint */
export interface Endpoint {
  urlTemplate: string;
  methods: string[];
  params: EndpointParam[];
  requestContentTypes: string[];
  responseContentTypes: string[];
  exampleRequests: { containerId: string; requestId: string }[];
}

export interface EndpointParam {
  name: string;
  location: "path" | "query" | "body" | "header";
  type: "string" | "number" | "boolean" | "object" | "array";
  exampleValues: string[];
  required: boolean;
}

/** Access matrix entry */
export interface AccessEntry {
  endpoint: string;
  method: string;
  results: Record<string, AccessResult>; // containerId → result
}

export interface AccessResult {
  status: number;
  responseSize: number;
  responseSimilarity?: number; // 0-1 similarity to reference
  accessible: boolean;
}

/** Injection point candidate */
export interface InjectionPoint {
  url: string;
  method: string;
  param: string;
  location: "query" | "body" | "header" | "path" | "cookie";
  types: InjectionType[];
  evidence: string;
  requestId: string;
}

export type InjectionType =
  | "sqli"
  | "xss"
  | "ssrf"
  | "ssti"
  | "cmdi"
  | "lfi"
  | "html_injection"
  | "open_redirect"
  | "mass_assignment"
  | "idor";

/** Access control finding */
export interface AccessFinding {
  type: "idor" | "missing_authz" | "privilege_escalation" | "mass_assignment" | "info_leak";
  severity: "critical" | "high" | "medium" | "low" | "info";
  endpoint: string;
  method: string;
  description: string;
  containers: {
    containerId: string;
    role: string;
    status: number;
    responseSnippet?: string;
  }[];
}

/** Browser state */
export interface BrowserState {
  running: boolean;
  protocol: "bidi" | "cdp" | "none";
  firefoxPid?: number;
  containers: Container[];
  tabCount: number;
  capturedRequestCount: number;
  profilePath?: string;
}
