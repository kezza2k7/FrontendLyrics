import type { SpicyLineContent, SpicySyllableContent } from "../types.js";

export function roundTime(value: number): number {
  const step = 0.2;
  return Number((Math.round(value / step) * step).toFixed(3));
}

export function normalizeLineTiming(lines: SpicyLineContent[]): void {
  lines.sort((a, b) => a.StartTime - b.StartTime);

  const minDuration = 0.2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    line.StartTime = roundTime(line.StartTime);
    line.EndTime = roundTime(line.EndTime);

    if (line.EndTime <= line.StartTime) {
      line.EndTime = roundTime(line.StartTime + minDuration);
    }

    if (i < lines.length - 1) {
      const next = lines[i + 1];
      if (line.EndTime > next.StartTime) {
        line.EndTime = next.StartTime;
      }
      if (line.EndTime <= line.StartTime) {
        line.EndTime = roundTime(line.StartTime + minDuration);
      }
    }

    line.EndTime = roundTime(line.EndTime);
  }
}

export function normalizeSyllableTiming(lines: SpicySyllableContent[]): void {
  lines.sort((a, b) => a.Lead.StartTime - b.Lead.StartTime);

  const minDuration = 0.2;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const currentLine = lines[lineIndex];
    const syllables = currentLine.Lead.Syllables.sort((a, b) => a.StartTime - b.StartTime);

    for (let i = 0; i < syllables.length; i++) {
      const current = syllables[i];
      current.StartTime = roundTime(current.StartTime);
      current.EndTime = roundTime(current.EndTime);

      if (current.EndTime <= current.StartTime) {
        current.EndTime = roundTime(current.StartTime + minDuration);
      }
    }

    for (let i = 0; i < syllables.length - 1; i++) {
      const current = syllables[i];
      const next = syllables[i + 1];

      if (current.EndTime > next.StartTime) {
        current.EndTime = next.StartTime;
      }
      if (current.EndTime <= current.StartTime) {
        current.EndTime = roundTime(current.StartTime + minDuration);
      }

      current.EndTime = roundTime(current.EndTime);
    }

    if (syllables.length > 0) {
      const last = syllables[syllables.length - 1];
      if (last.EndTime <= last.StartTime) {
        last.EndTime = roundTime(last.StartTime + minDuration);
      }

      currentLine.Lead.StartTime = roundTime(syllables[0].StartTime);
      currentLine.Lead.EndTime = roundTime(last.EndTime);
    }
  }
}
