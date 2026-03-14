/**
 * Endpoint Extractor — extracts API endpoints from captured traffic.
 *
 * Groups requests by URL template, extracts params, methods, objects, example values.
 * Handles REST, GraphQL, and generic URL patterns.
 */

import type { CapturedRequest, Endpoint, EndpointParam } from "./types.js";

/**
 * Extract endpoints from captured requests.
 */
export function extractEndpoints(requests: CapturedRequest[]): Endpoint[] {
  // Group by URL template
  const groups = new Map<string, CapturedRequest[]>();

  for (const req of requests) {
    // Skip non-API requests
    if (isStaticAsset(req.url) && !req.url.includes("/api/")) continue;

    const template = urlToTemplate(req.url);
    const existing = groups.get(template) || [];
    existing.push(req);
    groups.set(template, existing);
  }

  // Build endpoints
  const endpoints: Endpoint[] = [];

  for (const [template, reqs] of groups) {
    const methods = [...new Set(reqs.map((r) => r.method))];
    const params = extractParams(reqs);
    const requestContentTypes = [
      ...new Set(reqs.map((r) => findHeader(r.requestHeaders, "content-type")).filter(Boolean)),
    ] as string[];
    const responseContentTypes = [...new Set(reqs.map((r) => r.mimeType).filter(Boolean))];

    endpoints.push({
      urlTemplate: template,
      methods,
      params,
      requestContentTypes,
      responseContentTypes,
      exampleRequests: reqs.slice(0, 5).map((r) => ({
        containerId: r.containerId,
        requestId: r.id,
      })),
    });
  }

  // Sort by most accessed
  endpoints.sort((a, b) => b.exampleRequests.length - a.exampleRequests.length);

  return endpoints;
}

/**
 * Convert a URL to a template (replace dynamic segments).
 * /api/users/123 → /api/users/{id}
 * /api/posts/abc-def-ghi → /api/posts/{id}
 */
function urlToTemplate(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const segments = url.pathname.split("/");

    const templateSegments = segments.map((seg) => {
      if (!seg) return seg;

      // UUID pattern
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        return "{uuid}";
      }
      // Numeric ID
      if (/^\d+$/.test(seg)) {
        return "{id}";
      }
      // Long hex string (hash, token)
      if (/^[0-9a-f]{16,}$/i.test(seg)) {
        return "{hash}";
      }
      // Base64-like strings
      if (/^[A-Za-z0-9+/=]{20,}$/.test(seg)) {
        return "{token}";
      }
      // Slug-like with numbers (article-123)
      if (/^[a-z]+-\d+$/i.test(seg)) {
        return "{slug}";
      }

      return seg;
    });

    return `${url.origin}${templateSegments.join("/")}`;
  } catch {
    return urlStr;
  }
}

/**
 * Extract parameters from a group of requests to the same endpoint.
 */
function extractParams(requests: CapturedRequest[]): EndpointParam[] {
  const params = new Map<string, EndpointParam>();

  for (const req of requests) {
    // Query parameters
    try {
      const url = new URL(req.url);
      for (const [name, value] of url.searchParams) {
        addParam(params, name, "query", value, req);
      }
    } catch {}

    // Path parameters (from template comparison)
    const template = urlToTemplate(req.url);
    const templateParts = template.split("/");
    const urlParts = new URL(req.url).pathname.split("/");
    for (let i = 0; i < templateParts.length; i++) {
      if (templateParts[i]?.startsWith("{") && urlParts[i]) {
        const paramName = templateParts[i].slice(1, -1);
        addParam(params, paramName, "path", urlParts[i], req);
      }
    }

    // Body parameters (JSON)
    if (req.requestBody) {
      try {
        const body = JSON.parse(req.requestBody);
        if (typeof body === "object" && body !== null) {
          extractObjectParams(params, body, "body", req);
        }
      } catch {
        // Form data
        try {
          const formData = new URLSearchParams(req.requestBody);
          for (const [name, value] of formData) {
            addParam(params, name, "body", value, req);
          }
        } catch {}
      }
    }

    // Notable headers (Authorization, X-API-Key, etc.)
    for (const header of req.requestHeaders) {
      const name = header.name.toLowerCase();
      if (
        name === "authorization" ||
        name.startsWith("x-api") ||
        name.startsWith("x-csrf") ||
        name.startsWith("x-request") ||
        name === "x-forwarded-for"
      ) {
        addParam(params, header.name, "header", header.value, req);
      }
    }
  }

  return Array.from(params.values());
}

function extractObjectParams(
  params: Map<string, EndpointParam>,
  obj: Record<string, unknown>,
  location: "body",
  req: CapturedRequest,
  prefix: string = ""
): void {
  for (const [key, value] of Object.entries(obj)) {
    const paramName = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      addParam(params, paramName, location, "null", req);
    } else if (Array.isArray(value)) {
      addParam(params, paramName, location, JSON.stringify(value.slice(0, 2)), req, "array");
    } else if (typeof value === "object") {
      addParam(params, paramName, location, "[object]", req, "object");
      // Recurse one level deep
      if (!prefix) {
        extractObjectParams(params, value as Record<string, unknown>, location, req, paramName);
      }
    } else {
      addParam(params, paramName, location, String(value), req);
    }
  }
}

function addParam(
  params: Map<string, EndpointParam>,
  name: string,
  location: "path" | "query" | "body" | "header",
  value: string,
  req: CapturedRequest,
  forceType?: EndpointParam["type"]
): void {
  const key = `${location}:${name}`;
  const existing = params.get(key);

  if (existing) {
    if (!existing.exampleValues.includes(value) && existing.exampleValues.length < 5) {
      existing.exampleValues.push(value);
    }
  } else {
    params.set(key, {
      name,
      location,
      type: forceType ?? inferType(value),
      exampleValues: [value],
      required: true, // Will be refined later
    });
  }
}

function inferType(value: string): "string" | "number" | "boolean" | "object" | "array" {
  if (value === "true" || value === "false") return "boolean";
  if (/^\d+$/.test(value)) return "number";
  if (/^\d+\.\d+$/.test(value)) return "number";
  if (value.startsWith("[")) return "array";
  if (value.startsWith("{") || value === "[object]") return "object";
  return "string";
}

function isStaticAsset(url: string): boolean {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return [
    "js", "css", "png", "jpg", "jpeg", "gif", "svg", "ico",
    "woff", "woff2", "ttf", "eot", "map", "webp", "avif",
  ].includes(ext || "");
}

function findHeader(
  headers: { name: string; value: string }[],
  name: string
): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
