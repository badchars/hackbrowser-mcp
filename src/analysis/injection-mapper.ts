/**
 * Injection Mapper — identifies potential injection points from captured traffic.
 *
 * Analyzes request parameters for SQL injection, XSS, SSRF, SSTI,
 * command injection, LFI, open redirect, mass assignment, and IDOR candidates.
 */

import type { CapturedRequest, InjectionPoint, InjectionType } from "./types.js";

/** Pattern rules for detecting injection candidates. */
const INJECTION_RULES: {
  type: InjectionType;
  check: (param: ParamInfo) => string | null;
}[] = [
  // SQL Injection — params that look like they hit a database
  {
    type: "sqli",
    check: (p) => {
      const name = p.name.toLowerCase();
      const namePatterns = [
        "id", "user_id", "userid", "uid", "pid", "cid", "oid",
        "order", "sort", "filter", "where", "query", "search",
        "column", "table", "field", "limit", "offset", "page",
        "group", "having", "select",
      ];
      if (namePatterns.some((pat) => name === pat || name.endsWith(`_${pat}`))) {
        return `Parameter "${p.name}" likely used in database query`;
      }
      // Value looks like it could be SQL-injectable
      if (p.value.includes("'") || p.value.includes('"') || p.value.includes(";")) {
        return `Value contains SQL-relevant characters`;
      }
      return null;
    },
  },

  // XSS — params whose values might be reflected in HTML
  {
    type: "xss",
    check: (p) => {
      const name = p.name.toLowerCase();
      const namePatterns = [
        "name", "title", "description", "comment", "message",
        "content", "text", "body", "subject", "q", "search",
        "query", "keyword", "value", "label", "note", "bio",
        "url", "redirect", "callback", "return", "next",
      ];
      if (namePatterns.some((pat) => name === pat || name.includes(pat))) {
        return `Parameter "${p.name}" likely reflected in response`;
      }
      // Check if value contains HTML-like content
      if (/<[a-z]|[&<>"']/i.test(p.value)) {
        return `Value contains HTML entities or tags`;
      }
      return null;
    },
  },

  // SSRF — params containing URLs or hostnames
  {
    type: "ssrf",
    check: (p) => {
      const name = p.name.toLowerCase();
      const namePatterns = [
        "url", "uri", "link", "href", "src", "source", "target",
        "dest", "destination", "redirect", "proxy", "host",
        "endpoint", "callback", "webhook", "fetch", "load",
        "image", "img", "file", "path", "resource",
      ];
      if (namePatterns.some((pat) => name === pat || name.includes(pat))) {
        return `Parameter "${p.name}" may control server-side URL fetch`;
      }
      // Value is a URL
      if (/^https?:\/\//.test(p.value) || /^\/\//.test(p.value)) {
        return `Value is a URL — potential SSRF target`;
      }
      return null;
    },
  },

  // SSTI — params that might hit template engines
  {
    type: "ssti",
    check: (p) => {
      const name = p.name.toLowerCase();
      if (["template", "tpl", "layout", "view", "render", "format"].includes(name)) {
        return `Parameter "${p.name}" may control template rendering`;
      }
      // Check for template syntax in value
      if (/\{\{|\$\{|<%|#\{/.test(p.value)) {
        return `Value contains template syntax markers`;
      }
      return null;
    },
  },

  // Command Injection — params that might reach system commands
  {
    type: "cmdi",
    check: (p) => {
      const name = p.name.toLowerCase();
      if (
        ["cmd", "command", "exec", "run", "process", "shell", "ping", "host", "ip", "domain"].includes(name)
      ) {
        return `Parameter "${p.name}" may be passed to system command`;
      }
      // Pipe/semicolon in value
      if (/[|;`$()]/.test(p.value)) {
        return `Value contains shell metacharacters`;
      }
      return null;
    },
  },

  // LFI — params that reference file paths
  {
    type: "lfi",
    check: (p) => {
      const name = p.name.toLowerCase();
      if (
        ["file", "filename", "path", "filepath", "include", "page", "doc", "document", "template", "dir", "folder"].includes(name)
      ) {
        return `Parameter "${p.name}" may reference a file path`;
      }
      // Value looks like a path
      if (/^[./]|\.\.\/|[a-z]:\\|\/etc\//i.test(p.value)) {
        return `Value contains file path patterns`;
      }
      return null;
    },
  },

  // HTML Injection — params reflected in HTML without proper encoding
  {
    type: "html_injection",
    check: (p) => {
      const name = p.name.toLowerCase();
      const namePatterns = [
        "name", "title", "comment", "message", "text", "description",
        "bio", "about", "content", "label", "value", "body", "summary",
        "note", "feedback",
      ];
      if (namePatterns.some((pat) => name === pat || name.includes(pat))) {
        return `Parameter "${p.name}" may be rendered in HTML without encoding`;
      }
      if (/[<>]|&lt;|&gt;|%3[cCeE]/.test(p.value)) {
        return `Value contains HTML-injectable characters`;
      }
      return null;
    },
  },

  // Open Redirect — params that control redirects
  {
    type: "open_redirect",
    check: (p) => {
      const name = p.name.toLowerCase();
      if (
        ["redirect", "redirect_uri", "redirect_url", "return", "return_url", "returnto", "next", "goto", "continue", "target", "rurl", "dest", "destination"].includes(name)
      ) {
        return `Parameter "${p.name}" controls redirect destination`;
      }
      return null;
    },
  },

  // Mass Assignment — writable object fields in POST/PUT/PATCH
  {
    type: "mass_assignment",
    check: (p) => {
      if (p.method !== "POST" && p.method !== "PUT" && p.method !== "PATCH") return null;
      if (p.location !== "body") return null;

      const name = p.name.toLowerCase();
      const sensitiveFields = [
        "role", "admin", "is_admin", "isadmin", "is_staff", "is_superuser",
        "permissions", "privilege", "level", "group", "status", "verified",
        "email_verified", "approved", "active", "disabled", "banned",
        "balance", "credits", "points", "price", "amount", "discount",
        "plan", "tier", "subscription",
      ];
      if (sensitiveFields.some((f) => name === f || name.includes(f))) {
        return `Sensitive field "${p.name}" writable via ${p.method} — potential mass assignment`;
      }
      return null;
    },
  },

  // IDOR — predictable/sequential IDs in params
  {
    type: "idor",
    check: (p) => {
      const name = p.name.toLowerCase();
      if (!/id$|_id$|^id$/.test(name)) return null;

      // Numeric ID (sequential, predictable)
      if (/^\d+$/.test(p.value)) {
        return `Numeric ID "${p.name}=${p.value}" — test with other values for IDOR`;
      }
      return null;
    },
  },
];

interface ParamInfo {
  name: string;
  value: string;
  location: "query" | "body" | "header" | "path" | "cookie";
  method: string;
}

/**
 * Find injection points from captured requests.
 */
export function findInjectionPoints(requests: CapturedRequest[]): InjectionPoint[] {
  const points = new Map<string, InjectionPoint>(); // dedup key → point

  for (const req of requests) {
    if (isStaticAsset(req.url)) continue;

    const params = extractAllParams(req);

    for (const param of params) {
      for (const rule of INJECTION_RULES) {
        const evidence = rule.check(param);
        if (evidence) {
          const key = `${rule.type}|${param.location}|${param.name}|${urlToTemplate(req.url)}`;

          if (!points.has(key)) {
            points.set(key, {
              url: req.url,
              method: req.method,
              param: param.name,
              location: param.location,
              types: [rule.type],
              evidence,
              requestId: req.id,
            });
          } else {
            const existing = points.get(key)!;
            if (!existing.types.includes(rule.type)) {
              existing.types.push(rule.type);
            }
          }
        }
      }
    }
  }

  // Sort by number of injection types (most concerning first)
  return Array.from(points.values()).sort(
    (a, b) => b.types.length - a.types.length
  );
}

/**
 * Extract all parameters from a request.
 */
function extractAllParams(req: CapturedRequest): ParamInfo[] {
  const params: ParamInfo[] = [];

  // Query params
  try {
    const url = new URL(req.url);
    for (const [name, value] of url.searchParams) {
      params.push({ name, value, location: "query", method: req.method });
    }

    // Path segments that look like values
    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if (/^\d+$/.test(seg) || /^[0-9a-f-]{32,}$/i.test(seg)) {
        const prevSeg = segments[i - 1] || "param";
        params.push({
          name: `${prevSeg}_id`,
          value: seg,
          location: "path",
          method: req.method,
        });
      }
    }
  } catch {}

  // Body params
  if (req.requestBody) {
    try {
      const body = JSON.parse(req.requestBody);
      if (typeof body === "object" && body !== null) {
        flattenObject(body, "", params, req.method);
      }
    } catch {
      try {
        const form = new URLSearchParams(req.requestBody);
        for (const [name, value] of form) {
          params.push({ name, value, location: "body", method: req.method });
        }
      } catch {}
    }
  }

  // Cookies
  const cookieHeader = req.requestHeaders.find(
    (h) => h.name.toLowerCase() === "cookie"
  );
  if (cookieHeader) {
    for (const pair of cookieHeader.value.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name) {
        params.push({
          name: name.trim(),
          value: rest.join("=").trim(),
          location: "cookie",
          method: req.method,
        });
      }
    }
  }

  // Notable headers
  for (const header of req.requestHeaders) {
    const name = header.name.toLowerCase();
    if (
      name === "referer" ||
      name === "origin" ||
      name === "x-forwarded-for" ||
      name === "x-forwarded-host" ||
      name.startsWith("x-custom")
    ) {
      params.push({
        name: header.name,
        value: header.value,
        location: "header",
        method: req.method,
      });
    }
  }

  return params;
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix: string,
  params: ParamInfo[],
  method: string
): void {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      params.push({ name, value: "", location: "body", method });
    } else if (typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value as Record<string, unknown>, name, params, method);
    } else {
      params.push({
        name,
        value: String(value),
        location: "body",
        method,
      });
    }
  }
}

function urlToTemplate(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const segments = url.pathname.split("/").map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return "{id}";
      if (/^[0-9a-f-]{32,}$/i.test(seg)) return "{uuid}";
      return seg;
    });
    return segments.join("/");
  } catch {
    return urlStr;
  }
}

function isStaticAsset(url: string): boolean {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return [
    "js", "css", "png", "jpg", "jpeg", "gif", "svg", "ico",
    "woff", "woff2", "ttf", "eot", "map", "webp",
  ].includes(ext || "");
}
