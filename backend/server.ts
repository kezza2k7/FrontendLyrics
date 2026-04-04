import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";

import { PORT, LOG_ENABLED } from "./config.js";
import { logInfo, logError, summarizeBody } from "./logger.js";
import { normalizeHeaderValue, pickAuthTokenFromQuery, resolveAppleAuth } from "./utils.js";
import {
  askAppleForLyrics,
  getLocalTtmlLyrics,
  isAppleWordByWord,
  transformAppleToSpicyLyrics,
} from "./lyrics/apple.js";
import { askSpotifyForLyrics, transformSpotifyToSpicyLyrics } from "./lyrics/spotify.js";
import { normalizeLyricsForClient, normalizeSpicyLyricsPayload } from "./lyrics/normalize.js";
import { fetchAndStoreSpicyLyricsUpstreamResult } from "./snapshot.js";
import { handleQueryOperation } from "./query.js";
import type { AppleLyricsRequest, QueryInput, QueryResponseItem, SpotifyLyricsRequest } from "./types.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  logInfo("http", `${req.method} ${req.originalUrl} incoming`, {
    body: summarizeBody(req.body),
  });

  res.on("finish", () => {
    logInfo("http", `${req.method} ${req.originalUrl} completed`, {
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/spotify/lyrics", async (req: Request<unknown, unknown, SpotifyLyricsRequest>, res: Response) => {
  try {
    const trackId = req.body?.trackId;
    const spotifyToken = pickAuthTokenFromQuery({}, req);

    const upstreamLyrics = await fetchAndStoreSpicyLyricsUpstreamResult({
      source: "route",
      operation: "spotifyLyrics",
      trackId,
      market: req.body?.market,
      authorization: spotifyToken,
      spicyLyricsVersion: normalizeHeaderValue(req.headers["spicylyrics-version"]),
      upstreamRequestHeaders: req.headers,
    });

    if (upstreamLyrics && upstreamLyrics.httpStatus === 200) {
      const normalizedUpstreamLyrics = normalizeSpicyLyricsPayload(upstreamLyrics.data, trackId);
      logInfo("route", "POST /spotify/lyrics served by hosted SpicyLyrics upstream", {
        trackId,
        normalized: Boolean(normalizedUpstreamLyrics),
      });
      res.status(200).json(normalizedUpstreamLyrics ?? normalizeLyricsForClient(upstreamLyrics.data, trackId));
      return;
    }

    const localLyrics = await getLocalTtmlLyrics(trackId);
    if (localLyrics) {
      logInfo("route", "POST /spotify/lyrics served by local TTML", { trackId, type: localLyrics.Type });
      res.status(200).json(normalizeLyricsForClient(localLyrics, trackId));
      return;
    }

    const result = await askSpotifyForLyrics({
      trackId,
      market: req.body?.market || "from_token",
      authorization: spotifyToken,
    });

    logInfo("route", "POST /spotify/lyrics result", { trackId, status: result.httpStatus });

    res
      .status(result.httpStatus)
      .json(
        result.httpStatus === 200
          ? normalizeLyricsForClient(transformSpotifyToSpicyLyrics(result.data, trackId), trackId)
          : result.data
      );
  } catch (error) {
    logError("route", "POST /spotify/lyrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while requesting Spotify lyrics.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/apple/lyrics", async (req: Request<unknown, unknown, AppleLyricsRequest>, res: Response) => {
  try {
    const appleAuth = resolveAppleAuth({
      carrier: req,
      developerToken: req.body?.appleDeveloperToken,
      authorization: req.body?.authorization,
      userToken: req.body?.appleUserToken || req.body?.mediaUserToken,
    });

    const result = await askAppleForLyrics({
      songId: req.body?.songId,
      storefront: req.body?.storefront || "us",
      authorization: appleAuth.authorization,
      userToken: appleAuth.userToken || undefined,
    });

    const transformed =
      result.httpStatus === 200 ? transformAppleToSpicyLyrics(result.data, req.body?.songId) : null;
    const wordByWord = transformed ? isAppleWordByWord(result.data) : false;

    logInfo("route", "POST /apple/lyrics result", {
      songId: req.body?.songId,
      status: result.httpStatus,
      transformed: Boolean(transformed),
      transformedLines: transformed?.Content.length ?? 0,
      wordByWord,
    });

    res
      .status(result.httpStatus)
      .json(transformed ? normalizeLyricsForClient(transformed, req.body?.songId) : result.data);
  } catch (error) {
    logError("route", "POST /apple/lyrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while requesting Apple lyrics.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/query", async (req: Request<{}, unknown, { queries?: QueryInput[] }>, res: Response) => {
  try {
    const body = req.body as { queries?: QueryInput[] };
    const queries = Array.isArray(body?.queries) ? body.queries : [];

    logInfo("route", "POST /query processing batch", { queryCount: queries.length });

    const results: QueryResponseItem[] = await Promise.all(
      queries.map(async (query, index) => {
        const result = await handleQueryOperation(query, req);
        return {
          operation: query?.operation || "",
          operationId: String(index),
          result,
        };
      })
    );

    res.status(200).json({ queries: results });
  } catch (error) {
    logError("route", "POST /query failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      message: "Internal server error while processing query.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  logInfo("startup", `Spicy Lyrics Backend listening on http://localhost:${PORT}`, {
    backendLoggingEnabled: LOG_ENABLED,
  });
});
