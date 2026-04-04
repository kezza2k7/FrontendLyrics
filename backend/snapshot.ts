import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { QueryResult, QueryVariables, SpicyLyricsUpstreamSnapshot } from "./types.js";
import { SONG_REQUEST_SNAPSHOT_PATH, SPICYLYRICS_UPSTREAM_BASE_URL } from "./config.js";
import { logError, logInfo, logWarn, summarizeBody } from "./logger.js";
import { normalizeHeaderValue, getCachedSpicyLyricsVersion } from "./utils.js";
import { fetchJsonWithFallback } from "./fetch.js";

export let songSnapshotWriteQueue: Promise<void> = Promise.resolve();

export async function appendSongRequestSnapshot(snapshot: SpicyLyricsUpstreamSnapshot): Promise<void> {
  await mkdir(path.dirname(SONG_REQUEST_SNAPSHOT_PATH), { recursive: true });

  let existing: unknown = [];
  try {
    const raw = await readFile(SONG_REQUEST_SNAPSHOT_PATH, "utf8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }

  const snapshots = Array.isArray(existing) ? existing : [];
  snapshots.push(snapshot);

  await writeFile(SONG_REQUEST_SNAPSHOT_PATH, JSON.stringify(snapshots, null, 2), "utf8");
}

export async function fetchAndStoreSpicyLyricsUpstreamResult(params: {
  source: "query" | "route";
  operation: string;
  trackId?: string;
  market?: string;
  authorization?: string;
  spicyLyricsVersion?: string;
  variables?: QueryVariables;
  upstreamRequestHeaders?: IncomingHttpHeaders;
}): Promise<QueryResult | null> {
  const { source, operation, trackId, market, authorization, upstreamRequestHeaders } = params;
  if (!trackId) return null;

  const normalizedVersion = await getCachedSpicyLyricsVersion();
  const incomingAcceptLanguage = normalizeHeaderValue(upstreamRequestHeaders?.["accept-language"]);
  const incomingOrigin = normalizeHeaderValue(upstreamRequestHeaders?.origin);
  const incomingReferer = normalizeHeaderValue(upstreamRequestHeaders?.referer);
  const incomingUserAgent = normalizeHeaderValue(upstreamRequestHeaders?.["user-agent"]);
  const incomingSecChUa = normalizeHeaderValue(upstreamRequestHeaders?.["sec-ch-ua"]);
  const incomingSecChUaMobile = normalizeHeaderValue(upstreamRequestHeaders?.["sec-ch-ua-mobile"]);
  const incomingSecChUaPlatform = normalizeHeaderValue(upstreamRequestHeaders?.["sec-ch-ua-platform"]);

  const spicyHeaders: Record<string, string> = {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": incomingAcceptLanguage || "en-GB,en;q=0.9",
    "Content-Type": "application/json",
    origin: incomingOrigin || "https://xpui.app.spotify.com",
    referer: incomingReferer || "https://xpui.app.spotify.com/",
    priority: "u=1, i",
    "sec-ch-ua": incomingSecChUa || '"Not(A:Brand";v="8", "Chromium";v="144"',
    "sec-ch-ua-mobile": incomingSecChUaMobile || "?0",
    "sec-ch-ua-platform": incomingSecChUaPlatform || '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "spicylyrics-version": normalizedVersion,
    "user-agent":
      incomingUserAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.97 Spotify/1.2.86.502 Safari/537.36",
  };

  const authHeader =
    authorization?.startsWith("Bearer ") ? authorization : authorization ? `Bearer ${authorization}` : "";
  if (authHeader) {
    spicyHeaders["spicylyrics-webauth"] = authHeader;
  }

  const forwardedOperation = operation || "lyrics";
  const forwardedVariables: QueryVariables = {
    id: trackId,
    auth: "SpicyLyrics-WebAuth",
  };

  const upstream = await fetchJsonWithFallback(`${SPICYLYRICS_UPSTREAM_BASE_URL}/query`, {
    method: "POST",
    headers: spicyHeaders,
    body: JSON.stringify({
      queries: [{ operation: forwardedOperation, variables: forwardedVariables }],
      client: { version: normalizedVersion || "unknown" },
    }),
  });

  const snapshot: SpicyLyricsUpstreamSnapshot = {
    requestedAt: new Date().toISOString(),
    source,
    operation,
    trackId,
    market: market ?? null,
    status: upstream.status,
    ok: upstream.ok,
    data: upstream.data,
  };

  songSnapshotWriteQueue = songSnapshotWriteQueue
    .then(async () => {
      await appendSongRequestSnapshot(snapshot);
    })
    .catch((error) => {
      logError("song-snapshot", "Failed to persist song request snapshot", {
        trackId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  await songSnapshotWriteQueue;

  if (!upstream.ok) {
    logWarn("song-snapshot", "SpicyLyrics upstream snapshot stored with non-OK status", {
      trackId,
      operation,
      status: upstream.status,
      upstreamResponse: upstream.data,
      forwardedHeaders: summarizeBody(spicyHeaders),
      forwardedRequest: {
        operation: forwardedOperation,
        variables: summarizeBody(forwardedVariables),
      },
      path: SONG_REQUEST_SNAPSHOT_PATH,
    });
    return null;
  }

  if (typeof upstream.data !== "object" || upstream.data === null) {
    return null;
  }

  const payload = upstream.data as {
    queries?: Array<{ result?: QueryResult }>;
  };

  const upstreamResult = payload.queries?.[0]?.result;
  if (!upstreamResult) {
    logWarn("song-snapshot", "SpicyLyrics upstream response missing queries[0].result", {
      trackId,
      operation,
      upstreamResponse: upstream.data,
      path: SONG_REQUEST_SNAPSHOT_PATH,
    });
    return null;
  }

  logInfo("song-snapshot", "Stored SpicyLyrics upstream snapshot", {
    trackId,
    operation,
    path: SONG_REQUEST_SNAPSHOT_PATH,
  });
  return upstreamResult;
}
