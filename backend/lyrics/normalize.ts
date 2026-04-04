import type {
  SpicyLineContent,
  SpicyLineLyrics,
  SpicySyllable,
  SpicySyllableContent,
  SpicySyllableLyrics,
} from "../types.js";
import { normalizeLineTiming, normalizeSyllableTiming } from "./timing.js";

export function normalizeSpicyLyricsPayload(
  raw: unknown,
  trackId?: string
): SpicyLineLyrics | SpicySyllableLyrics | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const payloadType = source.Type;

  if (payloadType === "Line") {
    const rawContent = Array.isArray(source.Content) ? source.Content : [];
    const content: SpicyLineContent[] = rawContent
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const typed = entry as Record<string, unknown>;
        const text = typeof typed.Text === "string" ? typed.Text.trim() : "";
        const start = Number(typed.StartTime ?? 0);
        const end = Number(typed.EndTime ?? 0);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;

        return {
          Type: "Vocal",
          OppositeAligned: Boolean(typed.OppositeAligned),
          Text: text,
          StartTime: start,
          EndTime: end,
        };
      })
      .filter((line): line is SpicyLineContent => Boolean(line));

    if (content.length === 0) return null;
    normalizeLineTiming(content);

    return {
      id: typeof source.id === "string" ? source.id : trackId ?? "",
      Type: "Line",
      StartTime: content[0]?.StartTime ?? 0,
      EndTime: content[content.length - 1]?.EndTime ?? 0,
      Content: content,
      source: source.source === "aml" || source.source === "spt" ? source.source : "spt",
      Provider: typeof source.Provider === "string" ? source.Provider : "SpicyLyrics",
      ProviderDisplayName:
        typeof source.ProviderDisplayName === "string" ? source.ProviderDisplayName : "SpicyLyrics",
      Language: typeof source.Language === "string" ? source.Language : "und",
      IsRtlLanguage: Boolean(source.IsRtlLanguage),
      IncludesRomanization: Boolean(source.IncludesRomanization),
      SongWriters: Array.isArray(source.SongWriters)
        ? source.SongWriters.filter((w): w is string => typeof w === "string")
        : [],
    };
  }

  if (payloadType === "Syllable") {
    const rawContent = Array.isArray(source.Content) ? source.Content : [];
    const content: SpicySyllableContent[] = rawContent
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const typed = entry as Record<string, unknown>;
        const lead = typed.Lead;
        if (!lead || typeof lead !== "object") return null;
        const leadObj = lead as Record<string, unknown>;
        const rawSyllables = Array.isArray(leadObj.Syllables) ? leadObj.Syllables : [];

        const syllables: SpicySyllable[] = rawSyllables
          .map((syllable) => {
            if (!syllable || typeof syllable !== "object") return null;
            const s = syllable as Record<string, unknown>;
            const text = typeof s.Text === "string" ? s.Text.trim() : "";
            const start = Number(s.StartTime ?? 0);
            const end = Number(s.EndTime ?? 0);
            if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;

            return {
              Text: text,
              StartTime: start,
              EndTime: end,
              IsPartOfWord: Boolean(s.IsPartOfWord),
            };
          })
          .filter((s): s is SpicySyllable => Boolean(s));

        if (syllables.length === 0) return null;

        return {
          Type: "Vocal",
          OppositeAligned: Boolean(typed.OppositeAligned),
          Lead: {
            Syllables: syllables,
            StartTime: Number(leadObj.StartTime ?? syllables[0]?.StartTime ?? 0),
            EndTime: Number(leadObj.EndTime ?? syllables[syllables.length - 1]?.EndTime ?? 0),
          },
        };
      })
      .filter((line): line is SpicySyllableContent => Boolean(line));

    if (content.length === 0) return null;
    normalizeSyllableTiming(content);

    return {
      id: typeof source.id === "string" ? source.id : trackId ?? "",
      Type: "Syllable",
      StartTime: content[0]?.Lead.StartTime ?? 0,
      EndTime: content[content.length - 1]?.Lead.EndTime ?? 0,
      Content: content,
      source: "aml",
      Provider: typeof source.Provider === "string" ? source.Provider : "SpicyLyrics",
      ProviderDisplayName:
        typeof source.ProviderDisplayName === "string" ? source.ProviderDisplayName : "SpicyLyrics",
      Language: typeof source.Language === "string" ? source.Language : "und",
      IsRtlLanguage: Boolean(source.IsRtlLanguage),
      IncludesRomanization: Boolean(source.IncludesRomanization),
      SongWriters: Array.isArray(source.SongWriters)
        ? source.SongWriters.filter((w): w is string => typeof w === "string")
        : [],
    };
  }

  return null;
}

export function normalizeLyricsForClient(raw: unknown, trackId?: string): unknown {
  return normalizeSpicyLyricsPayload(raw, trackId) ?? raw;
}
