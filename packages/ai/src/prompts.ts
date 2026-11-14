/**
 * Loads versioned prompts from the repo's prompts/ folder (see prompts/README.md).
 * Files are read once and cached; a missing file is a startup error, not a silent fallback.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = process.env.DINE_PROMPTS_DIR || path.resolve(__dirname, "../../../prompts");

const cache = new Map<string, string>();

/** Text of prompts/<agent>/<version>/<part>.md, without the trailing newline. */
export function loadPrompt(agent: string, version: string, part: string): string {
  for (const seg of [agent, version, part]) {
    if (!/^[a-z0-9-]+$/i.test(seg)) throw new Error(`invalid prompt path segment: ${seg}`);
  }
  const file = path.join(PROMPTS_DIR, agent, version, `${part}.md`);
  let text = cache.get(file);
  if (text == null) {
    text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
    cache.set(file, text);
  }
  return text;
}
