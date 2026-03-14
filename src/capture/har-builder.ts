/**
 * HAR Builder — converts captured network data to HAR 1.2 format.
 */

import type { CapturedRequest, Header } from "../types/index.js";
import type {
  Har,
  HarEntry,
  HarRequest,
  HarResponse,
  HarHeader,
  HarQueryParam,
  HarCookie,
  HarPostData,
  HarTimings,
} from "../types/har.js";

/**
 * Build a HAR object from captured requests.
 */
export function buildHar(
  requests: CapturedRequest[],
  browserVersion: string = "Firefox",
  containerRoles?: Map<string, string>
): Har {
  const entries: HarEntry[] = requests
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((req) => buildEntry(req, containerRoles));

  return {
    log: {
      version: "1.2",
      creator: {
        name: "hackbrowser-mcp",
        version: "0.1.0",
      },
      browser: {
        name: "Firefox",
        version: browserVersion,
      },
      entries,
    },
  };
}

function buildEntry(
  req: CapturedRequest,
  containerRoles?: Map<string, string>
): HarEntry {
  const url = parseUrl(req.url);
  const totalTime =
    req.timing.blocked +
    req.timing.dns +
    req.timing.connect +
    req.timing.ssl +
    req.timing.send +
    req.timing.wait +
    req.timing.receive;

  const entry: HarEntry = {
    startedDateTime: new Date(req.timestamp).toISOString(),
    time: Math.max(0, totalTime),
    request: buildRequest(req, url),
    response: buildResponse(req),
    cache: {},
    timings: buildTimings(req),
    _containerId: req.containerId,
    _containerRole: containerRoles?.get(req.containerId),
  };

  return entry;
}

function buildRequest(req: CapturedRequest, url: URL | null): HarRequest {
  const headers: HarHeader[] = req.requestHeaders.map(headerToHar);
  const cookies = extractCookies(req.requestHeaders);
  const queryString = url ? extractQueryParams(url) : [];

  const harReq: HarRequest = {
    method: req.method,
    url: req.url,
    httpVersion: "HTTP/2.0",
    cookies,
    headers,
    queryString,
    headersSize: estimateHeadersSize(req.requestHeaders),
    bodySize: req.requestBodySize,
  };

  if (req.requestBody) {
    const contentType = findHeader(req.requestHeaders, "content-type") || "application/octet-stream";
    harReq.postData = buildPostData(req.requestBody, contentType);
  }

  return harReq;
}

function buildResponse(req: CapturedRequest): HarResponse {
  const headers: HarHeader[] = req.responseHeaders.map(headerToHar);
  const cookies = extractSetCookies(req.responseHeaders);

  return {
    status: req.status,
    statusText: req.statusText,
    httpVersion: "HTTP/2.0",
    cookies,
    headers,
    content: {
      size: req.responseBodySize,
      mimeType: req.mimeType || "application/octet-stream",
      text: req.responseBody,
    },
    redirectURL: req.redirectUrl || "",
    headersSize: estimateHeadersSize(req.responseHeaders),
    bodySize: req.responseBodySize,
  };
}

function buildTimings(req: CapturedRequest): HarTimings {
  return {
    blocked: req.timing.blocked >= 0 ? req.timing.blocked : -1,
    dns: req.timing.dns >= 0 ? req.timing.dns : -1,
    connect: req.timing.connect >= 0 ? req.timing.connect : -1,
    ssl: req.timing.ssl >= 0 ? req.timing.ssl : -1,
    send: Math.max(0, req.timing.send),
    wait: Math.max(0, req.timing.wait),
    receive: Math.max(0, req.timing.receive),
  };
}

function buildPostData(body: string, contentType: string): HarPostData {
  const params: { name: string; value?: string }[] = [];

  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const searchParams = new URLSearchParams(body);
      for (const [name, value] of searchParams) {
        params.push({ name, value });
      }
    } catch {}
  }

  return {
    mimeType: contentType,
    params,
    text: body,
  };
}

// ─── Helpers ───

function headerToHar(h: Header): HarHeader {
  return { name: h.name, value: h.value };
}

function findHeader(headers: Header[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function extractCookies(headers: Header[]): HarCookie[] {
  const cookieHeader = findHeader(headers, "cookie");
  if (!cookieHeader) return [];

  return cookieHeader.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return { name: name.trim(), value: rest.join("=").trim() };
  });
}

function extractSetCookies(headers: Header[]): HarCookie[] {
  return headers
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => {
      const [nameValue, ...parts] = h.value.split(";");
      const [name, ...rest] = nameValue.split("=");
      const cookie: HarCookie = {
        name: name.trim(),
        value: rest.join("=").trim(),
      };

      for (const part of parts) {
        const [key, val] = part.trim().split("=");
        const k = key.toLowerCase();
        if (k === "domain") cookie.domain = val;
        if (k === "path") cookie.path = val;
        if (k === "httponly") cookie.httpOnly = true;
        if (k === "secure") cookie.secure = true;
      }

      return cookie;
    });
}

function extractQueryParams(url: URL): HarQueryParam[] {
  const params: HarQueryParam[] = [];
  for (const [name, value] of url.searchParams) {
    params.push({ name, value });
  }
  return params;
}

function estimateHeadersSize(headers: Header[]): number {
  let size = 0;
  for (const h of headers) {
    size += h.name.length + h.value.length + 4; // ": " + "\r\n"
  }
  return size;
}

function parseUrl(urlStr: string): URL | null {
  try {
    return new URL(urlStr);
  } catch {
    return null;
  }
}
