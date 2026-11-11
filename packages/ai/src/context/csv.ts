/**
 * Minimal RFC 4180 CSV reader for Google Sheets exports: quoted fields,
 * escaped quotes, embedded newlines, CRLF and a leading BOM.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Turns rows into records keyed by our names. Each wanted column is found by
 * the first header that starts with any of its aliases (after normalising),
 * so "Rating (1-5)" matches "rating" and minor header edits do not break it.
 */
export function readTable<K extends string>(
  text: string,
  columns: Record<K, string[]>,
): { records: (Record<K, string> & { _row: number })[]; missing: K[] } {
  const [header = [], ...body] = parseCsv(text);
  const normalised = header.map(normHeader);
  const index = {} as Record<K, number>;
  const missing: K[] = [];
  for (const key of Object.keys(columns) as K[]) {
    const aliases = columns[key].map(normHeader);
    const at = normalised.findIndex((h) => aliases.some((a) => h.startsWith(a)));
    if (at < 0) missing.push(key);
    index[key] = at;
  }
  const records = body.map((cells, i) => {
    const rec = { _row: i + 2 } as Record<K, string> & { _row: number }; // +2: 1-based, after header
    for (const key of Object.keys(columns) as K[]) {
      (rec as Record<K, string>)[key] = index[key] >= 0 ? (cells[index[key]] ?? "").trim() : "";
    }
    return rec;
  });
  return { records, missing };
}
