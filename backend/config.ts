import path from "node:path";
import type { SpotifyTrackMeta } from "./types.js";

export const PORT = Number(process.env.PORT || 3000);

export const spotifyMetaCache = new Map<string, { data: SpotifyTrackMeta; expiresAt: number }>();
export const SPOTIFY_META_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const LOG_ENABLED = process.env.BACKEND_LOGGING !== "false";
export const LOG_SENSITIVE_HEADERS = process.env.LOG_SENSITIVE_HEADERS === "true";
export const LYRICS_DIR =
  process.env.LYRICS_DIR?.trim() ||
  path.resolve(process.cwd(), "lyrics");
export const SPICYLYRICS_UPSTREAM_BASE_URL =
  process.env.SPICYLYRICS_UPSTREAM_BASE_URL?.trim() || "https://api.spicylyrics.org";
export const SONG_REQUEST_SNAPSHOT_PATH =
  process.env.SONG_REQUEST_SNAPSHOT_PATH?.trim() ||
  path.resolve(process.cwd(), "backend", "song-requests.json");
