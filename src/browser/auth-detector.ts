/**
 * Auth Detector — detect authentication status, login forms, and auto-login.
 */

import type { IProtocolClient } from "./protocol.js";
import type { ContainerManager } from "./container-manager.js";
import type { BrowserInteraction } from "./interaction.js";

export interface AuthStatus {
  containerId: string;
  authenticated: boolean;
  confidence: "high" | "medium" | "low";
  indicators: string[];
  sessionCookies: string[];
  expiresAt?: number;
}

export interface LoginFormInfo {
  url: string;
  formSelector: string;
  usernameField: { selector: string; type: string };
  passwordField: { selector: string; type: string };
  submitButton: { selector: string; text: string };
  csrfField?: { name: string; value: string };
  extraFields: { name: string; type: string; value: string }[];
}

/** Cookie names that indicate an active session. */
const SESSION_COOKIE_PATTERNS = [
  /^session/i, /^sess/i, /^sid$/i, /^connect\.sid$/i,
  /^token/i, /^auth/i, /^jwt/i, /^access.?token/i,
  /^PHPSESSID$/i, /^JSESSIONID$/i, /^ASP\.NET/i,
  /^\.AspNetCore\./i, /^_session/i, /^wp-/i, /^laravel_session/i,
  /^rack\.session/i, /^_csrf/i, /^XSRF-TOKEN/i,
];

export class AuthDetector {
  constructor(
    private client: IProtocolClient,
    private containerManager: ContainerManager,
  ) {}

  /** Check if a container has an active authenticated session. */
  async detectAuth(containerId: string): Promise<AuthStatus> {
    const container = this.containerManager.getContainer(containerId);
    if (!container) {
      return {
        containerId,
        authenticated: false,
        confidence: "high",
        indicators: ["Container not found"],
        sessionCookies: [],
      };
    }

    const indicators: string[] = [];
    const sessionCookies: string[] = [];
    let score = 0;

    // Check cookies for session indicators
    try {
      const cookies = await this.client.getCookies(container.cookieStoreId);
      for (const cookie of cookies) {
        for (const pattern of SESSION_COOKIE_PATTERNS) {
          if (pattern.test(cookie.name)) {
            sessionCookies.push(cookie.name);
            score += 2;
            break;
          }
        }
      }
      if (sessionCookies.length > 0) {
        indicators.push(`Session cookies found: ${sessionCookies.join(", ")}`);
      } else {
        indicators.push("No session cookies found");
      }
    } catch {
      indicators.push("Cookie check failed");
    }

    // Check if container has custom auth headers configured
    const headerOverrides = this.containerManager.getHeaderOverrides(containerId);
    if (headerOverrides) {
      const authHeaders = Object.keys(headerOverrides).filter(
        (h) => /^(authorization|x-api-key|x-auth|x-token)/i.test(h)
      );
      if (authHeaders.length > 0) {
        score += 3;
        indicators.push(`Auth headers configured: ${authHeaders.join(", ")}`);
      }
    }

    // Check container's authenticated flag
    if (container.authenticated) {
      score += 1;
      indicators.push("Container marked as authenticated");
    }

    const authenticated = score >= 2;
    const confidence: "high" | "medium" | "low" =
      score >= 4 ? "high" : score >= 2 ? "medium" : "low";

    return { containerId, authenticated, confidence, indicators, sessionCookies };
  }

  /** Detect login form on the current page of a container. */
  async detectLoginForm(contextId: string): Promise<LoginFormInfo | null> {
    try {
      const result = await this.client.evaluate(contextId, `(() => {
        // Find forms with password fields
        const pwFields = document.querySelectorAll('input[type="password"]');
        if (pwFields.length === 0) return null;

        const pwField = pwFields[0];
        const form = pwField.closest('form');
        if (!form) return null;

        // Find username field (text/email input before password)
        let usernameField = null;
        const inputs = form.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="email"], input[name*="login"]');
        for (const inp of inputs) {
          if (inp !== pwField) {
            usernameField = inp;
            break;
          }
        }

        // Find submit button
        let submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (!submitBtn) submitBtn = form.querySelector('button:not([type="button"]):not([type="reset"])');

        // Find CSRF field
        let csrfField = null;
        const hiddens = form.querySelectorAll('input[type="hidden"]');
        for (const h of hiddens) {
          if (/csrf|token|_token|authenticity/i.test(h.name)) {
            csrfField = { name: h.name, value: h.value };
            break;
          }
        }

        // Extra hidden fields
        const extraFields = [];
        for (const h of hiddens) {
          if (csrfField && h.name === csrfField.name) continue;
          extraFields.push({ name: h.name, type: 'hidden', value: h.value });
        }

        // Generate selectors
        function sel(el) {
          if (!el) return '';
          if (el.id) return '#' + el.id;
          if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
          return el.tagName.toLowerCase() + '[type="' + (el.type || 'text') + '"]';
        }

        function formSel(f) {
          if (f.id) return '#' + f.id;
          if (f.action) return 'form[action="' + f.getAttribute('action') + '"]';
          return 'form';
        }

        return {
          url: location.href,
          formSelector: formSel(form),
          usernameField: usernameField
            ? { selector: sel(usernameField), type: usernameField.type || 'text' }
            : { selector: '', type: 'text' },
          passwordField: { selector: sel(pwField), type: 'password' },
          submitButton: submitBtn
            ? { selector: sel(submitBtn), text: submitBtn.textContent?.trim() || submitBtn.value || 'Submit' }
            : { selector: '', text: '' },
          csrfField: csrfField,
          extraFields: extraFields,
        };
      })()`);

      return result as LoginFormInfo | null;
    } catch {
      return null;
    }
  }

  /** Auto-login: navigate to URL, detect form, fill credentials, submit. */
  async autoLogin(
    containerId: string,
    username: string,
    password: string,
    interaction: BrowserInteraction,
    loginUrl?: string,
  ): Promise<{ success: boolean; message: string; authStatus: AuthStatus }> {
    const container = this.containerManager.getContainer(containerId);
    if (!container) {
      return {
        success: false,
        message: "Container not found",
        authStatus: await this.detectAuth(containerId),
      };
    }

    // Get or navigate to login URL
    let contextId: string;
    if (loginUrl) {
      contextId = await this.containerManager.getOrCreateTab(containerId);
      await this.client.navigate(contextId, loginUrl, "complete");
    } else {
      contextId = await this.containerManager.getOrCreateTab(containerId);
    }

    // Detect login form
    const form = await this.detectLoginForm(contextId);
    if (!form) {
      return {
        success: false,
        message: "No login form detected on page",
        authStatus: await this.detectAuth(containerId),
      };
    }

    try {
      // Fill username
      if (form.usernameField.selector) {
        await interaction.typeInto(contextId, form.usernameField.selector, username, { clear: true });
      }

      // Fill password
      if (form.passwordField.selector) {
        await interaction.typeInto(contextId, form.passwordField.selector, password, { clear: true });
      }

      // Submit
      if (form.submitButton.selector) {
        await interaction.clickElement(contextId, form.submitButton.selector);
      } else if (form.formSelector) {
        await interaction.submitForm(contextId, form.formSelector);
      }

      // Wait for navigation
      await interaction.waitFor(contextId, {
        type: "network_idle",
        timeout: 10000,
        value: "2000",
      });

      // Check auth status after login
      const authStatus = await this.detectAuth(containerId);

      return {
        success: authStatus.authenticated,
        message: authStatus.authenticated
          ? "Login successful"
          : "Login form submitted but auth not detected — check manually",
        authStatus,
      };
    } catch (err) {
      return {
        success: false,
        message: `Login failed: ${(err as Error).message}`,
        authStatus: await this.detectAuth(containerId),
      };
    }
  }
}
