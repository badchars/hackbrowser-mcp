<p align="center">
  <br>
  <pre align="center">
    ██╗  ██╗ █████╗  ██████╗██╗  ██╗██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗███████╗██████╗
    ██║  ██║██╔══██╗██╔════╝██║ ██╔╝██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔════╝██╔══██╗
    ███████║███████║██║     █████╔╝ ██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗█████╗  ██████╔╝
    ██╔══██║██╔══██║██║     ██╔═██╗ ██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║██╔══╝  ██╔══██╗
    ██║  ██║██║  ██║╚██████╗██║  ██╗██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝███████║███████╗██║  ██║
    ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝
  </pre>
</p>

<h3 align="center">The first browser MCP built for security testing.</h3>

<p align="center">
  Other browser MCPs let your AI fill forms and take screenshots.<br>
  This one lets it <b>find vulnerabilities</b>.
</p>

<br>

<p align="center">
  <a href="#what-it-does">What It Does</a> &bull;
  <a href="#how-its-different">How It's Different</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#workflow-examples">Examples</a> &bull;
  <a href="#tools-reference-39-tools">Tools</a> &bull;
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun">
  <img src="https://img.shields.io/badge/browser-Firefox-ff7139" alt="Firefox">
  <img src="https://img.shields.io/badge/protocol-MCP-8b5cf6" alt="MCP">
  <img src="https://img.shields.io/badge/tools-39-22c55e" alt="39 Tools">
  <img src="https://img.shields.io/badge/injection%20payloads-60%2B-ef4444" alt="60+ Payloads">
</p>

---

## What It Does

**hackbrowser-mcp** gives your AI agent a real Firefox browser and 39 security testing tools via the [Model Context Protocol](https://modelcontextprotocol.io). The agent can launch the browser, browse a target, capture all traffic, and test for vulnerabilities &mdash; all through natural language.

```
You: "Log in as admin and as a regular user. Find endpoints the user shouldn't access."

Agent: → launches Firefox
       → creates two isolated containers (admin + user)
       → logs in both accounts
       → browses the app, captures traffic
       → compares responses across roles
       → "User can access GET /api/admin/users — should return 403, returns 200"
```

The AI handles the entire workflow: launching the browser, managing sessions, discovering endpoints, testing parameters, and generating a security report. You describe what to test. It does the rest.

---

## How It's Different

There are dozens of browser MCPs. They all do the same thing: let an LLM navigate pages, click buttons, and extract text. They're built for **automation** &mdash; filling forms, scraping data, running UI tests.

**None of them can test for vulnerabilities.** That's the gap hackbrowser-mcp fills.

<table>
<thead>
<tr>
<th></th>
<th>Other Browser MCPs</th>
<th>hackbrowser-mcp</th>
</tr>
</thead>
<tbody>
<tr>
<td><b>Purpose</b></td>
<td>Web automation, scraping, form filling</td>
<td>Security testing, vulnerability assessment</td>
</tr>
<tr>
<td><b>Sessions</b></td>
<td>Single session</td>
<td>2-4 isolated containers with separate cookies, storage, and auth</td>
</tr>
<tr>
<td><b>Traffic</b></td>
<td>Read-only network tab (if any)</td>
<td>Full HAR capture + replay with modifications</td>
</tr>
<tr>
<td><b>Security tools</b></td>
<td>None</td>
<td>14 tools: injection testing, CSRF, IDOR, access matrix, report generation</td>
</tr>
<tr>
<td><b>Injection testing</b></td>
<td>Not possible</td>
<td>7 types, 60+ payloads, technique-labeled results</td>
</tr>
<tr>
<td><b>Access control</b></td>
<td>Not possible</td>
<td>Cross-role comparison, endpoint access matrix, IDOR detection</td>
</tr>
<tr>
<td><b>Browser</b></td>
<td>Chromium (CDP)</td>
<td>Firefox (WebDriver BiDi) &mdash; different engine catches different bugs</td>
</tr>
<tr>
<td><b>Anti-detection</b></td>
<td>Varies</td>
<td>Stealth mode built-in (fingerprint, UA, WebGL spoofing)</td>
</tr>
</tbody>
</table>

<br>

<details>
<summary>Specific comparisons with popular projects</summary>

<br>

| Project | Stars | What it does | What it can't do |
|---|---|---|---|
| [playwright-mcp](https://github.com/microsoft/playwright-mcp) | 29k | Navigate, click, type, screenshot via accessibility tree | No multi-session, no traffic capture, no security testing |
| [browser-use](https://github.com/browser-use/browser-use) | 81k | AI completes web tasks (shopping, forms, research) | Single agent action, no HAR, no injection testing |
| [stagehand](https://github.com/browserbase/stagehand) | 22k | act/extract/observe SDK for browser automation | No security tools, no container isolation |
| [chrome-devtools-mcp](https://github.com/nichochar/chrome-devtools-mcp) | 29k | DevTools debugging, performance analysis, network monitoring | Read-only network, no replay, no active testing |
| [browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) | 7k | Console, network, audit monitoring for coding agents | IDE-focused, no offensive testing capability |
| [mcp-playwright](https://github.com/executeautomation/mcp-playwright) | 5k | Multi-browser test automation + scraping | No security awareness, no access control analysis |

All of these are excellent tools for their intended purpose. hackbrowser-mcp doesn't replace them &mdash; it serves a completely different use case.

</details>

---

## Core Capabilities

### Multi-Container Isolation

Run 2-4 browser sessions simultaneously, each with **completely isolated** state. This is the foundation for access control testing.

```
┌────────────────────────────────────────────────────────┐
│                     Firefox Instance                    │
├───────────────┬───────────────┬────────────────────────-┤
│  Container 1  │  Container 2  │  Container 3            │
│  role: admin  │  role: user   │  role: guest             │
│               │               │                         │
│  cookies: A   │  cookies: B   │  cookies: none          │
│  storage: A   │  storage: B   │  storage: none          │
│  session: ✓   │  session: ✓   │  session: ✗             │
└───────────────┴───────────────┴─────────────────────────┘

compare_access → "GET /api/admin/users returns 200 for user (expected 403)"
access_matrix  → role × endpoint grid showing every authorization gap
```

### Traffic Intelligence

Every HTTP request and response is captured, stored, and queryable. Replay any request with modifications.

```
Browser → Network Interceptor → In-Memory Store (10K max, FIFO)
                                       │
                             ┌─────────┴──────────┐
                             │                     │
                       Auto-save (60s)       Replay / modify
                             │                     │
                             ▼                     ▼
                       HAR file (disk)      replay_request
                             │              (change method,
                       Resume on restart     headers, body)
```

### Active Security Testing

Discover injection points from captured traffic, then test them with 60+ payloads across 7 vulnerability types.

| Type | Payloads | Techniques |
|------|----------|------------|
| **SQLi** | 9 | Error-based, union, time-based blind (MSSQL/MySQL/Postgres), boolean-blind |
| **XSS** | 8 | Reflected script, event handler, SVG, JS context, HTML5 events, iframe |
| **SSTI** | 8 | Jinja2, Freemarker, ERB, Angular sandbox, Spring EL, Vue |
| **SSRF** | 8 | Localhost variants (IPv4/v6/hex/octal), AWS/GCP/Azure metadata, DNS rebind |
| **CMDi** | 8 | Semicolon, pipe, backtick, subshell, newline, quote-break |
| **LFI** | 8 | Path traversal, double-dot, /proc/environ, PHP filter, double-encode |
| **HTML Injection** | 6 | Tag injection, form injection, style overlay, meta redirect |

When built-in payloads get blocked, the AI agent analyzes the WAF response and crafts custom bypass payloads using `replay_request`.

---

## Quick Start

### Install

```bash
git clone https://github.com/user/hackbrowser-mcp.git
cd hackbrowser-mcp
bun install
```

### Connect to your AI agent

<details>
<summary><b>Claude Desktop / Claude Code</b></summary>

Add to your MCP config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hackbrowser": {
      "command": "bun",
      "args": ["run", "/path/to/hackbrowser-mcp/src/index.ts", "--mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor / Continue / other MCP clients</b></summary>

Same config format. Point the command to your installation path.

</details>

<details>
<summary><b>Standalone (no AI agent)</b></summary>

```bash
bun run src/index.ts --launch              # GUI mode
bun run src/index.ts --launch --headless   # headless
bun run src/index.ts --mcp                 # MCP server (stdio)
```

</details>

### Start testing

```
You: "Launch the browser and scan https://target.com for vulnerabilities"
```

That's it. The agent handles the rest.

---

## Workflow Examples

### Full Security Scan

```
You: "Crawl https://app.com, find injection points, test them, generate a report."

Agent: browser_launch → navigate → crawl (100 pages)
       → find_injection_points → test_injection (SQLi, XSS)
       → test_csrf → test_rate_limit
       → generate_report
       → "Found 3 XSS, 1 SQLi, 2 missing CSRF tokens"
```

### IDOR / Access Control Audit

```
You: "Login as admin and regular user. Find what the user shouldn't access."

Agent: container_setup (admin + user) → container_login (both)
       → navigate admin pages → compare_access
       → access_matrix
       → "User can reach GET /api/admin/users (200 instead of 403)"
```

### WAF Bypass

```
You: "Test the search param for XSS. Bypass any WAF."

Agent: test_injection {types: ["xss"]} → all blocked
       → analyzes response: <script> stripped, events filtered
       → replay_request with <details/open/ontoggle=alert(1)> → REFLECTED
       → "Confirmed XSS via HTML5 ontoggle event bypass"
```

### Offline HAR Analysis

```
You: "Import this HAR file and find injection candidates."

Agent: import_har → get_endpoints (87 found)
       → find_injection_points (23 candidates)
       → test_injection → "2 reflected XSS confirmed"
```

---

## Tools Reference (39 tools)

<details>
<summary><b>Browser Control (3)</b></summary>

| Tool | Description |
|------|-------------|
| `browser_launch` | Launch Firefox with managed profile |
| `browser_close` | Close browser, auto-export HAR |
| `browser_status` | Protocol, containers, tab count, captured requests |

</details>

<details>
<summary><b>Containers (3)</b></summary>

| Tool | Description |
|------|-------------|
| `container_setup` | Create 1-4 containers with roles and credentials |
| `container_login` | Login for a container (programmatic or manual) |
| `container_list` | List containers with auth status |

</details>

<details>
<summary><b>Navigation (4)</b></summary>

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL in a container tab |
| `go_back` / `go_forward` | Browser history navigation |
| `wait_for` | Wait for selector, URL, network idle, or JS condition |

</details>

<details>
<summary><b>Interaction (7)</b></summary>

| Tool | Description |
|------|-------------|
| `click` | Click by CSS selector or text content |
| `type_text` | Type into input fields |
| `select_option` | Select dropdown value |
| `submit_form` | Submit a form |
| `scroll` | Scroll page or element |
| `hover` | Hover over element |
| `press_key` | Keyboard keys (Enter, Tab, Escape, etc.) |

</details>

<details>
<summary><b>Page Inspection (4)</b></summary>

| Tool | Description |
|------|-------------|
| `screenshot` | Capture PNG screenshot |
| `get_page_source` | Full HTML source |
| `get_dom_tree` | Simplified DOM tree (LLM-friendly) |
| `evaluate_js` | Execute JavaScript and return result |

</details>

<details>
<summary><b>Traffic Capture (5)</b></summary>

| Tool | Description |
|------|-------------|
| `get_requests` | List captured requests with filters (URL, method, status, MIME) |
| `get_response` | Full request/response details by ID |
| `get_endpoints` | Auto-discovered API endpoints with parameter templates |
| `export_har` | Save traffic as HAR 1.2 file |
| `import_har` | Load HAR from previous session |

</details>

<details>
<summary><b>Security Analysis (4)</b></summary>

| Tool | Description |
|------|-------------|
| `compare_access` | Cross-container IDOR / broken authorization detection |
| `access_matrix` | Role x endpoint access grid |
| `find_injection_points` | Identify injectable params across 10 vuln types |
| `replay_request` | Replay with modified method, headers, body, URL |

</details>

<details>
<summary><b>Active Testing (3)</b></summary>

| Tool | Description |
|------|-------------|
| `test_injection` | 7 types, 60+ payloads, technique-labeled results |
| `test_csrf` | Replay without CSRF tokens |
| `test_rate_limit` | Rapid-fire requests, check for 429 |

</details>

<details>
<summary><b>Auth Detection (3)</b></summary>

| Tool | Description |
|------|-------------|
| `detect_auth` | Check session validity |
| `detect_login_form` | Find login form fields and CSRF token |
| `auto_login` | Auto-fill and submit login |

</details>

<details>
<summary><b>Discovery (2)</b></summary>

| Tool | Description |
|------|-------------|
| `crawl` | BFS spider with form discovery and API extraction |
| `get_sitemap` | Return crawl results |

</details>

<details>
<summary><b>Reporting (1)</b></summary>

| Tool | Description |
|------|-------------|
| `generate_report` | Security report (markdown/HTML) with findings and evidence |

</details>

---

## Library Usage

Use hackbrowser-mcp as a TypeScript library for custom tooling:

```typescript
import {
  launchFirefox, closeFirefox,
  NetworkInterceptor, BrowserInteraction, Crawler,
  extractEndpoints, findInjectionPoints, testInjection,
  compareAccess, generateReport,
  buildHar, saveHar, loadHar,
} from "hackbrowser-mcp";
```

```typescript
// Offline HAR analysis
const har = await loadHar("./capture.har");
const requests = harEntriesToRequests(har.log.entries);
const endpoints = extractEndpoints(requests);
const points = findInjectionPoints(requests);

console.log(`${endpoints.length} endpoints, ${points.length} injection candidates`);
```

---

## Architecture

```
src/
├── browser/                 Firefox control
│   ├── bidi-client.ts       WebDriver BiDi protocol
│   ├── cdp-client.ts        CDP fallback
│   ├── launcher.ts          Binary detection + profile setup
│   ├── container-manager.ts Container isolation + extension WS
│   ├── interaction.ts       Click, type, scroll, hover
│   ├── crawler.ts           BFS spider
│   └── auth-detector.ts     Session detection
├── capture/                 Traffic
│   ├── network-interceptor.ts  Capture + auto-save (10K cap)
│   ├── har-builder.ts          HAR 1.2 builder
│   └── har-storage.ts          HAR I/O + merge
├── analysis/                Security engines
│   ├── active-tester.ts     60+ injection payloads
│   ├── injection-mapper.ts  Param → vuln type mapping
│   ├── endpoint-extractor.ts  API endpoint discovery
│   ├── container-differ.ts  Cross-role comparison
│   ├── access-matrix.ts     Role x endpoint matrix
│   └── report-generator.ts  Report formatting
├── protocol/
│   ├── tools.ts             39 tool definitions (Zod schemas)
│   └── mcp-server.ts        MCP stdio transport
└── types/                   TypeScript types
```

**Design decisions:**

- **Firefox + BiDi first** &mdash; Native Firefox protocol. Different rendering engine catches bugs Chrome-based tools miss. CDP available as fallback.
- **Container isolation** &mdash; Firefox Multi-Account Containers for true session separation. Not separate browser instances.
- **Server-side fetch for testing** &mdash; Active testing uses `fetch()` outside the browser to avoid polluting browser state.
- **HAR 1.2 standard** &mdash; Import/export for session continuity. Auto-save every 60s, resume on restart.
- **Memory-bounded** &mdash; 10K entry cap with FIFO eviction. 30s fetch timeout.
- **Stealth by default** &mdash; `navigator.webdriver`, UA, plugins, WebGL fingerprint all spoofed.

---

## Limitations

- Firefox only (container isolation requires Firefox Multi-Account Containers)
- macOS / Linux (Windows not tested)
- One Firefox instance per port
- WebSocket frames not captured (only upgrade request)

---

<p align="center">
<b>For authorized security testing only.</b><br>
Always obtain proper permission before testing any application.
</p>

<p align="center">
  <a href="LICENSE">MIT License</a> &bull; Built with Bun + TypeScript
</p>
