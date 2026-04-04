import type { HeaderCarrier, QueryInput, QueryResult, SpotifyTrackMeta } from "./types.js";
import { logInfo, logWarn, summarizeBody } from "./logger.js";
import { normalizeHeaderValue, pickAuthTokenFromQuery, resolveAppleAuth } from "./utils.js";
import {
  askAppleForLyrics,
  getLocalTtmlLyrics,
  isAppleWordByWord,
  searchAppleSongFromSpotifyTrack,
  transformAppleToSpicyLyrics,
  writeLocalLyricsJson,
} from "./lyrics/apple.js";
import {
  askSpotifyForLyrics,
  getSpotifyTrackMeta,
  transformSpotifyToSpicyLyrics,
} from "./lyrics/spotify.js";
import { normalizeLyricsForClient, normalizeSpicyLyricsPayload } from "./lyrics/normalize.js";
import { fetchAndStoreSpicyLyricsUpstreamResult } from "./snapshot.js";
import { getLyricsFromCache, writeLyricsToCache } from "./cache.js";
import type { SpicyLineLyrics, SpicySyllableLyrics } from "./types.js";

export async function handleQueryOperation(
  query: QueryInput,
  carrier: HeaderCarrier
): Promise<QueryResult> {
  const operation = query.operation;
  const variables = query.variables ?? {};

  logInfo("query", "Handling query operation", {
    operation,
    variables: summarizeBody(variables),
  });

  if (operation === "lyrics") {
    const trackId = variables.id || variables.trackId;
    const spotifyToken = pickAuthTokenFromQuery(variables, carrier);

    // 1. Local TTML (highest priority — covers TTML XML and pre-parsed WBW JSON sidecars)
    const localLyrics = await getLocalTtmlLyrics(trackId);
    if (localLyrics) {
      return { data: normalizeLyricsForClient(localLyrics, trackId), httpStatus: 200, format: "json" };
    }

    // 2. Cache check
    if (trackId) {
      const cached = await getLyricsFromCache(trackId);
      if (cached) {
        logInfo("query", "Returning lyrics from cache", { operation, trackId, type: cached.Type });
        return { data: normalizeLyricsForClient(cached, trackId), httpStatus: 200, format: "json" };
      }
    }

    // 3. SpicyLyrics upstream
    const upstreamLyrics = await fetchAndStoreSpicyLyricsUpstreamResult({
      source: "query",
      operation,
      trackId,
      market: variables.market,
      authorization: spotifyToken,
      spicyLyricsVersion: normalizeHeaderValue(carrier.headers["spicylyrics-version"]),
      variables,
      upstreamRequestHeaders: carrier.headers,
    });

    if (upstreamLyrics && upstreamLyrics.httpStatus === 200) {
      const normalizedUpstream = normalizeSpicyLyricsPayload(upstreamLyrics.data, trackId) as SpicyLineLyrics | SpicySyllableLyrics | null;
      const result = normalizedUpstream ?? (normalizeLyricsForClient(upstreamLyrics.data, trackId) as SpicyLineLyrics | SpicySyllableLyrics);
      const isWBW = result.Type === "Syllable";
      logInfo("query", "Returning lyrics from SpicyLyrics upstream", {
        operation,
        trackId,
        wordByWord: isWBW,
      });

      if (trackId) {
        if (isWBW) {
          // Word-by-word → persist to local TTML dir (becomes the top-priority source next request)
          await writeLocalLyricsJson(trackId, result);
        } else {
          // Line-only → persist to regular cache
          await writeLyricsToCache(trackId, result);
        }
      }

      return { data: result, httpStatus: 200, format: "json" };
    }

    // 4. Apple Music (SpicyLyrics had no lyrics) — resolve Apple song id
    const appleStorefront = variables.appleStorefront || variables.storefront || "gb";
    const appleAuth = resolveAppleAuth({
      carrier,
      developerToken: variables.appleDeveloperToken,
      userToken: variables.appleUserToken,
    });

    let appleSongId = variables.appleSongId;
    if (!appleSongId && trackId) {
      const clientMeta: SpotifyTrackMeta | null = variables.trackName
        ? {
            id: trackId,
            name: variables.trackName,
            artists: Array.isArray(variables.trackArtists) ? variables.trackArtists : [],
            durationMs: Number(variables.trackDurationMs ?? 0),
          }
        : await getSpotifyTrackMeta({ trackId, authorization: spotifyToken });

      if (clientMeta) {
        logInfo("query", "Resolved track metadata for Apple mapping", {
          trackId,
          name: clientMeta.name,
          artists: clientMeta.artists,
          fromClient: Boolean(variables.trackName),
        });
        appleSongId =
          (await searchAppleSongFromSpotifyTrack({
            spotifyTrack: clientMeta,
            storefront: appleStorefront,
            authorization: appleAuth.authorization,
            userToken: appleAuth.userToken || undefined,
          })) ?? undefined;

        logInfo("query", "Spotify to Apple mapping result", {
          trackId,
          mappedAppleSongId: appleSongId ?? null,
        });
      } else {
        logWarn("query", "Could not resolve track metadata for Apple mapping", { trackId });
      }
    }

    if (appleSongId) {
      const appleResult = await askAppleForLyrics({
        songId: appleSongId,
        storefront: appleStorefront,
        authorization: appleAuth.authorization,
        userToken: appleAuth.userToken || undefined,
      });

      if (appleResult.httpStatus === 200) {
        const transformedApple = transformAppleToSpicyLyrics(appleResult.data, trackId || appleSongId);
        if (transformedApple) {
          const normalized = normalizeLyricsForClient(transformedApple, trackId || appleSongId) as SpicyLineLyrics | SpicySyllableLyrics;
          const wordByWord = isAppleWordByWord(appleResult.data);
          logInfo("query", "Returning Apple lyrics result", {
            operation,
            appleSongId,
            lineCount: transformedApple.Content.length,
            wordByWord,
          });
          if (trackId) await writeLyricsToCache(trackId, normalized);
          return { data: normalized, httpStatus: 200, format: "json" };
        }

        logWarn("query", "Apple returned 200 but payload could not be transformed", {
          operation,
          appleSongId,
        });
      }

      logWarn("query", "Apple lyrics unavailable, falling back to Spotify", {
        operation,
        appleSongId,
        appleStatus: appleResult.httpStatus,
      });
    } else {
      logWarn("query", "No Apple song id resolved, falling back to Spotify", {
        operation,
        trackId,
      });
    }

    // 5. Spotify direct (last resort, no cache write)
    const spotifyResult = await askSpotifyForLyrics({
      trackId,
      market: variables.market || "from_token",
      authorization: spotifyToken,
    });

    if (spotifyResult.httpStatus === 200) {
      const transformedSpotify = transformSpotifyToSpicyLyrics(spotifyResult.data, trackId);
      logInfo("query", "Returning Spotify fallback lyrics", {
        operation,
        trackId,
        lineCount: transformedSpotify.Content.length,
      });
      return {
        data: normalizeLyricsForClient(transformedSpotify, trackId),
        httpStatus: spotifyResult.httpStatus,
        format: "json",
      };
    }

    logWarn("query", "All lyrics sources failed", { operation, trackId, status: spotifyResult.httpStatus });
    return { data: spotifyResult.data, httpStatus: spotifyResult.httpStatus, format: "json" };
  }

  if (operation === "spotifyLyrics") {
    const trackId = variables.id || variables.trackId;
    const spotifyToken = pickAuthTokenFromQuery(variables, carrier);

    const upstreamLyrics = await fetchAndStoreSpicyLyricsUpstreamResult({
      source: "query",
      operation,
      trackId,
      market: variables.market,
      authorization: spotifyToken,
      spicyLyricsVersion: normalizeHeaderValue(carrier.headers["spicylyrics-version"]),
      variables,
      upstreamRequestHeaders: carrier.headers,
    });

    if (upstreamLyrics && upstreamLyrics.httpStatus === 200) {
      const normalizedUpstreamLyrics = normalizeSpicyLyricsPayload(upstreamLyrics.data, trackId);
      logInfo("query", "Returning spotifyLyrics from hosted SpicyLyrics upstream", {
        operation,
        trackId,
        normalized: Boolean(normalizedUpstreamLyrics),
      });
      if (normalizedUpstreamLyrics) {
        return { ...upstreamLyrics, data: normalizedUpstreamLyrics, format: "json" };
      }
      return { ...upstreamLyrics, data: normalizeLyricsForClient(upstreamLyrics.data, trackId) };
    }

    const localLyrics = await getLocalTtmlLyrics(trackId);
    if (localLyrics) {
      return { data: normalizeLyricsForClient(localLyrics, trackId), httpStatus: 200, format: "json" };
    }

    const spotifyResult = await askSpotifyForLyrics({
      trackId,
      market: variables.market || "from_token",
      authorization: spotifyToken,
    });

    if (spotifyResult.httpStatus === 200) {
      const transformedSpotify = transformSpotifyToSpicyLyrics(spotifyResult.data, trackId);
      logInfo("query", "Returning Spotify-only lyrics", {
        operation,
        trackId,
        lineCount: transformedSpotify.Content.length,
      });
      return {
        data: normalizeLyricsForClient(transformedSpotify, trackId),
        httpStatus: spotifyResult.httpStatus,
        format: "json",
      };
    }

    return { data: spotifyResult.data, httpStatus: spotifyResult.httpStatus, format: "json" };
  }

  if (operation === "appleLyrics") {
    const appleTrackId = variables.id || variables.trackId;
    const localLyrics = await getLocalTtmlLyrics(appleTrackId);
    if (localLyrics) {
      return {
        data: normalizeLyricsForClient(localLyrics, appleTrackId),
        httpStatus: 200,
        format: "json",
      };
    }

    const appleAuth = resolveAppleAuth({
      carrier,
      developerToken: variables.appleDeveloperToken,
      userToken: variables.appleUserToken,
    });

    const appleResult = await askAppleForLyrics({
      songId: variables.songId || variables.id,
      storefront: variables.storefront || "us",
      authorization: appleAuth.authorization,
      userToken: appleAuth.userToken || undefined,
    });

    const transformedApple =
      appleResult.httpStatus === 200
        ? transformAppleToSpicyLyrics(appleResult.data, variables.songId || variables.id)
        : null;

    if (transformedApple) {
      const wordByWord = isAppleWordByWord(appleResult.data);
      logInfo("query", "Returning Apple-only transformed lyrics", {
        operation,
        songId: variables.songId || variables.id,
        lineCount: transformedApple.Content.length,
        wordByWord,
      });
      return {
        data: normalizeLyricsForClient(transformedApple, variables.songId || variables.id),
        httpStatus: appleResult.httpStatus,
        format: "json",
      };
    }

    logWarn("query", "Apple-only lyrics request not transformed", {
      operation,
      status: appleResult.httpStatus,
      songId: variables.songId || variables.id,
    });

    return { data: appleResult.data, httpStatus: appleResult.httpStatus, format: "json" };
  }

  return {
    data: { message: `Unsupported operation: ${String(operation)}` },
    httpStatus: 400,
    format: "json",
  };
}
