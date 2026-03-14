/**
 * Crawler — BFS site spider with link/form/API endpoint discovery.
 */

import type { IProtocolClient } from "./protocol.js";
import type { ContainerManager } from "./container-manager.js";
import type { NetworkInterceptor } from "../capture/network-interceptor.js";

export interface CrawlOptions {
  startUrl: string;
  containerId: string;
  maxDepth: number;
  maxPages: number;
  scopePattern?: string;
  fillForms: boolean;
  followRedirects: boolean;
  excludePatterns: string[];
}

export interface CrawlResult {
  pagesVisited: number;
  urlsDiscovered: string[];
  formsFound: FormInfo[];
  apiEndpoints: string[];
  errors: { url: string; error: string }[];
  duration: number;
}

export interface FormInfo {
  url: string;
  action: string;
  method: string;
  fields: { name: string; type: string; required: boolean }[];
}

/** Default URL patterns to exclude from crawling. */
const DEFAULT_EXCLUDE = [
  /logout/i, /signout/i, /sign.out/i, /log.out/i,
  /delete/i, /remove/i, /destroy/i, /unsubscribe/i,
  /reset/i, /deactivate/i,
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|css|js|map|pdf|zip|gz)(\?|$)/i,
  /#/,
  /^javascript:/i, /^mailto:/i, /^tel:/i, /^data:/i,
];

export class Crawler {
  private lastResult: CrawlResult | null = null;
  private crawling = false;

  constructor(
    private client: IProtocolClient,
    private containerManager: ContainerManager,
    private interceptor: NetworkInterceptor,
  ) {}

  get isCrawling(): boolean { return this.crawling; }
  get result(): CrawlResult | null { return this.lastResult; }

  async crawl(options: CrawlOptions): Promise<CrawlResult> {
    if (this.crawling) throw new Error("Crawl already in progress");
    this.crawling = true;

    const start = Date.now();
    const visited = new Set<string>();
    const discovered = new Set<string>();
    const forms: FormInfo[] = [];
    const apiEndpoints = new Set<string>();
    const errors: { url: string; error: string }[] = [];

    // Build scope checker
    const origin = new URL(options.startUrl).origin;
    const scopeRegex = options.scopePattern
      ? new RegExp(options.scopePattern, "i")
      : null;

    const excludeRegexes = [
      ...DEFAULT_EXCLUDE,
      ...options.excludePatterns.map((p) => new RegExp(p, "i")),
    ];

    function isInScope(url: string): boolean {
      try {
        const u = new URL(url);
        if (scopeRegex) return scopeRegex.test(url);
        return u.origin === origin;
      } catch { return false; }
    }

    function isExcluded(url: string): boolean {
      return excludeRegexes.some((re) => re.test(url));
    }

    function normalizeUrl(url: string): string {
      try {
        const u = new URL(url);
        u.hash = "";
        return u.href;
      } catch { return url; }
    }

    // BFS queue: [url, depth]
    const queue: [string, number][] = [[normalizeUrl(options.startUrl), 0]];
    discovered.add(normalizeUrl(options.startUrl));

    // Get or create tab in the container
    const contextId = await this.containerManager.getOrCreateTab(options.containerId);

    // Enable interception for this context
    this.interceptor.mapContextToContainer(contextId, options.containerId);
    await this.interceptor.enableForContext(contextId);
    await this.containerManager.enableHeaderInjection(contextId);

    try {
      while (queue.length > 0 && visited.size < options.maxPages) {
        const [url, depth] = queue.shift()!;
        if (visited.has(url)) continue;
        if (depth > options.maxDepth) continue;

        visited.add(url);

        try {
          // Navigate
          await this.client.navigate(contextId, url, "complete");

          // Wait a bit for dynamic content
          await new Promise((r) => setTimeout(r, 500));

          // Extract links
          const links = await this.extractLinks(contextId);
          for (const link of links) {
            const normalized = normalizeUrl(link);
            if (!discovered.has(normalized) && isInScope(normalized) && !isExcluded(normalized)) {
              discovered.add(normalized);
              if (depth + 1 <= options.maxDepth) {
                queue.push([normalized, depth + 1]);
              }
            }
          }

          // Extract forms
          const pageForms = await this.extractForms(contextId, url);
          forms.push(...pageForms);

          // Extract API endpoints from inline JS
          const jsEndpoints = await this.extractJsEndpoints(contextId);
          for (const ep of jsEndpoints) {
            if (isInScope(ep)) apiEndpoints.add(ep);
          }

        } catch (err) {
          errors.push({ url, error: (err as Error).message });
        }
      }

      // Also collect API endpoints from network capture (XHR/fetch requests)
      const capturedRequests = this.interceptor.getRequests({ containerId: options.containerId });
      for (const req of capturedRequests) {
        if (isInScope(req.url) && /json|xml|graphql/i.test(req.mimeType)) {
          apiEndpoints.add(req.url.split("?")[0]); // strip query params
        }
      }
    } finally {
      this.crawling = false;
    }

    this.lastResult = {
      pagesVisited: visited.size,
      urlsDiscovered: [...discovered],
      formsFound: forms,
      apiEndpoints: [...apiEndpoints],
      errors,
      duration: Date.now() - start,
    };

    return this.lastResult;
  }

  /** Extract all links from the current page. */
  private async extractLinks(contextId: string): Promise<string[]> {
    try {
      const result = await this.client.evaluate(contextId, `(() => {
        const links = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          try { links.add(new URL(a.href, location.origin).href); } catch {}
        });
        document.querySelectorAll('form[action]').forEach(f => {
          try { links.add(new URL(f.action, location.origin).href); } catch {}
        });
        document.querySelectorAll('[data-href], [data-url]').forEach(el => {
          var u = el.getAttribute('data-href') || el.getAttribute('data-url');
          if (u) try { links.add(new URL(u, location.origin).href); } catch {}
        });
        return [...links];
      })()`);
      return Array.isArray(result) ? result.filter((r): r is string => typeof r === "string") : [];
    } catch { return []; }
  }

  /** Extract forms from the current page. */
  private async extractForms(contextId: string, pageUrl: string): Promise<FormInfo[]> {
    try {
      const result = await this.client.evaluate(contextId, `(() => {
        return Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action || location.href,
          method: (f.method || 'GET').toUpperCase(),
          fields: Array.from(f.querySelectorAll('input, select, textarea')).map(inp => ({
            name: inp.name || '',
            type: inp.type || inp.tagName.toLowerCase(),
            required: inp.required || false,
          })).filter(f => f.name),
        }));
      })()`);

      if (!Array.isArray(result)) return [];
      return result.map((f: any) => ({
        url: pageUrl,
        action: f.action || pageUrl,
        method: f.method || "GET",
        fields: Array.isArray(f.fields) ? f.fields : [],
      }));
    } catch { return []; }
  }

  /** Extract API endpoints from inline JavaScript. */
  private async extractJsEndpoints(contextId: string): Promise<string[]> {
    try {
      const result = await this.client.evaluate(contextId, `(() => {
        var endpoints = new Set();
        var patterns = [
          /fetch\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g,
          /axios\\.\\w+\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g,
          /['"\`](\\/api\\/[^'"\`\\s]+)['"\`]/g,
          /['"\`](\\/v[1-9]\\/[^'"\`\\s]+)['"\`]/g,
          /['"\`](\\/graphql[^'"\`\\s]*)['"\`]/g,
          /\\.(?:get|post|put|patch|delete)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g,
        ];
        document.querySelectorAll('script:not([src])').forEach(function(s) {
          for (var i = 0; i < patterns.length; i++) {
            var pat = patterns[i]; pat.lastIndex = 0;
            var m;
            while ((m = pat.exec(s.textContent)) !== null) {
              var url = m[1];
              try { endpoints.add(new URL(url, location.origin).href); }
              catch { if (url.startsWith('/')) endpoints.add(location.origin + url); }
            }
          }
        });
        return [...endpoints];
      })()`);
      return Array.isArray(result) ? result.filter((r): r is string => typeof r === "string") : [];
    } catch { return []; }
  }
}
