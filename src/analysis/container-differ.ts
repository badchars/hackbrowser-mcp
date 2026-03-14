/**
 * Container Differ — compares access patterns across containers.
 *
 * Finds endpoints where different roles get different responses,
 * indicating potential access control issues.
 */

import type { CapturedRequest, AccessFinding, Endpoint } from "./types.js";
import type { Container } from "../types/index.js";

interface DiffResult {
  endpoint: string;
  method: string;
  responses: {
    containerId: string;
    role: string;
    status: number;
    bodySize: number;
    bodyHash: string;
    bodySnippet: string;
  }[];
}

/**
 * Compare access between two or more containers.
 * Returns findings where access differs.
 */
export function compareAccess(
  requests: CapturedRequest[],
  containers: Container[],
  endpoints?: Endpoint[]
): AccessFinding[] {
  // Group requests by endpoint (URL template + method)
  const endpointMap = groupByEndpoint(requests);
  const findings: AccessFinding[] = [];

  for (const [key, containerRequests] of endpointMap) {
    const [method, urlTemplate] = key.split("|", 2);
    const containerIds = new Set(Object.keys(containerRequests));

    // Need at least 2 containers to compare
    if (containerIds.size < 2) continue;

    const responses = [];
    for (const [containerId, reqs] of Object.entries(containerRequests)) {
      const container = containers.find(
        (c) => c.id === containerId || c.cookieStoreId === containerId
      );
      const role = container?.role || containerId;

      // Use the most recent request for comparison
      const req = reqs[reqs.length - 1];
      responses.push({
        containerId,
        role,
        status: req.status,
        bodySize: req.responseBodySize,
        bodyHash: simpleHash(req.responseBody || ""),
        bodySnippet: (req.responseBody || "").slice(0, 200),
      });
    }

    // Detect access control issues
    const finding = analyzeDiff(method, urlTemplate, responses);
    if (finding) {
      findings.push(finding);
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return findings;
}

/**
 * Analyze differences between container responses for a single endpoint.
 */
function analyzeDiff(
  method: string,
  endpoint: string,
  responses: {
    containerId: string;
    role: string;
    status: number;
    bodySize: number;
    bodyHash: string;
    bodySnippet: string;
  }[]
): AccessFinding | null {
  const statuses = responses.map((r) => r.status);
  const uniqueStatuses = new Set(statuses);

  // All same status — check body differences
  if (uniqueStatuses.size === 1) {
    const bodyHashes = new Set(responses.map((r) => r.bodyHash));
    if (bodyHashes.size <= 1) return null; // Identical responses

    // Same status but different bodies — potential info leak or IDOR
    const bodySizes = responses.map((r) => r.bodySize);
    const maxDiff = Math.max(...bodySizes) - Math.min(...bodySizes);

    if (maxDiff > 100) {
      return {
        type: "info_leak",
        severity: "medium",
        endpoint,
        method,
        description: `Same ${statuses[0]} status but different response bodies (size diff: ${maxDiff} bytes). One role may see more data than another.`,
        containers: responses.map((r) => ({
          containerId: r.containerId,
          role: r.role,
          status: r.status,
          responseSnippet: r.bodySnippet,
        })),
      };
    }

    return null;
  }

  // Different statuses — classify the finding
  const hasSuccess = statuses.some((s) => s >= 200 && s < 300);
  const hasForbidden = statuses.some((s) => s === 403 || s === 401);
  const hasNotFound = statuses.some((s) => s === 404);
  const hasRedirect = statuses.some((s) => s >= 300 && s < 400);

  // Successful access from unexpected role → missing authorization
  if (hasSuccess && hasForbidden) {
    const successRoles = responses.filter((r) => r.status >= 200 && r.status < 300);
    const deniedRoles = responses.filter((r) => r.status === 403 || r.status === 401);

    // Check if a lower-privilege role has success (IDOR / privilege escalation)
    const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

    return {
      type: isWriteMethod ? "privilege_escalation" : "missing_authz",
      severity: isWriteMethod ? "high" : "medium",
      endpoint,
      method,
      description: `${successRoles.map((r) => r.role).join(", ")} can access (${successRoles[0].status}) but ${deniedRoles.map((r) => r.role).join(", ")} gets ${deniedRoles[0].status}. ${isWriteMethod ? "Write operation — potential privilege escalation." : "Verify if this access difference is intended."}`,
      containers: responses.map((r) => ({
        containerId: r.containerId,
        role: r.role,
        status: r.status,
        responseSnippet: r.bodySnippet,
      })),
    };
  }

  // Guest gets 200, authenticated gets redirect → possible auth bypass
  if (hasSuccess && hasRedirect) {
    return {
      type: "missing_authz",
      severity: "low",
      endpoint,
      method,
      description: `Different redirect behavior across roles. Some roles get ${statuses.filter((s) => s >= 200 && s < 300).join("/")} while others get redirected (${statuses.filter((s) => s >= 300 && s < 400).join("/")}).`,
      containers: responses.map((r) => ({
        containerId: r.containerId,
        role: r.role,
        status: r.status,
        responseSnippet: r.bodySnippet,
      })),
    };
  }

  // 404 for some, 200/403 for others — object-level authorization
  if (hasNotFound && (hasSuccess || hasForbidden)) {
    return {
      type: "idor",
      severity: "medium",
      endpoint,
      method,
      description: `Different visibility: some roles get content (${statuses.filter((s) => s !== 404).join("/")}) while others get 404. May indicate object-level access control differences.`,
      containers: responses.map((r) => ({
        containerId: r.containerId,
        role: r.role,
        status: r.status,
        responseSnippet: r.bodySnippet,
      })),
    };
  }

  // Generic difference
  return {
    type: "missing_authz",
    severity: "info",
    endpoint,
    method,
    description: `Different response statuses across roles: ${responses.map((r) => `${r.role}=${r.status}`).join(", ")}`,
    containers: responses.map((r) => ({
      containerId: r.containerId,
      role: r.role,
      status: r.status,
      responseSnippet: r.bodySnippet,
    })),
  };
}

/**
 * Group requests by endpoint template + method, then by container.
 */
function groupByEndpoint(
  requests: CapturedRequest[]
): Map<string, Record<string, CapturedRequest[]>> {
  const map = new Map<string, Record<string, CapturedRequest[]>>();

  for (const req of requests) {
    if (isStaticAsset(req.url)) continue;

    const template = urlToTemplate(req.url);
    const key = `${req.method}|${template}`;

    if (!map.has(key)) {
      map.set(key, {});
    }

    const byContainer = map.get(key)!;
    if (!byContainer[req.containerId]) {
      byContainer[req.containerId] = [];
    }
    byContainer[req.containerId].push(req);
  }

  return map;
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

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
