/**
 * HackBrowser Extension — Background Script
 *
 * Responsibilities:
 * 1. WebSocket bridge to HackBrowser tool (for MCP/agent integration)
 * 2. Header injection via webRequest (per-container custom headers)
 * 3. Relays container changes to tool when connected
 *
 * Container CRUD is handled directly by popup.js via Firefox APIs.
 */

// ─── State ───

/** @type {WebSocket|null} */
let ws = null;
let reconnectTimer = null;
const wsPort = 9221;

/** @type {Map<string, Record<string, string>>} */
const headerOverrides = new Map();

// ─── WebSocket Connection ───

async function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}/extension`);

    ws.onopen = () => {
      console.log("[hackbrowser-ext] Connected to tool on port", wsPort);
      clearInterval(reconnectTimer);
      reconnectTimer = null;

      // Send current containers to tool
      getHBContainers().then((containers) => {
        sendEvent("connected", { containers });
      });
    };

    ws.onmessage = (event) => handleToolMessage(event.data);

    ws.onclose = () => {
      console.log("[hackbrowser-ext] Disconnected from tool");
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws = null;
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => connectWs(), 3000);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendResponse(id, result) { wsSend({ id, result }); }
function sendError(id, error) { wsSend({ id, error: String(error) }); }
function sendEvent(event, data) { wsSend({ event, data }); }

// ─── Helper: list HB containers ───

async function getHBContainers() {
  const identities = await browser.contextualIdentities.query({});
  const meta = (await browser.storage.local.get("containerMeta")).containerMeta || {};
  return identities
    .filter((i) => i.name.startsWith("HB: "))
    .map((i) => ({
      cookieStoreId: i.cookieStoreId,
      name: (meta[i.cookieStoreId] || {}).name || i.name.replace("HB: ", ""),
      role: (meta[i.cookieStoreId] || {}).role || "",
      color: i.color,
    }));
}

// ─── Tool → Extension Messages (via WS) ───

async function handleToolMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // Events from tool (state sync etc.)
  if (msg.event) {
    if (msg.event === "state_sync") {
      console.log("[hackbrowser-ext] Tool state synced");
    }
    return;
  }

  const { id, command, params } = msg;

  try {
    let result;
    switch (command) {
      case "create_containers": {
        // Tool wants to create containers
        const roles = params.roles || [];
        // Remove existing HB containers first
        await removeAllHB();
        const created = [];
        for (const role of roles.slice(0, 4)) {
          const identity = await browser.contextualIdentities.create({
            name: `HB: ${role.name || role.role}`,
            color: role.color || "blue",
            icon: "fingerprint",
          });
          // Save meta
          const meta = (await browser.storage.local.get("containerMeta")).containerMeta || {};
          meta[identity.cookieStoreId] = { name: role.name, role: role.role };
          await browser.storage.local.set({ containerMeta: meta });
          created.push({ cookieStoreId: identity.cookieStoreId, name: role.name, role: role.role, color: role.color });
        }
        result = { containers: created };
        break;
      }
      case "remove_containers":
        result = await removeAllHB();
        break;
      case "list_containers":
        result = await getHBContainers();
        break;
      case "set_cookies":
        result = await setCookies(params);
        break;
      case "get_cookies":
        result = await getCookies(params);
        break;
      case "clear_cookies":
        result = await clearCookies(params);
        break;
      case "set_header_overrides":
        result = setHeaderOverrides(params);
        break;
      case "open_tab":
        result = await openTab(params);
        break;
      case "close_tab":
        result = await closeTab(params);
        break;
      case "get_container_tabs":
        result = await getContainerTabs(params);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    sendResponse(id, result);
  } catch (err) {
    sendError(id, err.message || String(err));
  }
}

// ─── Container cleanup ───

async function removeAllHB() {
  const identities = await browser.contextualIdentities.query({});
  for (const identity of identities) {
    if (identity.name.startsWith("HB: ")) {
      try {
        const tabs = await browser.tabs.query({ cookieStoreId: identity.cookieStoreId });
        for (const tab of tabs) await browser.tabs.remove(tab.id).catch(() => {});
        await browser.contextualIdentities.remove(identity.cookieStoreId);
        headerOverrides.delete(identity.cookieStoreId);
      } catch {}
    }
  }
  return { removed: true };
}

// ─── Cookie Management (for tool) ───

async function setCookies(params) {
  const { cookieStoreId, cookies } = params;
  for (const cookie of cookies) {
    await browser.cookies.set({
      url: `https://${cookie.domain}${cookie.path || "/"}`,
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path || "/", httpOnly: cookie.httpOnly || false,
      secure: cookie.secure !== false, sameSite: cookie.sameSite || "no_restriction",
      storeId: cookieStoreId,
    });
  }
  return { set: cookies.length };
}

async function getCookies(params) {
  const query = { storeId: params.cookieStoreId };
  if (params.domain) query.domain = params.domain;
  const cookies = await browser.cookies.getAll(query);
  return cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  }));
}

async function clearCookies(params) {
  const query = { storeId: params.cookieStoreId };
  if (params.domain) query.domain = params.domain;
  const cookies = await browser.cookies.getAll(query);
  for (const c of cookies) {
    await browser.cookies.remove({ url: `https://${c.domain}${c.path}`, name: c.name, storeId: params.cookieStoreId });
  }
  return { removed: cookies.length };
}

// ─── Header Override (for tool) ───

function setHeaderOverrides(params) {
  const { cookieStoreId, headers } = params;
  if (headers && Object.keys(headers).length > 0) {
    headerOverrides.set(cookieStoreId, headers);
  } else {
    headerOverrides.delete(cookieStoreId);
  }
  return { set: true };
}

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.cookieStoreId) return {};
    const overrides = headerOverrides.get(details.cookieStoreId);
    if (!overrides) return {};
    const headers = details.requestHeaders || [];
    for (const [name, value] of Object.entries(overrides)) {
      const idx = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0) headers[idx].value = value;
      else headers.push({ name, value });
    }
    return { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// ─── Tab Management (for tool) ───

async function openTab(params) {
  const tab = await browser.tabs.create({ url: params.url || "about:blank", cookieStoreId: params.cookieStoreId });
  return { tabId: tab.id, cookieStoreId: params.cookieStoreId };
}

async function closeTab(params) {
  await browser.tabs.remove(params.tabId);
  return { closed: true };
}

async function getContainerTabs(params) {
  const tabs = await browser.tabs.query({ cookieStoreId: params.cookieStoreId });
  return tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active }));
}

// ─── Popup Messages (minimal — popup does CRUD directly) ───

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "getWsStatus") {
    return Promise.resolve({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
  }

  // Popup notifies us of container changes → relay to tool
  if (msg.action === "containerChanged") {
    sendEvent("container_" + msg.type, {
      cookieStoreId: msg.cookieStoreId,
      name: msg.name,
      role: msg.role,
      color: msg.color,
    });
    return Promise.resolve({ ok: true });
  }

  return false;
});

// ─── Init ───

console.log("[hackbrowser-ext] Extension loaded, connecting to tool...");
connectWs();
