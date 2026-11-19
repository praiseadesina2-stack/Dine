/**
 * "Did you mean…?" for names the ordering flow could not find exactly.
 *
 * Token-similarity scoring from the Backend Engineer's agent. It is ADVISORY ONLY: the
 * flow never presses a button because of it (prime-flow.ts matches exactly and fails
 * closed). It ranks the labels Prime showed so the bot can offer the student a choice.
 */

const STOP_WORDS = new Set(["the", "and", "with", "for", "pack", "menu", "select", "order", "choose"]);

function normaliseForMatch(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/₦\s*[\d,]+(?:\.\d{2})?/g, "") // prices like ₦2,500
    .replace(/[()[\]{}+\-*/\\,.:;!?_~"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normaliseForMatch(text).split(" ").filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/** 0 to 1: how much of `target` the `candidate` covers. Different numbers ("1 Sausage" vs "2 Sausages") score 0. */
export function similarity(candidate: string, target: string): number {
  const c = normaliseForMatch(candidate);
  const t = normaliseForMatch(target);
  if (!c || !t) return 0;
  if (c === t) return 1;

  const cNums: string[] = candidate.match(/\b\d+\b/g) ?? [];
  const tNums: string[] = target.match(/\b\d+\b/g) ?? [];
  if (cNums.length && tNums.length && !cNums.some((n) => tNums.includes(n))) return 0;

  if (c.includes(t) || t.includes(c)) return 0.9;
  const ct = tokens(candidate);
  const tt = tokens(target);
  if (!ct.length || !tt.length) return 0;
  const hit = tt.filter((w) => ct.some((x) => x === w || x.includes(w) || w.includes(x))).length;
  return hit / tt.length;
}

/** Up to `limit` of `candidates` most like `target`, best first, scoring at least `minScore`. */
export function suggestNames(target: string, candidates: string[], { minScore = 0.45, limit = 3 } = {}): string[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => c.trim() && !seen.has(c) && (seen.add(c), true))
    .map((c) => ({ c, s: similarity(c, target) }))
    .filter((x) => x.s >= minScore && x.s < 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}
