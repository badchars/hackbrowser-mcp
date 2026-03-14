/**
 * Access Matrix — generates a role × endpoint matrix.
 *
 * Each cell shows the HTTP status code and whether the role can access that endpoint.
 * Similar to Burp AuthMatrix.
 */

import type { CapturedRequest, AccessEntry, AccessResult } from "./types.js";
import type { Container } from "../types/index.js";

/**
 * Generate an access matrix from captured requests.
 */
export function generateAccessMatrix(
  requests: CapturedRequest[],
  containers: Container[]
): AccessEntry[] {
  const matrix = new Map<string, AccessEntry>();

  for (const req of requests) {
    if (isStaticAsset(req.url)) continue;

    const template = urlToTemplate(req.url);
    const key = `${req.method}|${template}`;

    if (!matrix.has(key)) {
      matrix.set(key, {
        endpoint: template,
        method: req.method,
        results: {},
      });
    }

    const entry = matrix.get(key)!;
    const container = containers.find(
      (c) => c.id === req.containerId || c.cookieStoreId === req.containerId
    );
    const roleKey = container?.role || req.containerId;

    // Keep the most recent result for this role
    entry.results[roleKey] = {
      status: req.status,
      responseSize: req.responseBodySize,
      accessible: req.status >= 200 && req.status < 400,
    };
  }

  // Calculate response similarity between containers
  for (const entry of matrix.values()) {
    const results = Object.values(entry.results);
    if (results.length < 2) continue;

    // Use the first container as reference
    const reference = results[0];
    for (let i = 1; i < results.length; i++) {
      results[i].responseSimilarity = calculateSimilarity(reference, results[i]);
    }
  }

  return Array.from(matrix.values()).sort((a, b) => {
    // Sort by method priority, then by endpoint
    const methodOrder: Record<string, number> = {
      GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4,
    };
    const ma = methodOrder[a.method] ?? 5;
    const mb = methodOrder[b.method] ?? 5;
    if (ma !== mb) return ma - mb;
    return a.endpoint.localeCompare(b.endpoint);
  });
}

/**
 * Format access matrix as a readable table string.
 */
export function formatAccessMatrix(
  entries: AccessEntry[],
  containers: Container[]
): string {
  if (entries.length === 0) return "No endpoints captured.";

  const roles = containers.map((c) => c.role);
  const header = ["Method", "Endpoint", ...roles].join(" | ");
  const separator = header.replace(/[^|]/g, "-");

  const rows = entries.map((entry) => {
    const cells = [
      entry.method.padEnd(6),
      entry.endpoint.slice(0, 60).padEnd(60),
      ...roles.map((role) => {
        const result = entry.results[role];
        if (!result) return "  -  ";
        const status = String(result.status).padStart(3);
        const icon = result.accessible ? "+" : "x";
        return `${status} ${icon}`;
      }),
    ];
    return cells.join(" | ");
  });

  return [header, separator, ...rows].join("\n");
}

/**
 * Find entries in the matrix where access differs between roles.
 */
export function findAccessDifferences(entries: AccessEntry[]): AccessEntry[] {
  return entries.filter((entry) => {
    const results = Object.values(entry.results);
    if (results.length < 2) return false;

    // Check if statuses differ
    const statuses = new Set(results.map((r) => r.status));
    if (statuses.size > 1) return true;

    // Check if accessibility differs
    const access = new Set(results.map((r) => r.accessible));
    if (access.size > 1) return true;

    // Check if response sizes differ significantly
    const sizes = results.map((r) => r.responseSize);
    const maxSize = Math.max(...sizes);
    const minSize = Math.min(...sizes);
    if (maxSize > 0 && (maxSize - minSize) / maxSize > 0.2) return true;

    return false;
  });
}

function calculateSimilarity(a: AccessResult, b: AccessResult): number {
  // Simple similarity score based on status and size
  let score = 0;

  if (a.status === b.status) score += 0.5;
  else if (Math.floor(a.status / 100) === Math.floor(b.status / 100)) score += 0.2;

  if (a.responseSize > 0 && b.responseSize > 0) {
    const sizeRatio = Math.min(a.responseSize, b.responseSize) / Math.max(a.responseSize, b.responseSize);
    score += sizeRatio * 0.5;
  } else if (a.responseSize === 0 && b.responseSize === 0) {
    score += 0.5;
  }

  return Math.round(score * 100) / 100;
}

function urlToTemplate(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const segments = url.pathname.split("/").map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
        return "{uuid}";
      if (/^\d+$/.test(seg)) return "{id}";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return "{hash}";
      return seg;
    });
    return `${url.origin}${segments.join("/")}`;
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
