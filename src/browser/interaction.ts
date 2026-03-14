/**
 * High-level browser interaction commands.
 * Wraps protocol-level primitives into user-friendly actions.
 */

import type { IProtocolClient, ElementRef, BoundingBox } from "./protocol.js";

export class BrowserInteraction {
  constructor(private client: IProtocolClient) {}

  /**
   * Click an element by CSS selector or text content.
   */
  async clickElement(
    contextId: string,
    target: string,
    options: { byText?: boolean; index?: number } = {}
  ): Promise<void> {
    const element = options.byText
      ? await this.findByText(contextId, target, options.index)
      : await this.client.querySelector(contextId, target);

    if (!element) {
      throw new Error(`Element not found: ${target}`);
    }

    const bounds = await this.client.getElementBounds(contextId, element);
    if (!bounds) {
      throw new Error(`Cannot get bounds for element: ${target}`);
    }

    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await this.client.click(contextId, x, y);
  }

  /**
   * Type text into an element (focuses first).
   */
  async typeInto(
    contextId: string,
    selector: string,
    text: string,
    options: { clear?: boolean } = {}
  ): Promise<void> {
    // Focus the element by clicking it
    await this.clickElement(contextId, selector);

    // Clear existing content if requested
    if (options.clear) {
      await this.client.evaluate(
        contextId,
        `document.querySelector(${JSON.stringify(selector)}).value = ''`
      );
      await this.client.evaluate(
        contextId,
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', {bubbles: true}))`
      );
    }

    // Type the text
    await this.client.typeText(contextId, text);
  }

  /**
   * Select an option from a dropdown.
   */
  async selectOption(
    contextId: string,
    selector: string,
    value: string
  ): Promise<void> {
    await this.client.evaluate(
      contextId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Select not found');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    );
  }

  /**
   * Submit a form element.
   */
  async submitForm(contextId: string, selector: string): Promise<void> {
    await this.client.evaluate(
      contextId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Form not found');
        const form = el.closest('form') || el;
        if (form.tagName === 'FORM') {
          form.submit();
        } else {
          throw new Error('No form found');
        }
      })()`
    );
  }

  /**
   * Scroll the page or an element.
   */
  async scroll(
    contextId: string,
    options: { x?: number; y?: number; selector?: string; direction?: "up" | "down" | "left" | "right"; amount?: number } = {}
  ): Promise<void> {
    const { selector, direction = "down", amount = 500 } = options;

    let scrollX = options.x ?? 0;
    let scrollY = options.y ?? 0;

    if (!options.x && !options.y) {
      switch (direction) {
        case "down": scrollY = amount; break;
        case "up": scrollY = -amount; break;
        case "right": scrollX = amount; break;
        case "left": scrollX = -amount; break;
      }
    }

    if (selector) {
      await this.client.evaluate(
        contextId,
        `document.querySelector(${JSON.stringify(selector)}).scrollBy(${scrollX}, ${scrollY})`
      );
    } else {
      await this.client.evaluate(
        contextId,
        `window.scrollBy(${scrollX}, ${scrollY})`
      );
    }
  }

  /**
   * Hover over an element.
   */
  async hoverElement(contextId: string, selector: string): Promise<void> {
    const element = await this.client.querySelector(contextId, selector);
    if (!element) throw new Error(`Element not found: ${selector}`);

    const bounds = await this.client.getElementBounds(contextId, element);
    if (!bounds) throw new Error(`Cannot get bounds: ${selector}`);

    // BiDi/CDP mouse move without click
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;

    // Use evaluate to dispatch mouseover event
    await this.client.evaluate(
      contextId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
      })()`
    );
  }

  /**
   * Wait for a condition to be true.
   */
  async waitFor(
    contextId: string,
    condition: {
      type: "selector" | "url" | "network_idle" | "js";
      value: string;
      timeout?: number;
    }
  ): Promise<void> {
    const timeout = condition.timeout ?? 30_000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        switch (condition.type) {
          case "selector": {
            const el = await this.client.querySelector(contextId, condition.value);
            if (el) return;
            break;
          }
          case "url": {
            const url = await this.client.getCurrentUrl(contextId);
            if (url.includes(condition.value)) return;
            break;
          }
          case "js": {
            const result = await this.client.evaluate(contextId, condition.value);
            if (result) return;
            break;
          }
          case "network_idle": {
            // Wait for no new requests for the specified duration (default 2s)
            const idleMs = parseInt(condition.value) || 2000;
            await new Promise((r) => setTimeout(r, idleMs));
            return;
          }
        }
      } catch {}

      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`Timeout waiting for ${condition.type}: ${condition.value}`);
  }

  /**
   * Get page source HTML.
   */
  async getPageSource(contextId: string): Promise<string> {
    return (await this.client.evaluate(
      contextId,
      "document.documentElement.outerHTML"
    )) as string;
  }

  /**
   * Get an LLM-friendly DOM tree (accessibility-like snapshot).
   */
  async getDomTree(contextId: string): Promise<string> {
    const result = await this.client.evaluate(
      contextId,
      `(() => {
        function walk(node, depth) {
          const indent = '  '.repeat(depth);
          let output = '';

          if (node.nodeType === 1) { // Element
            const tag = node.tagName.toLowerCase();
            const attrs = [];

            // Important attributes
            if (node.id) attrs.push('id="' + node.id + '"');
            if (node.className && typeof node.className === 'string') {
              const cls = node.className.trim();
              if (cls) attrs.push('class="' + cls.split(/\\s+/).slice(0, 3).join(' ') + '"');
            }
            if (node.getAttribute('href')) attrs.push('href="' + node.getAttribute('href') + '"');
            if (node.getAttribute('src')) attrs.push('src="' + node.getAttribute('src') + '"');
            if (node.getAttribute('type')) attrs.push('type="' + node.getAttribute('type') + '"');
            if (node.getAttribute('name')) attrs.push('name="' + node.getAttribute('name') + '"');
            if (node.getAttribute('value')) attrs.push('value="' + node.getAttribute('value') + '"');
            if (node.getAttribute('placeholder')) attrs.push('placeholder="' + node.getAttribute('placeholder') + '"');
            if (node.getAttribute('role')) attrs.push('role="' + node.getAttribute('role') + '"');
            if (node.getAttribute('aria-label')) attrs.push('aria-label="' + node.getAttribute('aria-label') + '"');
            if (node.disabled) attrs.push('disabled');
            if (node.hidden) attrs.push('hidden');

            // Skip hidden/script/style elements
            if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';
            if (node.hidden || (node.style && node.style.display === 'none')) return '';

            const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
            const text = node.childNodes.length === 1 && node.childNodes[0].nodeType === 3
              ? node.childNodes[0].textContent.trim().slice(0, 100)
              : '';

            if (text && !node.children.length) {
              output += indent + '<' + tag + attrStr + '>' + text + '</' + tag + '>\\n';
            } else {
              output += indent + '<' + tag + attrStr + '>\\n';
              for (const child of node.children) {
                output += walk(child, depth + 1);
              }
              output += indent + '</' + tag + '>\\n';
            }
          }
          return output;
        }
        return walk(document.body, 0);
      })()`
    );

    return (result as string) ?? "";
  }

  // ─── Private helpers ───

  private async findByText(
    contextId: string,
    text: string,
    index: number = 0
  ): Promise<ElementRef | null> {
    const result = await this.client.evaluate(
      contextId,
      `(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          {
            acceptNode: (node) => {
              const t = node.textContent?.trim() ?? '';
              return t.includes(${JSON.stringify(text)}) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
          }
        );
        const matches = [];
        let node;
        while (node = walker.nextNode()) {
          matches.push(node);
        }
        const target = matches[${index}];
        if (!target) return null;

        // Generate a unique selector
        const path = [];
        let el = target;
        while (el && el !== document.body) {
          let selector = el.tagName.toLowerCase();
          if (el.id) {
            selector = '#' + el.id;
            path.unshift(selector);
            break;
          }
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              const idx = siblings.indexOf(el) + 1;
              selector += ':nth-of-type(' + idx + ')';
            }
          }
          path.unshift(selector);
          el = parent;
        }
        return path.join(' > ');
      })()`
    );

    if (!result) return null;

    // Use the generated selector to get the element ref
    return this.client.querySelector(contextId, result as string);
  }
}
