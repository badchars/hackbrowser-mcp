/**
 * Report Generator — create security assessment reports from all findings.
 */

import type {
  AccessFinding,
  InjectionPoint,
  Endpoint,
  AccessEntry,
  Container,
} from "../types/index.js";
import type { TestResult } from "./active-tester.js";
import type { CrawlResult } from "../browser/crawler.js";
import type { AuthStatus } from "../browser/auth-detector.js";

export interface ReportOptions {
  title: string;
  target: string;
  format: "markdown" | "html";
  includeEvidence: boolean;
  includeMatrix: boolean;
  severityFilter?: string[];
}

export interface ReportData {
  accessFindings: AccessFinding[];
  injectionPoints: InjectionPoint[];
  testResults: TestResult[];
  endpoints: Endpoint[];
  accessMatrix: AccessEntry[];
  containers: Container[];
  crawlResult?: CrawlResult;
  authStatuses: AuthStatus[];
  requestCount: number;
}

/** Remediation hints per vulnerability type. */
const REMEDIATION: Record<string, string> = {
  idor: "Implement proper authorization checks. Verify the requesting user has access to the referenced resource.",
  missing_authz: "Add authentication middleware to this endpoint. Return 401 for unauthenticated requests.",
  privilege_escalation: "Implement role-based access control (RBAC). Verify the user's role before allowing access.",
  mass_assignment: "Use allowlists for writable fields. Never bind user input directly to model attributes.",
  info_leak: "Review what data is returned per role. Implement field-level access control.",
  sqli: "Use parameterized queries / prepared statements. Never concatenate user input into SQL.",
  xss: "Encode output in HTML context. Use Content-Security-Policy headers. Sanitize input.",
  ssrf: "Validate and allowlist URLs. Block internal IP ranges (127.0.0.0/8, 169.254.0.0/16, 10.0.0.0/8).",
  ssti: "Avoid passing user input to template engines. Use sandboxed template rendering.",
  cmdi: "Avoid shell commands with user input. Use parameterized APIs instead of exec/system.",
  lfi: "Validate file paths against an allowlist. Block directory traversal sequences.",
  cors: "Configure CORS to only allow trusted origins. Never reflect arbitrary Origin headers.",
  csrf: "Implement CSRF tokens for state-changing requests. Use SameSite cookie attribute.",
  rate_limit: "Implement rate limiting (e.g., 100 req/min per IP). Use 429 Too Many Requests response.",
  open_redirect: "Validate redirect URLs against an allowlist. Don't allow arbitrary redirect targets.",
};

/** Generate a security assessment report. */
export function generateReport(data: ReportData, options: ReportOptions): string {
  if (options.format === "html") {
    return wrapHtml(options.title, generateMarkdown(data, options));
  }
  return generateMarkdown(data, options);
}

function generateMarkdown(data: ReportData, options: ReportOptions): string {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  // ─── Header ───
  w(`# ${options.title}`);
  w("");
  w(`**Target:** ${options.target}`);
  w(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  w(`**Tool:** HackBrowser MCP v0.1.0`);
  w("");

  // ─── Executive Summary ───
  w("## Executive Summary");
  w("");

  const severityCounts = countSeverity(data);
  const totalFindings = Object.values(severityCounts).reduce((a, b) => a + b, 0);

  w(`| Severity | Count |`);
  w(`|----------|-------|`);
  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    if (severityCounts[sev] > 0) {
      w(`| ${sev.toUpperCase()} | ${severityCounts[sev]} |`);
    }
  }
  w("");

  w(`- **${data.containers.length}** containers (roles) tested`);
  w(`- **${data.requestCount}** HTTP requests captured`);
  w(`- **${data.endpoints.length}** unique endpoints discovered`);
  if (data.crawlResult) {
    w(`- **${data.crawlResult.pagesVisited}** pages crawled`);
    w(`- **${data.crawlResult.formsFound.length}** forms found`);
  }
  w(`- **${totalFindings}** total findings`);
  w("");

  // ─── Methodology ───
  w("## Methodology");
  w("");
  w("### Containers");
  w("");
  w("| Container | Role | Authenticated |");
  w("|-----------|------|---------------|");
  for (const c of data.containers) {
    const auth = data.authStatuses.find((a) => a.containerId === c.id);
    w(`| ${c.name} | ${c.role} | ${auth?.authenticated ? "Yes" : "No"} |`);
  }
  w("");

  // ─── Findings ───
  const filteredFindings = options.severityFilter
    ? data.accessFindings.filter((f) => options.severityFilter!.includes(f.severity))
    : data.accessFindings;

  const confirmedVulns = data.testResults.filter((t) => t.vulnerable);

  if (filteredFindings.length > 0 || confirmedVulns.length > 0) {
    w("## Findings");
    w("");

    // Confirmed vulnerabilities first
    if (confirmedVulns.length > 0) {
      w("### Confirmed Vulnerabilities");
      w("");
      for (let i = 0; i < confirmedVulns.length; i++) {
        const t = confirmedVulns[i];
        const sev = t.confidence === "high" ? "HIGH" : t.confidence === "medium" ? "MEDIUM" : "LOW";
        w(`#### ${i + 1}. [${sev}] ${t.type.toUpperCase()} — ${t.endpoint}`);
        w("");
        w(`- **Type:** ${t.type}`);
        w(`- **Method:** ${t.method}`);
        w(`- **Confidence:** ${t.confidence}`);
        w(`- **Evidence:** ${t.evidence}`);
        if (t.payload) w(`- **Payload:** \`${t.payload}\``);
        w("");

        if (options.includeEvidence && t.response) {
          w("```");
          w(`HTTP ${t.response.status}`);
          w(t.response.bodySnippet);
          w("```");
          w("");
        }

        const rem = REMEDIATION[t.type];
        if (rem) w(`**Remediation:** ${rem}`);
        w("");
      }
    }

    // Access control findings
    if (filteredFindings.length > 0) {
      w("### Access Control Issues");
      w("");

      // Sort by severity
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      const sorted = [...filteredFindings].sort(
        (a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5)
      );

      for (let i = 0; i < sorted.length; i++) {
        const f = sorted[i];
        w(`#### ${i + 1}. [${f.severity.toUpperCase()}] ${f.type} — ${f.endpoint}`);
        w("");
        w(`- **Type:** ${f.type}`);
        w(`- **Method:** ${f.method}`);
        w(`- **Description:** ${f.description}`);
        w("");

        if (options.includeEvidence && f.containers.length > 0) {
          w("| Container | Role | Status | Response |");
          w("|-----------|------|--------|----------|");
          for (const c of f.containers) {
            w(`| ${c.containerId.slice(0, 8)}... | ${c.role} | ${c.status} | ${(c.responseSnippet || "").slice(0, 50)} |`);
          }
          w("");
        }

        const rem = REMEDIATION[f.type];
        if (rem) w(`**Remediation:** ${rem}`);
        w("");
      }
    }
  }

  // ─── Injection Points ───
  const untestedPoints = data.injectionPoints.filter(
    (p) => !data.testResults.some((t) => t.endpoint === p.url && (p.types as string[]).includes(t.type))
  );

  if (untestedPoints.length > 0) {
    w("## Potential Injection Points (Untested)");
    w("");
    w("| # | Type | Method | Endpoint | Param | Location |");
    w("|---|------|--------|----------|-------|----------|");
    for (let i = 0; i < Math.min(untestedPoints.length, 50); i++) {
      const p = untestedPoints[i];
      w(`| ${i + 1} | ${p.types.join(",")} | ${p.method} | ${p.url.slice(0, 60)} | ${p.param} | ${p.location} |`);
    }
    if (untestedPoints.length > 50) {
      w(`\n*...and ${untestedPoints.length - 50} more*`);
    }
    w("");
  }

  // ─── Access Matrix ───
  if (options.includeMatrix && data.accessMatrix.length > 0) {
    w("## Access Control Matrix");
    w("");

    const roles = data.containers.map((c) => c.role || c.name);
    const header = `| Endpoint | Method | ${roles.join(" | ")} |`;
    const sep = `|----------|--------|${roles.map(() => "---").join("|")}|`;
    w(header);
    w(sep);

    for (const entry of data.accessMatrix.slice(0, 100)) {
      const cells = data.containers.map((c) => {
        const r = entry.results[c.id];
        return r ? `${r.status}${r.accessible ? " ✓" : " ✗"}` : "-";
      });
      w(`| ${entry.endpoint.slice(0, 40)} | ${entry.method} | ${cells.join(" | ")} |`);
    }
    w("");
  }

  // ─── API Surface ───
  if (data.endpoints.length > 0) {
    w("## Discovered API Surface");
    w("");
    w(`| # | Endpoint | Methods | Params |`);
    w(`|---|----------|---------|--------|`);
    for (let i = 0; i < Math.min(data.endpoints.length, 50); i++) {
      const ep = data.endpoints[i];
      const params = ep.params.map((p) => `${p.name}(${p.location})`).join(", ");
      w(`| ${i + 1} | ${ep.urlTemplate.slice(0, 50)} | ${ep.methods.join(",")} | ${params.slice(0, 40)} |`);
    }
    w("");
  }

  // ─── Footer ───
  w("---");
  w("");
  w("*Generated by HackBrowser MCP — Multi-container browser security testing tool*");

  return lines.join("\n");
}

function countSeverity(data: ReportData): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  for (const f of data.accessFindings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  for (const t of data.testResults) {
    if (!t.vulnerable) continue;
    const sev = t.confidence === "high" ? "high" : t.confidence === "medium" ? "medium" : "low";
    counts[sev] = (counts[sev] || 0) + 1;
  }

  return counts;
}

function wrapHtml(title: string, markdown: string): string {
  // Simple markdown → HTML (headers, tables, code blocks, bold)
  let html = markdown
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^---$/gm, "<hr>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^```$/gm, "")
    .replace(/^\|.+\|$/gm, (line) => {
      if (line.includes("---")) return "";
      const cells = line.split("|").filter(Boolean).map((c) => c.trim());
      const tag = line.includes("**") ? "th" : "td";
      return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    });

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #e0e0e0; }
h1,h2,h3,h4 { color: #fff; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; }
td,th { border: 1px solid #333; padding: 6px 10px; text-align: left; font-size: 13px; }
th { background: #16213e; }
code { background: #16213e; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
pre { background: #16213e; padding: 12px; border-radius: 6px; overflow-x: auto; }
hr { border: 1px solid #333; margin: 20px 0; }
li { margin: 4px 0; }
</style>
</head><body>${html}</body></html>`;
}
