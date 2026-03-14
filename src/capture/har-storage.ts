/**
 * HAR Storage — save/load/merge HAR files to/from disk.
 */

import { existsSync } from "fs";
import type { Har, HarEntry } from "../types/har.js";
import type { CapturedRequest, Header, RequestTiming } from "../types/index.js";

/**
 * Save HAR to a file.
 */
export async function saveHar(har: Har, filePath: string): Promise<void> {
  const json = JSON.stringify(har, null, 2);
  await Bun.write(filePath, json);
  console.error(`[har] Saved ${har.log.entries.length} entries to ${filePath}`);
}

/**
 * Load HAR from a file.
 */
export async function loadHar(filePath: string): Promise<Har> {
  if (!existsSync(filePath)) {
    throw new Error(`HAR file not found: ${filePath}`);
  }

  const json = await Bun.file(filePath).text();
  const har = JSON.parse(json) as Har;

  if (!har.log || !Array.isArray(har.log.entries)) {
    throw new Error("Invalid HAR format: missing log.entries");
  }

  console.error(`[har] Loaded ${har.log.entries.length} entries from ${filePath}`);
  return har;
}

/**
 * Merge new entries into an existing HAR.
 * Deduplicates by timestamp + URL + method.
 */
export function mergeHar(existing: Har, newEntries: HarEntry[]): Har {
  const seen = new Set<string>();

  // Index existing entries
  for (const entry of existing.log.entries) {
    seen.add(entryKey(entry));
  }

  // Add new entries that aren't duplicates
  let added = 0;
  for (const entry of newEntries) {
    const key = entryKey(entry);
    if (!seen.has(key)) {
      existing.log.entries.push(entry);
      seen.add(key);
      added++;
    }
  }

  // Sort by time
  existing.log.entries.sort(
    (a, b) => new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime()
  );

  console.error(`[har] Merged ${added} new entries (${newEntries.length - added} duplicates skipped)`);
  return existing;
}

/**
 * Convert HAR entries back to CapturedRequest format (for import/resume).
 */
export function harEntriesToRequests(entries: HarEntry[]): CapturedRequest[] {
  return entries.map((entry, i) => {
    const reqHeaders: Header[] = entry.request.headers.map((h) => ({
      name: h.name,
      value: h.value,
    }));

    const resHeaders: Header[] = entry.response.headers.map((h) => ({
      name: h.name,
      value: h.value,
    }));

    const timing: RequestTiming = {
      blocked: entry.timings.blocked ?? -1,
      dns: entry.timings.dns ?? -1,
      connect: entry.timings.connect ?? -1,
      ssl: entry.timings.ssl ?? -1,
      send: entry.timings.send,
      wait: entry.timings.wait,
      receive: entry.timings.receive,
    };

    return {
      id: `har-${i}`,
      containerId: entry._containerId || "unknown",
      timestamp: new Date(entry.startedDateTime).getTime(),
      url: entry.request.url,
      method: entry.request.method,
      requestHeaders: reqHeaders,
      requestBody: entry.request.postData?.text,
      requestBodySize: entry.request.bodySize,
      status: entry.response.status,
      statusText: entry.response.statusText,
      responseHeaders: resHeaders,
      responseBody: entry.response.content.text,
      responseBodySize: entry.response.bodySize,
      mimeType: entry.response.content.mimeType,
      timing,
      isWebSocket: entry.request.url.startsWith("ws://") || entry.request.url.startsWith("wss://"),
    } satisfies CapturedRequest;
  });
}

function entryKey(entry: HarEntry): string {
  return `${entry.startedDateTime}|${entry.request.method}|${entry.request.url}`;
}
