/**
 * Firefox binary detection, profile management, and process launch.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import type { Subprocess } from "bun";
import { createProtocolClient } from "./protocol.js";
import type { IProtocolClient } from "./protocol.js";

const PROJECT_ROOT = join(dirname(dirname(import.meta.dir)));

/** Firefox preference overrides for remote debugging */
const FIREFOX_PREFS: Record<string, string | number | boolean> = {
  // Remote debugging
  "remote.enabled": true,
  "remote.active-protocols": 3, // Both BiDi and CDP
  "devtools.debugger.remote-enabled": true,
  "devtools.debugger.prompt-connection": false,

  // Containers (contextualIdentities)
  "privacy.userContext.enabled": true,
  "privacy.userContext.ui.enabled": true,
  "privacy.userContext.extension": true,

  // Disable telemetry / update
  "app.update.enabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.enabled": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",

  // Accept insecure certs (for local testing)
  "security.enterprise_roots.enabled": true,

  // Disable first-run
  "browser.aboutConfig.showWarning": false,
  "startup.homepage_welcome_url": "",
  "browser.startup.firstrunSkipsHomepage": true,

  // Disable safe mode
  "toolkit.startup.max_resumed_crashes": -1,

  // Extension auto-install (allow unsigned)
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 15,
  "xpinstall.signatures.required": false,
  "extensions.langpacks.signatures.required": false,
  "extensions.experiments.enabled": true,

  // Extension permissions: allow in private browsing + restricted sites
  "extensions.allowPrivateBrowsingByDefault": true,
  "extensions.quarantinedDomains.enabled": false,
  "extensions.webextensions.restrictedDomains": "",

  // Network
  "network.http.max-connections": 256,
  "network.http.max-persistent-connections-per-server": 10,

  // Disable content blocking (can interfere with testing)
  "privacy.trackingprotection.enabled": false,
  "privacy.trackingprotection.socialtracking.enabled": false,

  // Allow mixed content (for testing)
  "security.mixed_content.block_active_content": false,
  "security.mixed_content.block_display_content": false,

  // Stealth — hide automation indicators
  "dom.webdriver.enabled": false,
  "media.navigator.enabled": false,
  "privacy.resistFingerprinting": false,
  "general.useragent.override": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:137.0) Gecko/20100101 Firefox/137.0",
};

export interface LaunchOptions {
  port?: number;
  profilePath?: string;
  extensionPath?: string;
  headless?: boolean;
  width?: number;
  height?: number;
  extraPrefs?: Record<string, string | number | boolean>;
}

export interface LaunchResult {
  process: Subprocess;
  client: IProtocolClient;
  profilePath: string;
  port: number;
  pid: number;
}

/**
 * Find the Firefox binary path.
 * Priority: bundled → system.
 */
export function findFirefoxBinary(): string {
  const candidates: string[] = [];
  const platform = process.platform;

  // 1. Bundled Firefox (Developer Edition preferred)
  if (platform === "darwin") {
    // Scan firefox/ dir for any .app
    const firefoxDir = join(PROJECT_ROOT, "firefox");
    if (existsSync(firefoxDir)) {
      try {
        const entries = require("fs").readdirSync(firefoxDir) as string[];
        for (const name of entries) {
          if (name.endsWith(".app")) {
            candidates.push(join(firefoxDir, name, "Contents", "MacOS", "firefox"));
          }
        }
      } catch {}
    }
    // Explicit fallbacks
    candidates.push(
      join(PROJECT_ROOT, "firefox", "Firefox Developer Edition.app", "Contents", "MacOS", "firefox")
    );
    candidates.push(
      join(PROJECT_ROOT, "firefox", "Firefox.app", "Contents", "MacOS", "firefox")
    );
  } else if (platform === "linux") {
    candidates.push(join(PROJECT_ROOT, "firefox", "firefox", "firefox"));
  }

  // 2. System Firefox (Developer Edition preferred)
  if (platform === "darwin") {
    candidates.push("/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox");
    candidates.push("/Applications/Firefox Nightly.app/Contents/MacOS/firefox");
    candidates.push("/Applications/Firefox.app/Contents/MacOS/firefox");
  } else if (platform === "linux") {
    candidates.push("/usr/bin/firefox-devedition");
    candidates.push("/usr/bin/firefox");
    candidates.push("/usr/bin/firefox-esr");
    candidates.push("/snap/bin/firefox");
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(
    `Firefox binary not found. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n\nRun 'bun run download-firefox' to install.`
  );
}

/**
 * Create a managed Firefox profile with required preferences.
 */
export function createProfile(
  profilePath: string,
  prefs: Record<string, string | number | boolean>,
  extensionPath?: string
): void {
  if (!existsSync(profilePath)) {
    mkdirSync(profilePath, { recursive: true });
  }

  // Write user.js (preferences)
  const prefsContent = Object.entries(prefs)
    .map(([key, value]) => {
      const v = typeof value === "string" ? `"${value}"` : value;
      return `user_pref("${key}", ${v});`;
    })
    .join("\n");

  writeFileSync(join(profilePath, "user.js"), prefsContent + "\n");

  // Install extension via proxy file
  // Firefox loads extensions from profile/extensions/ — a file named with the extension ID
  // containing the absolute path to the extension directory
  if (extensionPath && existsSync(extensionPath)) {
    const extDir = join(profilePath, "extensions");
    if (!existsSync(extDir)) {
      mkdirSync(extDir, { recursive: true });
    }

    // Read extension ID from manifest.json
    const manifestPath = join(extensionPath, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(require("fs").readFileSync(manifestPath, "utf-8"));
      const extId =
        manifest.browser_specific_settings?.gecko?.id ||
        manifest.applications?.gecko?.id;

      if (extId) {
        // Write proxy file: a file named <ext-id> containing the absolute path
        const proxyFile = join(extDir, extId);
        const absExtPath = require("path").resolve(extensionPath);
        writeFileSync(proxyFile, absExtPath);
        console.error(`[launcher] Extension installed: ${extId} → ${absExtPath}`);

        // Pin extension to toolbar + grant private browsing permission
        writeExtensionSettings(profilePath, extId);
      }
    }
  }
}

/**
 * Write extension-settings.json to grant permissions and pin to toolbar.
 */
function writeExtensionSettings(profilePath: string, extId: string): void {
  // Widget ID: extension ID with @ → _ plus -browser-action
  const widgetId = `${extId.replace("@", "_")}-browser-action`;

  // 1. Pin extension button to navbar via browser UI customization state
  const customization = {
    placements: {
      "nav-bar": [
        "back-button",
        "forward-button",
        "stop-reload-button",
        "customizableui-special-spring1",
        "urlbar-container",
        "customizableui-special-spring2",
        widgetId,
        "downloads-button",
        "unified-extensions-button",
      ],
      "toolbar-menubar": ["menubar-items"],
      "TabsToolbar": ["tabbrowser-tabs", "new-tab-button", "alltabs-button"],
      "PersonalToolbar": ["personal-bookmarks"],
      "unified-extensions-area": [],
      "widget-overflow-fixed-list": [],
    },
    seen: [widgetId, "developer-button"],
    dirtyAreaCache: ["nav-bar"],
    currentVersion: 20,
    newElementCount: 0,
  };

  // Write as user pref
  const customizationPref = `user_pref("browser.uiCustomization.state", '${JSON.stringify(customization)}');\n`;

  // 2. Extension permissions: allow private browsing + unrestricted
  const extPerms = {
    commands: {},
    scopes: 5,
    origins: ["<all_urls>"],
    permissions: [
      "contextualIdentities",
      "cookies",
      "tabs",
      "webRequest",
      "webRequestBlocking",
      "storage",
    ],
  };

  const permsPref = `user_pref("extensions.webextensions.${extId}.permissions", '${JSON.stringify(extPerms)}');\n`;

  // Append to user.js
  const userJsPath = join(profilePath, "user.js");
  const { appendFileSync } = require("fs");
  appendFileSync(userJsPath, "\n// Extension toolbar pin + permissions\n");
  appendFileSync(userJsPath, customizationPref);
  appendFileSync(userJsPath, permsPref);

  console.error(`[launcher] Extension pinned to toolbar + permissions granted`);
}


/**
 * Launch Firefox with remote debugging enabled.
 */
export async function launchFirefox(options: LaunchOptions = {}): Promise<LaunchResult> {
  const {
    port = 9222,
    profilePath = join(PROJECT_ROOT, "profiles", `hackbrowser-${Date.now()}`),
    extensionPath = join(PROJECT_ROOT, "extension"),
    headless = false,
    width = 1440,
    height = 900,
    extraPrefs = {},
  } = options;

  // Find binary
  const binary = findFirefoxBinary();
  console.error(`[launcher] Using Firefox: ${binary}`);

  // Create profile
  const allPrefs = { ...FIREFOX_PREFS, ...extraPrefs };
  createProfile(profilePath, allPrefs, extensionPath);
  console.error(`[launcher] Profile: ${profilePath}`);

  // Build args
  const args: string[] = [
    "--remote-debugging-port",
    String(port),
    "--profile",
    profilePath,
    "--no-remote",
    `--window-size=${width},${height}`,
  ];

  if (headless) {
    args.push("--headless");
  }

  // Launch Firefox process
  console.error(`[launcher] Starting Firefox on port ${port}...`);
  const proc = Bun.spawn([binary, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MOZ_DISABLE_AUTO_SAFE_MODE: "1",
    },
  });

  const pid = proc.pid;
  console.error(`[launcher] Firefox PID: ${pid}`);

  // Wait for remote debugging port to be ready
  const wsUrl = `ws://127.0.0.1:${port}`;
  const client = await waitForConnection(wsUrl, 15_000);

  console.error(`[launcher] Connected via ${client.type}`);

  return {
    process: proc,
    client,
    profilePath,
    port,
    pid,
  };
}

/**
 * Wait for Firefox remote debugging to be ready, then connect.
 */
async function waitForConnection(
  wsUrl: string,
  timeoutMs: number
): Promise<IProtocolClient> {
  const start = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      return await createProtocolClient(wsUrl);
    } catch (err) {
      lastError = err as Error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(
    `Failed to connect to Firefox after ${timeoutMs}ms: ${lastError?.message}`
  );
}

/**
 * Gracefully close Firefox.
 */
export async function closeFirefox(result: LaunchResult): Promise<void> {
  try {
    await result.client.disconnect();
  } catch {}

  try {
    result.process.kill();
  } catch {}

  // Wait for process to exit
  const exitPromise = result.process.exited;
  const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([exitPromise, timeoutPromise]);

  // Force kill if still running
  try {
    process.kill(result.pid, 0); // Check if still alive
    process.kill(result.pid, "SIGKILL");
  } catch {
    // Process already exited
  }

  console.error(`[launcher] Firefox closed`);
}

/**
 * Clean up a profile directory.
 */
export function cleanupProfile(profilePath: string): void {
  try {
    rmSync(profilePath, { recursive: true, force: true });
  } catch {}
}
