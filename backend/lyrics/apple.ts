import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppleSongCandidate,
  SpicyLineContent,
  SpicyLineLyrics,
  SpicySyllable,
  SpicySyllableContent,
  SpicySyllableLyrics,
  SpotifyTrackMeta,
} from "../types.js";
import { LYRICS_DIR } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { decodeHtmlEntities, normalizeForCompare, parseAppleTimestampToSeconds } from "../utils.js";
import { fetchJsonWithFallback } from "../fetch.js";
import { normalizeLineTiming, normalizeSyllableTiming } from "./timing.js";

export function extractAppleTtml(raw: unknown): string {
  const isTtml = (value: unknown): value is string =>
    typeof value === "string" && value.includes("<tt");

  const scan = (value: unknown): string => {
    if (isTtml(value)) return value;

    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = scan(item);
        if (hit) return hit;
      }
      return "";
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const priorityKeys = ["ttml", "ttmlLocalizations", "attributes", "data"];

      for (const key of priorityKeys) {
        if (key in obj) {
          const hit = scan(obj[key]);
          if (hit) return hit;
        }
      }

      for (const nested of Object.values(obj)) {
        const hit = scan(nested);
        if (hit) return hit;
      }
    }

    return "";
  };

  return scan(raw);
}

export function isAppleWordByWord(raw: unknown): boolean {
  const ttml = extractAppleTtml(raw);
  if (!ttml) return false;
  if (/itunes:timing\s*=\s*"Word"/i.test(ttml)) return true;
  return /<span\b[^>]*begin="[^"]+"[^>]*end="[^"]+"/i.test(ttml);
}

export function extractAppleSongWriters(ttml: string): string[] {
  const writers: string[] = [];
  const regex = /<songwriter>([\s\S]*?)<\/songwriter>/g;
  let match: RegExpExecArray | null = regex.exec(ttml);

  while (match) {
    const name = decodeHtmlEntities((match[1] ?? "").replace(/<[^>]+>/g, "").trim());
    if (name && !writers.includes(name)) {
      writers.push(name);
    }
    match = regex.exec(ttml);
  }

  return writers;
}

export function pickBestAppleCandidate(
  track: SpotifyTrackMeta,
  candidates: AppleSongCandidate[]
): AppleSongCandidate | null {
  const normalizedTitle = normalizeForCompare(track.name);
  const normalizedArtist = normalizeForCompare(track.artists[0] ?? "");

  let best: AppleSongCandidate | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const candidateTitle = normalizeForCompare(candidate.name);
    const candidateArtist = normalizeForCompare(candidate.artistName);
    const durationDiffSec = Math.abs(candidate.durationMs - track.durationMs) / 1000;

    let score = 0;
    if (candidateTitle === normalizedTitle) score += 60;
    else if (candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle)) score += 30;

    if (normalizedArtist && candidateArtist.includes(normalizedArtist)) score += 30;

    if (durationDiffSec <= 2) score += 20;
    else if (durationDiffSec <= 5) score += 12;
    else if (durationDiffSec <= 10) score += 6;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= 45 ? best : null;
}

export function transformAppleToSpicyLyrics(
  raw: unknown,
  songId?: string
): SpicyLineLyrics | SpicySyllableLyrics | null {
  const ttml = extractAppleTtml(raw);
  if (!ttml) return null;
  const songWriters = extractAppleSongWriters(ttml);
  const wordByWord = isAppleWordByWord(raw);

  if (wordByWord) {
    const lineRegex = /<p\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
    const syllableContent: SpicySyllableContent[] = [];

    let lineMatch: RegExpExecArray | null = lineRegex.exec(ttml);
    while (lineMatch) {
      const lineStart = parseAppleTimestampToSeconds(lineMatch[1]);
      const lineEnd = parseAppleTimestampToSeconds(lineMatch[2]);
      const lineInner = lineMatch[3] ?? "";

      const spanRegex = /<span\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g;
      const syllables: SpicySyllable[] = [];
      let previousSpanEndIndex = 0;
      let spanMatch: RegExpExecArray | null = spanRegex.exec(lineInner);

      while (spanMatch) {
        const betweenText = decodeHtmlEntities(
          lineInner.slice(previousSpanEndIndex, spanMatch.index).replace(/<[^>]+>/g, "")
        );
        const isPartOfWord = syllables.length > 0 && !/\s/.test(betweenText);
        const text = decodeHtmlEntities((spanMatch[3] ?? "").replace(/<[^>]+>/g, "").trim());

        if (text) {
          const startTime = parseAppleTimestampToSeconds(spanMatch[1]);
          const endTime = parseAppleTimestampToSeconds(spanMatch[2]);
          syllables.push({
            Text: text,
            StartTime: startTime,
            EndTime: endTime > startTime ? endTime : startTime + 0.2,
            IsPartOfWord: isPartOfWord,
          });
        }

        previousSpanEndIndex = spanRegex.lastIndex;
        spanMatch = spanRegex.exec(lineInner);
      }

      if (syllables.length === 0) {
        const fallbackText = decodeHtmlEntities(lineInner.replace(/<[^>]+>/g, "").trim());
        if (fallbackText) {
          syllables.push({
            Text: fallbackText,
            StartTime: lineStart,
            EndTime: lineEnd > lineStart ? lineEnd : lineStart + 1,
            IsPartOfWord: false,
          });
        }
      }

      if (syllables.length > 0) {
        const leadStart = syllables[0]?.StartTime ?? lineStart;
        const leadEnd = syllables[syllables.length - 1]?.EndTime ?? lineEnd;
        syllableContent.push({
          Type: "Vocal",
          OppositeAligned: false,
          Lead: {
            Syllables: syllables,
            StartTime: leadStart,
            EndTime: leadEnd > leadStart ? leadEnd : leadStart + 1,
          },
        });
      }

      lineMatch = lineRegex.exec(ttml);
    }

    if (syllableContent.length > 0) {
      normalizeSyllableTiming(syllableContent);
      return {
        id: songId ?? "",
        Type: "Syllable",
        StartTime: syllableContent[0]?.Lead.StartTime ?? 0,
        EndTime: syllableContent[syllableContent.length - 1]?.Lead.EndTime ?? 0,
        Content: syllableContent,
        source: "aml",
        Provider: "AppleMusic",
        ProviderDisplayName: "Apple Music",
        Language: "und",
        IsRtlLanguage: false,
        IncludesRomanization: false,
        SongWriters: songWriters,
      };
    }
  }

  const lineRegex = /<p\b[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  const content: SpicyLineContent[] = [];

  let match: RegExpExecArray | null = lineRegex.exec(ttml);
  while (match) {
    const startTime = parseAppleTimestampToSeconds(match[1]);
    const endTime = parseAppleTimestampToSeconds(match[2]);
    const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, "").trim());

    if (text) {
      content.push({
        Type: "Vocal",
        OppositeAligned: false,
        Text: text,
        StartTime: startTime,
        EndTime: endTime > startTime ? endTime : startTime + 2,
      });
    }

    match = lineRegex.exec(ttml);
  }

  if (content.length === 0) return null;
  normalizeLineTiming(content);

  return {
    id: songId ?? "",
    Type: "Line",
    StartTime: content[0]?.StartTime ?? 0,
    EndTime: content[content.length - 1]?.EndTime ?? 0,
    Content: content,
    source: "aml",
    Provider: "AppleMusic",
    ProviderDisplayName: "Apple Music",
    Language: "und",
    IsRtlLanguage: false,
    IncludesRomanization: false,
    SongWriters: songWriters,
  };
}

export function markAsLocalTtml<T extends SpicyLineLyrics | SpicySyllableLyrics>(lyrics: T): T {
  return {
    ...lyrics,
    Provider: "LocalTTML",
    ProviderDisplayName: "Local TTML",
    source: "aml",
  } as T;
}

export async function writeLocalLyricsJson(
  trackId: string,
  lyrics: SpicyLineLyrics | SpicySyllableLyrics
): Promise<void> {
  const dir = path.resolve(LYRICS_DIR, trackId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "lyrics.json"), JSON.stringify(lyrics, null, 2), "utf8");
  logInfo("local-ttml", "Saved pre-parsed lyrics to local TTML dir", {
    trackId,
    type: lyrics.Type,
  });
}

export async function getLocalTtmlLyrics(
  trackId?: string
): Promise<SpicyLineLyrics | SpicySyllableLyrics | null> {
  if (!trackId) return null;

  // Check for pre-parsed JSON sidecar first (written by SpicyLyrics WBW results)
  const jsonPath = path.resolve(LYRICS_DIR, trackId, "lyrics.json");
  try {
    await access(jsonPath);
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as SpicyLineLyrics | SpicySyllableLyrics;
    logInfo("local-ttml", "Using local pre-parsed lyrics override", {
      trackId,
      type: parsed.Type,
      lineCount: parsed.Content.length,
    });
    return parsed;
  } catch {
    // No JSON sidecar, try TTML files below.
  }

  const candidates = [
    path.resolve(LYRICS_DIR, trackId, "ttml"),
    path.resolve(LYRICS_DIR, trackId, "ttml.xml"),
    path.resolve(LYRICS_DIR, trackId, "lyrics.ttml"),
  ];

  for (const candidatePath of candidates) {
    try {
      await access(candidatePath);
      const ttmlRaw = await readFile(candidatePath, "utf8");
      const transformed = transformAppleToSpicyLyrics(ttmlRaw, trackId);
      if (!transformed) {
        logWarn("local-ttml", "TTML file found but could not be transformed", {
          trackId,
          path: candidatePath,
        });
        return null;
      }

      const localLyrics = markAsLocalTtml(transformed);
      logInfo("local-ttml", "Using local TTML lyrics override", {
        trackId,
        path: candidatePath,
        type: localLyrics.Type,
        lineCount: localLyrics.Content.length,
      });
      return localLyrics;
    } catch {
      // Try next file path candidate.
    }
  }

  return null;
}

export async function searchAppleSongFromSpotifyTrack(params: {
  spotifyTrack: SpotifyTrackMeta;
  storefront: string;
  authorization?: string;
  userToken?: string;
}): Promise<string | null> {
  const { spotifyTrack, storefront, authorization, userToken } = params;
  const token =
    authorization ||
    process.env.APPLE_AUTHORIZATION ||
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
    "";

  const searchWithItunes = async (): Promise<string | null> => {
    const term = encodeURIComponent(`${spotifyTrack.name} ${spotifyTrack.artists[0] ?? ""}`.trim());
    const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=20`;

    logInfo("apple-search", "Falling back to iTunes search mapping", {
      spotifyTrackId: spotifyTrack.id,
      spotifyTrackName: spotifyTrack.name,
    });

    const result = await fetchJsonWithFallback(url, { method: "GET" });
    if (!result.ok || typeof result.data !== "object" || result.data === null) {
      logWarn("apple-search", "iTunes search fallback failed", { status: result.status });
      return null;
    }

    const data = result.data as {
      results?: Array<{
        trackId?: number;
        trackName?: string;
        artistName?: string;
        trackTimeMillis?: number;
      }>;
    };

    const candidates: AppleSongCandidate[] = (data.results ?? [])
      .map((song) => ({
        id: String(song.trackId ?? ""),
        name: song.trackName ?? "",
        artistName: song.artistName ?? "",
        durationMs: Number(song.trackTimeMillis ?? 0),
      }))
      .filter((song) => song.id && song.name);

    const match = pickBestAppleCandidate(spotifyTrack, candidates);
    logInfo("apple-search", "iTunes mapping completed", {
      candidateCount: candidates.length,
      matchedSongId: match?.id ?? null,
      matchedSongName: match?.name ?? null,
    });
    return match?.id ?? null;
  };

  if (!token) {
    logWarn("apple-search", "No Apple authorization token for Apple catalog search; trying iTunes fallback");
    return await searchWithItunes();
  }

  logInfo("apple-search", "Searching Apple song from Spotify metadata", {
    spotifyTrackId: spotifyTrack.id,
    spotifyTrackName: spotifyTrack.name,
    spotifyArtists: spotifyTrack.artists,
    storefront,
    hasAuthorization: Boolean(token),
    hasUserToken: Boolean(userToken),
  });

  const term = encodeURIComponent(`${spotifyTrack.name} ${spotifyTrack.artists[0] ?? ""}`.trim());
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/search?types=songs&limit=10&term=${term}`;

  const headers: Record<string, string> = {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    accept: "application/json",
  };
  if (userToken) {
    headers["Music-User-Token"] = userToken;
    headers["media-user-token"] = userToken;
  }

  const result = await fetchJsonWithFallback(url, { method: "GET", headers });
  if (!result.ok || typeof result.data !== "object" || result.data === null) {
    logWarn("apple-search", "Apple search failed", { status: result.status, storefront });
    return await searchWithItunes();
  }

  const data = result.data as {
    results?: {
      songs?: {
        data?: Array<{
          id?: string;
          attributes?: { name?: string; artistName?: string; durationInMillis?: number };
        }>;
      };
    };
  };

  const songs = data.results?.songs?.data ?? [];
  const candidates: AppleSongCandidate[] = songs
    .map((song) => ({
      id: song.id ?? "",
      name: song.attributes?.name ?? "",
      artistName: song.attributes?.artistName ?? "",
      durationMs: Number(song.attributes?.durationInMillis ?? 0),
    }))
    .filter((song) => song.id && song.name);

  const match = pickBestAppleCandidate(spotifyTrack, candidates);
  logInfo("apple-search", "Apple search completed", {
    candidateCount: candidates.length,
    matchedSongId: match?.id ?? null,
    matchedSongName: match?.name ?? null,
  });
  if (match) return match.id;

  logWarn("apple-search", "No confident Apple catalog match; trying iTunes fallback", {
    spotifyTrackId: spotifyTrack.id,
  });
  return await searchWithItunes();
}

export async function askAppleForLyrics(params: {
  songId?: string;
  storefront?: string;
  developerToken?: string;
  authorization?: string;
  userToken?: string;
}): Promise<{ httpStatus: number; data: unknown }> {
  const { songId, storefront = "gb" } = params;

  if (!songId) {
    return { httpStatus: 400, data: { message: "Missing Apple Music song id." } };
  }

  const mainToken =
    params.authorization ||
    params.developerToken ||
    process.env.APPLE_AUTHORIZATION ||
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
    "";
  const userToken =
    params.userToken ||
    process.env.APPLE_MEDIA_USER_TOKEN ||
    process.env.APPLE_MUSIC_USER_TOKEN ||
    "";

  if (!mainToken) {
    return {
      httpStatus: 401,
      data: {
        message:
          "Missing Apple Music developer token. Provide appleDeveloperToken or APPLE_MUSIC_DEVELOPER_TOKEN.",
      },
    };
  }

  logInfo("apple-lyrics", "Starting Apple lyrics lookup", {
    songId,
    storefront,
    hasAuthorization: Boolean(mainToken),
    hasUserToken: Boolean(userToken),
  });

  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/songs/${songId}/syllable-lyrics?l%5Blyrics%5D=en-gb&l%5Bscript%5D=en-Latn&extend=ttmlLocalizations`;
  const headers: Record<string, string> = {
    Authorization: mainToken.startsWith("Bearer ") ? mainToken : `Bearer ${mainToken}`,
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    origin: "https://music.apple.com",
    referer: "https://music.apple.com/",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  };

  if (userToken) {
    headers["media-user-token"] = userToken;
  }

  const result = await fetchJsonWithFallback(url, { method: "GET", headers });

  if (!result.ok) {
    logWarn("apple-lyrics", "Apple lyrics lookup failed", { songId, storefront, status: result.status });
    return { httpStatus: result.status, data: result.data };
  }

  if (typeof result.data !== "object" || result.data === null) {
    logWarn("apple-lyrics", "Apple lyrics lookup returned non-object response", {
      songId,
      storefront,
      status: result.status,
      data: result.data,
    });
    return { httpStatus: result.status, data: result.data };
  }

  const payload = result.data as { data?: Array<unknown> };
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    logWarn("apple-lyrics", "Apple lyrics lookup returned empty data array", {
      songId,
      storefront,
      status: result.status,
      data: result.data,
    });
    return { httpStatus: result.status, data: result.data };
  }

  logInfo("apple-lyrics", "Apple lyrics raw response", {
    songId,
    storefront,
    status: result.status,
    hasDataArray: Array.isArray(payload.data),
    firstItemType: typeof payload.data?.[0],
  });

  return { httpStatus: result.status, data: result.data };
}
