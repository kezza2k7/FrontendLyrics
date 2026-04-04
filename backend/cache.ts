import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpicyLineLyrics, SpicySyllableLyrics } from "./types.js";
import { LYRICS_DIR } from "./config.js";
import { logInfo, logWarn } from "./logger.js";

export type CachedLyrics = {
  cachedAt: string;
  trackId: string;
  data: SpicyLineLyrics | SpicySyllableLyrics;
};

function cachePath(trackId: string): string {
  return path.join(LYRICS_DIR, "cache", `${trackId}.json`);
}

export async function getLyricsFromCache(
  trackId: string
): Promise<SpicyLineLyrics | SpicySyllableLyrics | null> {
  try {
    const raw = await readFile(cachePath(trackId), "utf8");
    const parsed = JSON.parse(raw) as CachedLyrics;
    logInfo("cache", "Cache hit", { trackId });
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeLyricsToCache(
  trackId: string,
  data: SpicyLineLyrics | SpicySyllableLyrics
): Promise<void> {
  try {
    await mkdir(path.join(LYRICS_DIR, "cache"), { recursive: true });
    const entry: CachedLyrics = {
      cachedAt: new Date().toISOString(),
      trackId,
      data,
    };
    await writeFile(cachePath(trackId), JSON.stringify(entry, null, 2), "utf8");
    logInfo("cache", "Wrote lyrics to cache", { trackId, type: data.Type });
  } catch (error) {
    logWarn("cache", "Failed to write lyrics cache", {
      trackId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
