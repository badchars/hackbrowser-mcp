/**
 * Container Manager — manages isolated browser containers.
 *
 * Uses BiDi user contexts for cookie/storage isolation + network interception for headers.
 * Also runs a WS server that the Firefox extension connects to for visual UI
 * (colored container tabs, popup status, tab lifecycle).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IProtocolClient } from "./protocol.js";
import type { BiDiClient } from "./bidi-client.js";
import type { Container, ContainerColor, Credential, CookieEntry } from "../types/index.js";

export interface ContainerRole {
  name: string;
  role: string;
  color?: ContainerColor;
  credentials?: Credential;
}

export class ContainerManager {
  private client: IProtocolClient;
  private containers = new Map<string, Container>(); // userContextId → Container
  private containerCounter = 0;
  private contextToContainer = new Map<string, string>(); // browsingContextId → userContextId

  // Extension WS bridge
  private wss: WebSocketServer | null = null;
  private extensionWs: WebSocket | null = null;
  private wsPort: number;
  private extCommandId = 0;
  private extPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(client: IProtocolClient, wsPort: number = 9221) {
    this.client = client;
    this.wsPort = wsPort;
  }

  // ─── Extension WS Server ───

  /** Start the WS server for extension communication. */
  async startExtensionServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.wsPort, host: "127.0.0.1" });

      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.wsPort;
        this.wsPort = actualPort;
        console.error(`[container-mgr] Extension WS server on port ${actualPort}`);
        resolve(actualPort);
      });

      this.wss.on("connection", (ws, req) => {
        if (req.url !== "/extension") {
          ws.close();
          return;
        }

        console.error(`[container-mgr] Extension connected!`);
        this.extensionWs = ws;

        // Sync current container state to extension
        this.syncStateToExtension();

        ws.on("message", (data) => this.handleExtMessage(data.toString()));
        ws.on("close", () => {
          console.error(`[container-mgr] Extension disconnected`);
          this.extensionWs = null;
        });
        ws.on("error", (err) => {
          console.error(`[container-mgr] Extension WS error: ${err.message}`);
        });
      });

      this.wss.on("error", (err) => {
        reject(new Error(`Extension WS server failed: ${err.message}`));
      });
    });
  }

  /** Send the current container state to the extension. */
  private syncStateToExtension(): void {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) return;

    const state = this.listContainers().map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      color: c.color,
      authenticated: c.authenticated,
      tabCount: c.tabIds.length,
      hasHeaders: !!(c.credentials?.type === "headers"),
    }));

    this.extensionWs.send(JSON.stringify({
      event: "state_sync",
      data: { containers: state },
    }));
  }

  /** Send a command to the extension. */
  private async sendExtCommand(command: string, params: any): Promise<any> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return null; // Extension not connected, silently skip
    }

    const id = ++this.extCommandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.extPending.delete(id);
        resolve(null); // Don't fail if extension is slow
      }, 5_000);

      this.extPending.set(id, { resolve, reject, timer });
      this.extensionWs!.send(JSON.stringify({ id, command, params }));
    });
  }

  private handleExtMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    // Response to a command we sent
    if (typeof msg.id === "number" && this.extPending.has(msg.id)) {
      const { resolve, reject, timer } = this.extPending.get(msg.id)!;
      this.extPending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) { reject(new Error(msg.error)); }
      else { resolve(msg.result); }
      return;
    }

    // Command from extension popup (has id + command)
    if (typeof msg.id === "number" && msg.command) {
      this.handlePopupCommand(msg.id, msg.command, msg.params || {});
      return;
    }

    // Unsolicited event
    if (msg.event === "connected") {
      console.error(`[container-mgr] Extension reports ${msg.data?.containers?.length ?? 0} existing containers`);
    }
  }

  /** Handle commands that originate from the extension popup. */
  private async handlePopupCommand(id: number, command: string, params: any): Promise<void> {
    try {
      let result: any;

      switch (command) {
        case "popup_create_container": {
          const { name, role, color } = params;

          const [container] = await this.createContainers([
            { name, role, color: color || "blue" },
          ]);

          // Open a blank tab in this container
          const tabId = await this.createTab(container.id, "about:blank");

          result = { containerId: container.id, tabId };
          break;
        }

        case "popup_delete_container": {
          const { containerId } = params;
          await this.removeContainer(containerId);
          result = { removed: true };
          break;
        }

        default:
          throw new Error(`Unknown popup command: ${command}`);
      }

      // Send response back to extension
      this.sendExtResponse(id, result);
    } catch (err) {
      this.sendExtError(id, (err as Error).message);
    }
  }

  /** Send a response to the extension for a popup command. */
  private sendExtResponse(id: number, result: any): void {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
      this.extensionWs.send(JSON.stringify({ id, result }));
    }
  }

  /** Send an error to the extension for a popup command. */
  private sendExtError(id: number, error: string): void {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
      this.extensionWs.send(JSON.stringify({ id, error }));
    }
  }

  get extensionConnected(): boolean {
    return this.extensionWs !== null && this.extensionWs.readyState === WebSocket.OPEN;
  }

  // ─── Container CRUD ───

  /** Create containers with specified roles. Max 4. */
  async createContainers(roles: ContainerRole[]): Promise<Container[]> {
    const created: Container[] = [];

    // Also create in extension for visual colored tabs
    if (this.extensionConnected) {
      await this.sendExtCommand("create_containers", {
        roles: roles.slice(0, 4).map((r) => ({
          name: r.name,
          role: r.role,
          color: r.color,
        })),
      });
    }

    for (const role of roles.slice(0, 4)) {
      const userContextId = await this.client.createUserContext();
      const id = `container-${++this.containerCounter}`;

      const container: Container = {
        id,
        cookieStoreId: userContextId,
        name: role.name,
        color: role.color || (["blue", "green", "orange", "red"][this.containerCounter - 1] as ContainerColor) || "blue",
        role: role.role,
        credentials: role.credentials,
        authenticated: false,
        tabIds: [],
      };

      this.containers.set(userContextId, container);
      created.push(container);
      console.error(`[container-mgr] Created container "${role.name}" (${role.role}) → ${userContextId}`);
    }

    // Sync state to extension popup
    this.syncStateToExtension();

    return created;
  }

  /** Remove all containers. */
  async removeContainers(): Promise<void> {
    // Remove extension containers
    if (this.extensionConnected) {
      await this.sendExtCommand("remove_containers", {});
    }

    for (const [userContextId, container] of this.containers) {
      try {
        for (const tabId of container.tabIds) {
          try { await this.client.closeContext(tabId); } catch {}
        }
        await this.client.removeUserContext(userContextId);
        console.error(`[container-mgr] Removed container "${container.name}"`);
      } catch (err) {
        console.error(`[container-mgr] Failed to remove ${container.name}: ${(err as Error).message}`);
      }
    }
    this.containers.clear();
    this.contextToContainer.clear();
    this.syncStateToExtension();
  }

  /** Remove a specific container. */
  async removeContainer(idOrUserContext: string): Promise<void> {
    const container = this.getContainer(idOrUserContext);
    if (!container) return;

    for (const tabId of container.tabIds) {
      try { await this.client.closeContext(tabId); } catch {}
    }
    try { await this.client.removeUserContext(container.cookieStoreId); } catch {}

    this.containers.delete(container.cookieStoreId);
    for (const [ctxId, ucId] of this.contextToContainer) {
      if (ucId === container.cookieStoreId) this.contextToContainer.delete(ctxId);
    }
    this.syncStateToExtension();
  }

  /** List current containers. */
  listContainers(): Container[] {
    return Array.from(this.containers.values());
  }

  /** Get a container by its ID or userContextId. */
  getContainer(idOrUserContext: string): Container | undefined {
    for (const c of this.containers.values()) {
      if (c.id === idOrUserContext) return c;
    }
    return this.containers.get(idOrUserContext);
  }

  // ─── Tab Management ───

  /** Create a tab (browsing context) in a container. */
  async createTab(idOrUserContext: string, url?: string): Promise<string> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);

    const contextId = await this.client.createContext(container.cookieStoreId);
    container.tabIds.push(contextId);
    this.contextToContainer.set(contextId, container.cookieStoreId);

    console.error(`[container-mgr] Tab ${contextId} created in "${container.name}"`);

    if (url) {
      await this.client.navigate(contextId, url, "complete");
    }

    // Inject visual indicator
    await this.injectContainerIndicator(contextId);

    this.syncStateToExtension();
    return contextId;
  }

  /** Close a tab. */
  async closeTab(contextId: string): Promise<void> {
    await this.client.closeContext(contextId);
    const userContextId = this.contextToContainer.get(contextId);
    if (userContextId) {
      const container = this.containers.get(userContextId);
      if (container) {
        const idx = container.tabIds.indexOf(contextId);
        if (idx >= 0) container.tabIds.splice(idx, 1);
      }
    }
    this.contextToContainer.delete(contextId);
    this.syncStateToExtension();
  }

  /** Get the browsing context ID for a container (first tab, or create one). */
  async getOrCreateTab(idOrUserContext: string): Promise<string> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);

    if (container.tabIds.length > 0) return container.tabIds[0];

    const contexts = await this.client.getContexts();
    for (const ctx of contexts) {
      if (ctx.userContext === container.cookieStoreId) {
        container.tabIds.push(ctx.id);
        this.contextToContainer.set(ctx.id, container.cookieStoreId);
        return ctx.id;
      }
    }

    return this.createTab(idOrUserContext);
  }

  /** Resolve a container ID to a browsing context ID. */
  async resolveContextId(idOrUserContext: string): Promise<string> {
    return this.getOrCreateTab(idOrUserContext);
  }

  /** Get the container for a browsing context. */
  getContainerForContext(contextId: string): Container | undefined {
    const userContextId = this.contextToContainer.get(contextId);
    if (userContextId) return this.containers.get(userContextId);
    return undefined;
  }

  // ─── Cookie Management ───

  async setCookies(idOrUserContext: string, cookies: CookieEntry[]): Promise<void> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);

    for (const cookie of cookies) {
      await this.client.setCookie({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite?.toLowerCase() as "strict" | "lax" | "none" | undefined,
        userContext: container.cookieStoreId,
      });
    }
    console.error(`[container-mgr] Set ${cookies.length} cookies for "${container.name}"`);
  }

  async getCookies(idOrUserContext: string): Promise<CookieEntry[]> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);
    const cookies = await this.client.getCookies(container.cookieStoreId);
    return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
  }

  async clearCookies(idOrUserContext: string, domain?: string): Promise<void> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);
    await this.client.deleteCookies({ domain, userContext: container.cookieStoreId });
  }

  // ─── Header Injection ───

  async setHeaderOverrides(idOrUserContext: string, headers: Record<string, string>): Promise<void> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);

    const bidi = this.client as BiDiClient;
    if (typeof bidi.setHeaderOverridesForContext === "function") {
      bidi.setHeaderOverridesForContext(container.cookieStoreId, headers);
      console.error(`[container-mgr] Header overrides set for "${container.name}": ${Object.keys(headers).join(", ")}`);
    }

    // Also tell extension for webRequest-based injection
    if (this.extensionConnected) {
      await this.sendExtCommand("set_header_overrides", {
        cookieStoreId: container.cookieStoreId,
        headers,
      });
    }

    this.syncStateToExtension();
  }

  /** Get the header overrides for a container (if any). */
  getHeaderOverrides(idOrUserContext: string): Record<string, string> | undefined {
    const container = this.getContainer(idOrUserContext);
    if (!container) return undefined;

    const bidi = this.client as BiDiClient;
    if (typeof bidi.getHeaderOverridesForContext === "function") {
      return bidi.getHeaderOverridesForContext(container.cookieStoreId);
    }
    return undefined;
  }

  async enableHeaderInjection(contextId: string): Promise<void> {
    const bidi = this.client as BiDiClient;
    if (typeof bidi.enableHeaderInjection === "function") {
      await bidi.enableHeaderInjection(contextId);
    }
  }

  // ─── Visual Indicator ───

  async injectContainerIndicator(contextId: string): Promise<void> {
    const container = this.getContainerForContext(contextId);
    if (!container) return;

    const colorMap: Record<string, string> = {
      blue: "#1a73e8",
      green: "#0d904f",
      orange: "#e8710a",
      red: "#d93025",
    };

    const bgColor = colorMap[container.color] || colorMap.blue;
    const role = container.role.toUpperCase();
    const name = container.name;

    const script = `function() {
      if (document.getElementById('__hb_indicator')) return;
      const banner = document.createElement('div');
      banner.id = '__hb_indicator';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'height:28px;display:flex;align-items:center;padding:0 12px;font-family:system-ui,-apple-system,sans-serif;' +
        'font-size:12px;font-weight:600;color:white;background:${bgColor};' +
        'box-shadow:0 1px 3px rgba(0,0,0,0.3);user-select:none;pointer-events:none;';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:white;margin-right:8px;opacity:0.9;';
      banner.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = '${role} — ${name}';
      banner.appendChild(label);
      const spacer = document.createElement('div');
      spacer.id = '__hb_spacer';
      spacer.style.cssText = 'height:28px;width:100%;';
      document.documentElement.style.borderTop = '2px solid ${bgColor}';
      if (document.body) {
        document.body.prepend(spacer);
        document.body.prepend(banner);
      } else {
        document.addEventListener('DOMContentLoaded', function() {
          document.body.prepend(spacer);
          document.body.prepend(banner);
        });
      }
      document.title = '[${role}] ' + document.title;
      new MutationObserver(function() {
        if (!document.title.startsWith('[${role}]')) {
          document.title = '[${role}] ' + document.title;
        }
      }).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });
    }`;

    try {
      await this.client.addPreloadScript(script, [contextId]);
      await this.client.evaluate(contextId, `(${script})()`);
    } catch (err) {
      console.error(`[container-mgr] Failed to inject indicator: ${(err as Error).message}`);
    }
  }

  // ─── Credential Application ───

  async applyCredentials(idOrUserContext: string, credential: Credential): Promise<void> {
    const container = this.getContainer(idOrUserContext);
    if (!container) throw new Error(`Container not found: ${idOrUserContext}`);
    container.credentials = credential;

    if (credential.type === "cookies") {
      await this.setCookies(idOrUserContext, credential.cookies);
      container.authenticated = true;
    } else if (credential.type === "headers") {
      await this.setHeaderOverrides(idOrUserContext, credential.headers);
      container.authenticated = true;
    }
  }

  setAuthenticated(idOrUserContext: string, authenticated: boolean): void {
    const container = this.getContainer(idOrUserContext);
    if (container) { container.authenticated = authenticated; this.syncStateToExtension(); }
  }

  setCredentials(idOrUserContext: string, credentials: Credential): void {
    const container = this.getContainer(idOrUserContext);
    if (container) container.credentials = credentials;
  }

  // ─── Cleanup ───

  async destroy(): Promise<void> {
    await this.removeContainers();
    // Close extension WS
    if (this.extensionWs) { this.extensionWs.close(); this.extensionWs = null; }
    if (this.wss) { this.wss.close(); this.wss = null; }
    this.extPending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error("Stopped")); });
    this.extPending.clear();
  }
}
