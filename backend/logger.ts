import { LOG_ENABLED, LOG_SENSITIVE_HEADERS } from "./config.js";

export function logInfo(scope: string, message: string, meta?: unknown): void {
  if (!LOG_ENABLED) return;
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.log(`[${timestamp}] [INFO] [${scope}] ${message}`, meta);
    return;
  }
  console.log(`[${timestamp}] [INFO] [${scope}] ${message}`);
}

export function logWarn(scope: string, message: string, meta?: unknown): void {
  if (!LOG_ENABLED) return;
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.warn(`[${timestamp}] [WARN] [${scope}] ${message}`, meta);
    return;
  }
  console.warn(`[${timestamp}] [WARN] [${scope}] ${message}`);
}

export function logError(scope: string, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  if (meta !== undefined) {
    console.error(`[${timestamp}] [ERROR] [${scope}] ${message}`, meta);
    return;
  }
  console.error(`[${timestamp}] [ERROR] [${scope}] ${message}`);
}

export function summarizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = { ...(body as Record<string, unknown>) };
  if (typeof clone.authorization === "string") clone.authorization = "[REDACTED]";
  if (typeof clone.appleDeveloperToken === "string") clone.appleDeveloperToken = "[REDACTED]";
  if (typeof clone.appleUserToken === "string") clone.appleUserToken = "[REDACTED]";
  if (typeof clone.mediaUserToken === "string") clone.mediaUserToken = "[REDACTED]";
  if (typeof clone.spotifyToken === "string") clone.spotifyToken = "[REDACTED]";
  return clone;
}

export function redactHeaderValue(name: string, value: string): string {
  if (!value) return value;
  if (LOG_SENSITIVE_HEADERS) return value;

  const isSensitiveHeader =
    name.includes("authorization") ||
    name.includes("webauth") ||
    name.includes("token") ||
    name.includes("cookie") ||
    name.includes("secret") ||
    name.includes("api-key") ||
    name.includes("apikey");

  if (!isSensitiveHeader) return value;

  if (/^bearer\s+/i.test(value)) {
    const token = value.replace(/^bearer\s+/i, "");
    const suffix = token.length >= 6 ? token.slice(-6) : token;
    return `Bearer [REDACTED len=${token.length} suffix=${suffix}]`;
  }

  return "[REDACTED]";
}

export function serializeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};

  const entries: Array<[string, string]> = [];

  if (headers instanceof Headers) {
    for (const [name, value] of headers.entries()) {
      entries.push([name, value]);
    }
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      entries.push([name, String(value)]);
    }
  } else {
    for (const [name, rawValue] of Object.entries(headers)) {
      if (rawValue === undefined) continue;
      if (Array.isArray(rawValue)) {
        entries.push([name, rawValue.join(", ")]);
      } else {
        entries.push([name, String(rawValue)]);
      }
    }
  }

  return Object.fromEntries(
    entries
      .map(([name, value]) => {
        const normalizedName = name.toLowerCase();
        return [normalizedName, redactHeaderValue(normalizedName, value)] as const;
      })
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}
