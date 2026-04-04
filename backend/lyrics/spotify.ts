import type { SpicyLineContent, SpicyLineLyrics, SpotifyTrackMeta } from "../types.js";
import { spotifyMetaCache, SPOTIFY_META_CACHE_TTL_MS } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { toSeconds } from "../utils.js";
import { fetchJsonWithFallback } from "../fetch.js";
import { normalizeLineTiming } from "./timing.js";

export function toSpotifyTrackMeta(trackId: string, data: unknown): SpotifyTrackMeta | null {
  if (typeof data !== "object" || data === null) return null;

  const parsed = data as {
    id?: string;
    name?: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
  };

  return {
    id: parsed.id ?? trackId,
    name: parsed.name ?? "",
    artists: Array.isArray(parsed.artists)
      ? parsed.artists.map((artist) => artist.name ?? "").filter(Boolean)
      : [],
    durationMs: Number(parsed.duration_ms ?? 0),
  };
}

export async function fetchSpotifyTrackFromMainApi(params: {
  trackId?: string;
  authorization?: string;
}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { trackId, authorization } = params;

  if (!trackId) {
    return { ok: false, status: 400, data: { message: "Missing Spotify track id." } };
  }

  if (!authorization) {
    return {
      ok: false,
      status: 401,
      data: { message: "Missing Spotify bearer token. Cannot fetch Spotify main track API." },
    };
  }

  const authHeader = authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`;
  const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;

  return await fetchJsonWithFallback(trackUrl, {
    method: "GET",
    headers: { Authorization: authHeader, accept: "application/json" },
  });
}

export async function getSpotifyTrackMeta(params: {
  trackId?: string;
  authorization?: string;
}): Promise<SpotifyTrackMeta | null> {
  const { trackId, authorization } = params;
  if (!trackId || !authorization) return null;

  const cached = spotifyMetaCache.get(trackId);
  if (cached && cached.expiresAt > Date.now()) {
    logInfo("spotify-meta", "Returning cached Spotify track metadata", { trackId });
    return cached.data;
  }

  logInfo("spotify-meta", "Fetching Spotify track metadata", {
    trackId,
    hasAuthorization: Boolean(authorization),
  });

  const result = await fetchSpotifyTrackFromMainApi({ trackId, authorization });
  if (!result.ok) {
    logWarn("spotify-meta", "Spotify metadata lookup failed", { trackId, status: result.status });
    return null;
  }

  const meta = toSpotifyTrackMeta(trackId, result.data);
  if (!meta) return null;

  spotifyMetaCache.set(trackId, { data: meta, expiresAt: Date.now() + SPOTIFY_META_CACHE_TTL_MS });
  return meta;
}

export function transformSpotifyToSpicyLyrics(raw: unknown, trackId?: string): SpicyLineLyrics {
  const source = (raw ?? {}) as {
    lyrics?: {
      lines?: Array<{
        startTimeMs?: string | number;
        endTimeMs?: string | number;
        words?: string;
      }>;
      provider?: string;
      providerDisplayName?: string;
      language?: string;
      isRtlLanguage?: boolean;
    };
  };

  const rawLines = Array.isArray(source.lyrics?.lines) ? source.lyrics.lines : [];
  const vocalLines = rawLines.filter((line) => {
    const words = typeof line.words === "string" ? line.words.trim() : "";
    return words.length > 0;
  });

  const content: SpicyLineContent[] = vocalLines.map((line, index) => {
    const startTime = toSeconds(line.startTimeMs);
    const nextStartTime = toSeconds(vocalLines[index + 1]?.startTimeMs);
    const explicitEndTime = toSeconds(line.endTimeMs);

    const computedEndTime =
      explicitEndTime > startTime
        ? explicitEndTime
        : nextStartTime > startTime
          ? nextStartTime
          : startTime + 2;

    return {
      Type: "Vocal",
      OppositeAligned: false,
      Text: (line.words ?? "").trim(),
      StartTime: startTime,
      EndTime: computedEndTime,
    };
  });

  normalizeLineTiming(content);

  return {
    id: trackId ?? "",
    Type: "Line",
    StartTime: content[0]?.StartTime ?? 0,
    Content: content,
    source: "spt",
    Provider: source.lyrics?.provider ?? "Spotify",
    ProviderDisplayName: source.lyrics?.providerDisplayName ?? "Spotify",
    Language: source.lyrics?.language ?? "und",
    IsRtlLanguage: source.lyrics?.isRtlLanguage ?? false,
    IncludesRomanization: false,
    SongWriters: [],
  };
}

export async function askSpotifyForLyrics(params: {
  trackId?: string;
  market?: string;
  authorization?: string;
}): Promise<{ httpStatus: number; data: unknown }> {
  const { trackId, market = "from_token", authorization } = params;

  logInfo("spotify-lyrics", "Starting Spotify lyrics lookup", {
    trackId,
    market,
    hasAuthorization: Boolean(authorization),
  });

  if (!trackId) {
    return { httpStatus: 400, data: { message: "Missing Spotify track id." } };
  }

  if (!authorization) {
    return {
      httpStatus: 401,
      data: {
        message:
          "Missing Spotify bearer token. Provide Authorization, SpicyLyrics-WebAuth, spotifyToken, or SPOTIFY_BEARER_TOKEN.",
      },
    };
  }

  const authHeader = authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`;
  const spotifyUrl = new URL(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}`);
  spotifyUrl.searchParams.set("format", "json");
  spotifyUrl.searchParams.set("vocalRemoval", "false");
  spotifyUrl.searchParams.set("market", market);

  const result = await fetchJsonWithFallback(spotifyUrl, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      "app-platform": "WebPlayer",
      "spotify-app-version": "1.2.58.498.g6afe77b7",
      accept: "application/json",
    },
  });

  return { httpStatus: result.status, data: result.data };
}
