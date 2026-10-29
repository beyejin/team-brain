import type { MeetingNote } from "./types.ts";

const STOP_BIGRAMS = new Set([
  "에서",
  "으로",
  "하는",
  "있는",
  "없다",
  "했습",
  "습니",
  "니다",
  "그리고",
  "우리",
  "지금",
  "이거",
  "그거",
  "했어",
  "했다",
]);

function hangulBigrams(text: string): string[] {
  const chunks = text.match(/[가-힣]{2,}/g) ?? [];
  const grams: string[] = [];
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length - 1; i += 1) {
      const gram = chunk.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(gram)) grams.push(gram);
    }
  }
  return grams;
}

function asciiWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
    (word) => !["the", "and", "for"].includes(word),
  );
}

export function retrieveNotes(question: string, notes: MeetingNote[], limit = 3): MeetingNote[] {
  const queryGrams = new Set(hangulBigrams(question));
  const queryWords = new Set(asciiWords(question));
  const date = question.match(/\d{4}-\d{2}-\d{2}/)?.[0];

  const ranked = notes
    .map((note) => {
      const haystack = `${note.title}\n${note.body}`;
      const grams = hangulBigrams(haystack);
      let score = 0;
      for (const gram of grams) {
        if (queryGrams.has(gram)) score += note.title.includes(gram) ? 2 : 1;
      }
      for (const word of asciiWords(haystack)) {
        if (queryWords.has(word)) score += 2;
      }
      if (date && note.date === date) score += 5;
      return { note, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.note.date.localeCompare(b.note.date));

  return ranked.slice(0, limit).map((item) => item.note);
}
