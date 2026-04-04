import { logInfo, serializeHeaders } from "./logger.js";

export async function fetchJsonWithFallback(url: URL | string, options: RequestInit = {}) {
  const method = options.method ?? "GET";
  const urlText = typeof url === "string" ? url : url.toString();
  const startedAt = Date.now();
  const requestHeaders = serializeHeaders(options.headers);

  logInfo("upstream", `Requesting ${method} ${urlText}`, { requestHeaders });

  const res = await fetch(url, options);
  const responseHeaders = serializeHeaders(res.headers);

  logInfo("upstream", `Received response for ${method} ${urlText}`, {
    status: res.status,
    ok: res.ok,
    durationMs: Date.now() - startedAt,
    responseHeaders,
  });

  const text = await res.text();
  let data: unknown = text;

  try {
    data = JSON.parse(text);
  } catch {
    // Preserve raw text if response body is not JSON.
  }

  return { ok: res.ok, status: res.status, data };
}
