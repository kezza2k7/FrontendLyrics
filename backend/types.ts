import type { IncomingHttpHeaders } from "node:http";

export type QueryVariables = {
  id?: string;
  trackId?: string;
  songId?: string;
  market?: string;
  storefront?: string;
  auth?: string;
  spotifyToken?: string;
  appleSongId?: string;
  appleStorefront?: string;
  appleDeveloperToken?: string;
  appleUserToken?: string;
  trackName?: string;
  trackArtists?: string[];
  trackDurationMs?: number;
};

export type QueryInput = {
  operation?: string;
  variables?: QueryVariables;
};

export type QueryResult = {
  data: unknown;
  httpStatus: number;
  format: "json" | "text";
};

export type QueryResponseItem = {
  operation: string;
  operationId: string;
  result: QueryResult;
};

export type SpicyLineContent = {
  Type: "Vocal";
  OppositeAligned: boolean;
  Text: string;
  StartTime: number;
  EndTime: number;
};

export type SpicyLineLyrics = {
  id: string;
  Type: "Line";
  StartTime: number;
  EndTime?: number;
  Content: SpicyLineContent[];
  source: "spt" | "aml";
  Provider: string;
  ProviderDisplayName: string;
  Language: string;
  IsRtlLanguage: boolean;
  IncludesRomanization: boolean;
  SongWriters: string[];
};

export type SpicySyllable = {
  Text: string;
  StartTime: number;
  EndTime: number;
  IsPartOfWord: boolean;
};

export type SpicySyllableContent = {
  Type: "Vocal";
  OppositeAligned: boolean;
  Lead: {
    Syllables: SpicySyllable[];
    StartTime: number;
    EndTime: number;
  };
};

export type SpicySyllableLyrics = {
  id: string;
  Type: "Syllable";
  StartTime: number;
  EndTime?: number;
  Content: SpicySyllableContent[];
  source: "aml";
  Provider: string;
  ProviderDisplayName: string;
  Language: string;
  IsRtlLanguage: boolean;
  IncludesRomanization: boolean;
  SongWriters: string[];
};

export type SpotifyTrackMeta = {
  id: string;
  name: string;
  artists: string[];
  durationMs: number;
};

export type SpicyLyricsUpstreamSnapshot = {
  requestedAt: string;
  source: "query" | "route";
  operation: string;
  trackId: string;
  market: string | null;
  status: number;
  ok: boolean;
  data: unknown;
};

export type AppleSongCandidate = {
  id: string;
  name: string;
  artistName: string;
  durationMs: number;
};

export type SpotifyLyricsRequest = {
  trackId?: string;
  market?: string;
};

export type AppleLyricsRequest = {
  songId?: string;
  storefront?: string;
  appleDeveloperToken?: string;
  appleUserToken?: string;
  authorization?: string;
  mediaUserToken?: string;
};

export type HeaderCarrier = {
  headers: IncomingHttpHeaders;
};

export type AppleAuth = {
  authorization: string;
  userToken: string;
};
