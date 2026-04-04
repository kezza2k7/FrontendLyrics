import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppleAuth, HeaderCarrier, QueryVariables } from "./types.js";
import { logInfo, logWarn } from "./logger.js";

let cachedSpicyLyricsVersion: string | null = null;

export async function getCachedSpicyLyricsVersion(): Promise<string> {
  if (cachedSpicyLyricsVersion !== null) return cachedSpicyLyricsVersion;

  try {
    const configPath = path.resolve(process.cwd(), "project", "config.ts");
    const configContent = await readFile(configPath, "utf8");
    const match = configContent.match(/export\s+const\s+ProjectVersion\s*=\s*["']([^"']+)["']/);
    if (match && match[1]) {
      cachedSpicyLyricsVersion = match[1];
      logInfo("version", "Loaded SpicyLyrics version from config file", { version: cachedSpicyLyricsVersion });
      return cachedSpicyLyricsVersion;
    }
  } catch (error) {
    logWarn("version", "Failed to load version from project config file", { error: String(error) });
  }

  const envVersion = process.env.SPICYLYRICS_VERSION || "unknown";
  cachedSpicyLyricsVersion = envVersion;
  return envVersion;
}

export function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value.trim();
}

export function isPlaceholderToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;

  return (
    normalized.includes("[redacted]") ||
    normalized.includes("your_token") ||
    normalized.includes("insert_token") ||
    normalized.includes("example") ||
    normalized === "bearer" ||
    normalized === "bearer null" ||
    normalized === "bearer undefined" ||
    normalized === "null" ||
    normalized === "undefined"
  );
}

export function pickFirstRealToken(candidates: Array<string | undefined>): string {
  for (const rawCandidate of candidates) {
    const candidate = (rawCandidate ?? "").trim();
    if (!candidate) continue;
    if (isPlaceholderToken(candidate)) continue;
    return candidate;
  }
  return "";
}

export function resolveAppleAuth(params: {
  carrier?: HeaderCarrier;
  developerToken?: string;
  authorization?: string;
  userToken?: string;
}): AppleAuth {
  const headers = params.carrier?.headers;

  const authorization =
    params.developerToken ||
    params.authorization ||
    normalizeHeaderValue(headers?.authorization) ||
    process.env.APPLE_AUTHORIZATION ||
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
    "";

  const userToken =
    params.userToken ||
    normalizeHeaderValue(headers?.["media-user-token"]) ||
    normalizeHeaderValue(headers?.["music-user-token"]) ||
    process.env.APPLE_MEDIA_USER_TOKEN ||
    process.env.APPLE_MUSIC_USER_TOKEN ||
    "";

  return { authorization, userToken };
}

export function pickAuthTokenFromQuery(variables: QueryVariables = {}, carrier: HeaderCarrier): string {
  const dynamicHeaderValue =
    typeof variables.auth === "string"
      ? normalizeHeaderValue(carrier.headers[variables.auth.toLowerCase()])
      : "";

  const authorizationHeader = normalizeHeaderValue(carrier.headers.authorization);
  const spicyWebAuthHeader = normalizeHeaderValue(carrier.headers["spicylyrics-webauth"]);

  return pickFirstRealToken([
    dynamicHeaderValue,
    authorizationHeader,
    spicyWebAuthHeader,
    typeof variables.spotifyToken === "string" ? variables.spotifyToken : "",
    process.env.SPOTIFY_BEARER_TOKEN,
  ]);
}

export function toSeconds(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric / 1000;
}

export function parseAppleTimestampToSeconds(value: string): number {
  const cleaned = value.trim();
  const parts = cleaned.split(":");

  if (parts.length === 3) {
    const hours = Number(parts[0]) || 0;
    const minutes = Number(parts[1]) || 0;
    const seconds = Number(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const minutes = Number(parts[0]) || 0;
    const seconds = Number(parts[1]) || 0;
    return minutes * 60 + seconds;
  }

  return Number(cleaned) || 0;
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ")
    .replace(/\b(feat\.|ft\.|version|remaster(ed)?|live|mono|stereo|deluxe|edit)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
